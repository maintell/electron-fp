'use strict';
// ponytail: real-binary E2E — an EXTERNAL CDP client connects to the URL published for a
// launcher-started profile (via profile-manager.setEndpoint) and drives the real page.
const { app, BrowserWindow } = require('electron');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('fs');
const { createElectronLauncher } = require('./electron/launcher');
const { createProfileManager } = require('./runtime/profile-manager');
const { createProfileCdpServer } = require('./electron/cdp-server');

let pass = 0;
let fail = 0;

function ok(name) {
  pass++;
  console.log('PASS ' + name);
}
function bad(name, err) {
  fail++;
  console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : String(err)));
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE_FILE = 'F:\\Temp\\e2e-cdp-server.html';
const FIXTURE_URL = 'file:///F:/Temp/e2e-cdp-server.html';
const TITLE = 'CDP-SERVER-42';
const TOKEN = 'tk';

async function createWindow(partition) {
  // launcher.start loads about:blank + waits for the committed load itself
  return new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
}

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch (_) {}
    }
  } catch (_) {}
}

// minimal masked-text WS client (same wire pattern as probe-cdp-ws-client.js)
function wsConnect(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        'GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    const st = { buf: Buffer.alloc(0), open: false, status: null, raw: '', all: [], queue: [], waiters: [] };
    function onFrame(chunk) {
      st.buf = Buffer.concat([st.buf, chunk]);
      for (;;) {
        if (st.buf.length < 2) return;
        const op = st.buf[0] & 0x0f;
        let len = st.buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (st.buf.length < 4) return;
          len = st.buf.readUInt16BE(2);
          off = 4;
        }
        if (st.buf.length < off + len) return;
        const payload = st.buf.subarray(off, off + len).toString('utf8');
        st.buf = st.buf.subarray(off + len);
        if (op === 0x8) {
          socket.destroy();
          return;
        }
        if (op !== 0x1) continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch (_) {
          obj = { _raw: payload };
        }
        st.all.push(obj);
        const w = st.waiters.shift();
        if (w) w(obj);
        else st.queue.push(obj);
      }
    }
    socket.on('data', (chunk) => {
      if (!st.open) {
        st.raw += chunk.toString('latin1');
        const i = st.raw.indexOf('\r\n\r\n');
        if (i === -1) return;
        st.status = Number(st.raw.slice(0, st.raw.indexOf('\r\n')).split(' ')[1]);
        st.open = st.status === 101;
        const rest = Buffer.from(st.raw.slice(i + 4), 'latin1');
        st.raw = '';
        if (!st.open) {
          socket.destroy();
          resolve(st);
          return;
        }
        if (rest.length) onFrame(rest);
        resolve(st);
        return;
      }
      onFrame(chunk);
    });
    st.send = (obj) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      const mask = crypto.randomBytes(4);
      let h;
      if (body.length < 126) h = Buffer.from([0x81, 0x80 | body.length]);
      else {
        h = Buffer.alloc(4);
        h[0] = 0x81;
        h[1] = 0x80 | 126;
        h.writeUInt16BE(body.length, 2);
      }
      const masked = Buffer.from(body);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([h, mask, masked]));
    };
    st.close = () => socket.destroy();
    socket.on('error', () => {});
    socket.on('close', () => {
      while (st.waiters.length) st.waiters.shift()({ _closed: true });
    });
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}

async function until(cond, ms, what) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

async function rpc(st, id, method, params, sessionId) {
  const msg = { id, method };
  if (params !== undefined) msg.params = params;
  if (sessionId) msg.sessionId = sessionId;
  st.send(msg);
  await until(() => st.all.some((m) => m.id === id && (m.result !== undefined || m.error !== undefined)), 15000, method + ' reply');
  return st.all.find((m) => m.id === id);
}

async function main() {
  await app.whenReady();

  const hardKill = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 150s budget exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 150000);
  if (hardKill.unref) hardKill.unref();

  let launcher = null;
  let pm = null;
  let cdpSrv = null;
  let st = null;
  let profileId = null;
  try {
    fs.writeFileSync(FIXTURE_FILE, '<html><head><title>' + TITLE + '</title></head><body><div id="d">hi</div></body></html>');

    launcher = createElectronLauncher({ createWindow });
    pm = createProfileManager({ launcher });
    const p = pm.create({ name: 'cdp-host' });
    profileId = p.id;
    await pm.start(profileId); // launcher.start -> hidden window, inProcess endpoint
    ok('profile started via launcher (inProcess endpoint)');

    cdpSrv = createProfileCdpServer({
      launcher,
      token: TOKEN,
      onUrl: (id, url) => pm.setEndpoint(id, { cdpUrl: url }),
    });
    const info = await cdpSrv.start();
    cdpSrv.publish(profileId); // explicit (start() already auto-published)

    const ep = pm.status(profileId).endpoint;
    assert(ep && ep.inProcess === true && typeof ep.cdpUrl === 'string', 'endpoint=' + JSON.stringify(ep));
    assert(ep.cdpUrl === cdpSrv.urlFor(profileId), 'published vs urlFor mismatch');
    console.log('INFO publishedCdpUrl=' + ep.cdpUrl);
    ok('published cdpUrl equals urlFor(profile) [' + info.baseUrl + ']');

    // b. external client connects to the PUBLISHED url (not a hand-built string)
    const u = new URL(ep.cdpUrl);
    st = await wsConnect(Number(u.port), u.pathname + u.search);
    assert(st.status === 101, 'ws status=' + st.status);
    ok('external CDP client connected to published URL (101)');

    const gv = await rpc(st, 1, 'Browser.getVersion');
    assert(gv.result && typeof gv.result.product === 'string' && gv.result.product.length > 0, 'getVersion=' + JSON.stringify(gv));
    ok('Browser.getVersion product=' + gv.result.product);

    const gt = await rpc(st, 2, 'Target.getTargets');
    const infos = gt.result && gt.result.targetInfos;
    assert(Array.isArray(infos) && infos.length === 1 && infos[0].type === 'page', 'targets=' + JSON.stringify(infos));
    const targetId = infos[0].targetId;
    ok('Target.getTargets -> one page target (' + targetId + ')');

    const at = await rpc(st, 3, 'Target.attachToTarget', { targetId, flatten: true });
    const sessionId = at.result && at.result.sessionId;
    assert(sessionId === 'cdp-sess-1', 'sessionId=' + sessionId);
    ok('Target.attachToTarget -> ' + sessionId);

    const en = await rpc(st, 4, 'Page.enable', {}, sessionId);
    assert(en.result !== undefined && en.sessionId === sessionId, 'enable=' + JSON.stringify(en));
    await rpc(st, 5, 'Page.navigate', { url: FIXTURE_URL }, sessionId);
    await until(() => st.all.some((m) => m.method === 'Page.loadEventFired'), 15000, 'Page.loadEventFired');
    ok('Page.enable + Page.navigate -> Page.loadEventFired');

    const ev = await rpc(st, 6, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
    const title = ev.result && ev.result.result && ev.result.result.value;
    assert(title === TITLE, 'title=' + JSON.stringify(title) + ' reply=' + JSON.stringify(ev));
    ok('Runtime.evaluate document.title = ' + title);

    // c. negative: bad token rejected
    const badUrl = ep.cdpUrl.replace('token=' + TOKEN, 'token=nope');
    const bu = new URL(badUrl);
    const bad2 = await wsConnect(Number(bu.port), bu.pathname + bu.search);
    assert(bad2.status === 401, 'bad status=' + bad2.status);
    ok('bad token rejected (401)');

    // d. teardown
    if (st) st.close();
    await sleep(200);
    await cdpSrv.stop();
    await cdpSrv.stop(); // idempotent
    await pm.stop(profileId);
    destroyAll();
    assert(BrowserWindow.getAllWindows().length === 0, 'windows left: ' + BrowserWindow.getAllWindows().length);
    assert(launcher.list().length === 0, 'launcher handles left: ' + JSON.stringify(launcher.list()));
    ok('teardown clean (cdp stopped, profile stopped, 0 windows, 0 launcher handles)');

    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await sleep(300);
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
  } finally {
    try {
      clearTimeout(hardKill);
    } catch (_) {}
    try {
      if (st) st.close();
    } catch (_) {}
    try {
      if (cdpSrv) await cdpSrv.stop();
    } catch (_) {}
    try {
      if (pm && profileId) await pm.stop(profileId);
    } catch (_) {}
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try {
      app.exit(process.exitCode);
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000);
  }
}

main();
