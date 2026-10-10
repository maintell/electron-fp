'use strict';
// ponytail: real-binary E2E for the CDP-over-WS bridge. Hand-rolled CDP client over a raw
// net socket (no playwright dep): HTTP discovery -> WS upgrade -> browser-level introspection
// -> Target attach -> Page/Runtime forwarding -> denial + no-token gates -> teardown.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('fs');
const { createCdpWs } = require('./runtime/cdp-ws');

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

const FIXTURE_FILE = 'F:\\Temp\\e2e-cdp.html';
const FIXTURE_URL = 'file:///F:/Temp/e2e-cdp.html';
const FIXTURE_FILE_2 = 'F:\\Temp\\e2e-cdp-pw.html';
const FIXTURE_URL_2 = 'file:///F:/Temp/e2e-cdp-pw.html';
const TITLE = 'CDP-BRIDGE-42';

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch (_) {}
    }
  } catch (_) {}
}

function httpGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// minimal masked-text WS client (same wire format as test-ws-api.js)
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
          st.closed = true;
          socket.destroy();
          return;
        }
        if (op === 0x9) continue;
        if (op !== 0x1) continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
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
  await until(
    () => st.all.some((m) => m.id === id && (m.result !== undefined || m.error !== undefined)),
    15000,
    method + ' reply'
  );
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

  const audits = [];
  let win = null;
  let srv = null;
  let st = null;
  try {
    fs.writeFileSync(FIXTURE_FILE, '<html><head><title>' + TITLE + '</title></head><body><div id="d">hi</div></body></html>');
    fs.writeFileSync(FIXTURE_FILE_2, '<html><head><title>' + TITLE + '</title></head><body><div id="d">pw</div></body></html>');

    win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { partition: 'persist:auto:cdp-ws', contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    const cdp = createCdpWs({
      resolve: (id) => (id === 'e2e-cdp' ? { webContents: win.webContents } : undefined),
      token: 'tk',
      port: 0,
      audit: (r) => audits.push(r),
    });
    srv = await cdp.start();

    // a. HTTP discovery
    let wsUrl = '';
    try {
      const res = await httpGet(srv.port, '/json/version?profile=e2e-cdp', { Authorization: 'Bearer tk' });
      assert(res.status === 200, 'status=' + res.status);
      const body = JSON.parse(res.body);
      assert(typeof body.webSocketDebuggerUrl === 'string' && body.webSocketDebuggerUrl.includes('/api/cdp/e2e-cdp'), 'url=' + body.webSocketDebuggerUrl);
      assert(/token=tk/.test(body.webSocketDebuggerUrl), 'token missing: ' + body.webSocketDebuggerUrl);
      assert(body['Protocol-Version'] === '1.3', 'protocol=' + body['Protocol-Version']);
      wsUrl = body.webSocketDebuggerUrl;
      ok('HTTP /json/version 200 + webSocketDebuggerUrl');
    } catch (e) {
      bad('HTTP /json/version 200 + webSocketDebuggerUrl', e);
    }

    // b. WS upgrade with ?token=tk
    try {
      const u = new URL(wsUrl);
      st = await wsConnect(Number(u.port), u.pathname + u.search);
      assert(st.status === 101, 'status=' + st.status);
      ok('WS upgrade accepted with ?token (101)');
    } catch (e) {
      bad('WS upgrade accepted with ?token (101)', e);
    }

    const need = () => {
      if (!st || !st.open) throw new Error('skipped: no ws client');
      return st;
    };

    // c. Browser.getVersion
    try {
      const r = await rpc(need(), 1, 'Browser.getVersion');
      assert(r.result && typeof r.result.product === 'string' && r.result.product.length > 0, 'reply=' + JSON.stringify(r));
      ok('Browser.getVersion product=' + r.result.product);
    } catch (e) {
      bad('Browser.getVersion product non-empty', e);
    }

    // d. Target.setDiscoverTargets -> targetCreated
    try {
      const c = need();
      const r = await rpc(c, 2, 'Target.setDiscoverTargets', { discover: true });
      assert(r.result !== undefined, 'reply=' + JSON.stringify(r));
      await until(() => c.all.some((m) => m.method === 'Target.targetCreated'), 5000, 'Target.targetCreated');
      ok('Target.setDiscoverTargets -> Target.targetCreated event');
    } catch (e) {
      bad('Target.setDiscoverTargets -> Target.targetCreated event', e);
    }

    // e. Target.getTargets (exactly one page target)
    let targetId = '';
    try {
      const r = await rpc(need(), 3, 'Target.getTargets');
      const infos = r.result && r.result.targetInfos;
      assert(Array.isArray(infos) && infos.length === 1, 'infos=' + JSON.stringify(infos));
      assert(infos[0].type === 'page', 'type=' + infos[0].type);
      targetId = infos[0].targetId;
      ok('Target.getTargets -> one page target (' + targetId + ')');
    } catch (e) {
      bad('Target.getTargets -> one page target', e);
    }

    // f. Target.attachToTarget -> sessionId
    let sessionId = '';
    try {
      const r = await rpc(need(), 4, 'Target.attachToTarget', { targetId, flatten: true });
      sessionId = r.result && r.result.sessionId;
      assert(sessionId === 'cdp-sess-1', 'sessionId=' + sessionId);
      ok('Target.attachToTarget -> ' + sessionId);
    } catch (e) {
      bad('Target.attachToTarget -> sessionId', e);
    }

    // g. Page.enable + Page.navigate -> Page.loadEventFired
    try {
      const c = need();
      const en = await rpc(c, 5, 'Page.enable', {}, sessionId);
      assert(en.result !== undefined && en.sessionId === sessionId, 'enable reply=' + JSON.stringify(en));
      const nav = await rpc(c, 6, 'Page.navigate', { url: FIXTURE_URL }, sessionId);
      assert(nav.result !== undefined && nav.sessionId === sessionId, 'navigate reply=' + JSON.stringify(nav));
      await until(() => c.all.some((m) => m.method === 'Page.loadEventFired'), 15000, 'Page.loadEventFired');
      ok('Page.enable + Page.navigate -> Page.loadEventFired');
    } catch (e) {
      bad('Page.enable + Page.navigate -> Page.loadEventFired', e);
    }

    // h. Runtime.evaluate document.title (isolated world, fresh after navigation)
    try {
      const r = await rpc(need(), 7, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
      const value = r.result && r.result.result && r.result.result.value;
      assert(value === TITLE, 'value=' + JSON.stringify(value) + ' reply=' + JSON.stringify(r));
      ok('Runtime.evaluate document.title = ' + value);
    } catch (e) {
      bad('Runtime.evaluate document.title', e);
    }

    // h2. Playwright-shaped connectOverCDP leg: setAutoAttach -> attachedToTarget -> flat-session
    // page call chain (crBrowser.ts discovery flow; Playwright never calls attachToTarget).
    try {
      const c = need();
      const sa = await rpc(c, 20, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      assert(sa.error === undefined && sa.result !== undefined, 'reply=' + JSON.stringify(sa));
      await until(() => c.all.some((m) => m.method === 'Target.attachedToTarget'), 5000, 'Target.attachedToTarget');
      const evs = c.all.filter((m) => m.method === 'Target.attachedToTarget');
      assert(evs.length === 1, 'attachedToTarget count=' + evs.length);
      const p = evs[0].params;
      assert(p && p.targetInfo && p.targetInfo.type === 'page', 'params=' + JSON.stringify(p));
      assert(p.waitingForDebugger === false, 'waitingForDebugger=' + p.waitingForDebugger);
      const pwSessionId = p.sessionId;
      assert(typeof pwSessionId === 'string' && pwSessionId.length > 0, 'sessionId=' + pwSessionId);
      const en = await rpc(c, 21, 'Page.enable', {}, pwSessionId);
      assert(en.result !== undefined && en.sessionId === pwSessionId, 'enable reply=' + JSON.stringify(en));
      const loadsBefore = c.all.filter((m) => m.method === 'Page.loadEventFired').length;
      const nav = await rpc(c, 22, 'Page.navigate', { url: FIXTURE_URL_2 }, pwSessionId);
      assert(nav.result !== undefined && nav.sessionId === pwSessionId, 'navigate reply=' + JSON.stringify(nav));
      await until(
        () => c.all.filter((m) => m.method === 'Page.loadEventFired').length > loadsBefore,
        15000,
        'Page.loadEventFired (playwright leg)'
      );
      const r = await rpc(c, 23, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true }, pwSessionId);
      const value = r.result && r.result.result && r.result.result.value;
      assert(value === TITLE, 'title=' + JSON.stringify(value) + ' reply=' + JSON.stringify(r));
      ok('Playwright-shaped setAutoAttach -> attachedToTarget -> page call chain (' + pwSessionId + ')');
    } catch (e) {
      bad('Playwright-shaped setAutoAttach -> attachedToTarget -> page call chain', e);
    }

    // i. denials: control method + no-token upgrade
    try {
      const r = await rpc(need(), 8, 'Target.createTarget', { url: 'about:blank' });
      assert(r.error && r.error.code === -32601, 'reply=' + JSON.stringify(r));
      ok('Target.createTarget denied (-32601)');
    } catch (e) {
      bad('Target.createTarget denied (-32601)', e);
    }
    try {
      const u = new URL(wsUrl);
      const bad2 = await wsConnect(Number(u.port), u.pathname); // no token
      assert(bad2.status === 401, 'status=' + bad2.status);
      ok('WS upgrade without token rejected (401)');
    } catch (e) {
      bad('WS upgrade without token rejected (401)', e);
    }

    // j. teardown
    try {
      if (st) st.close();
      await srv.close();
      // socket 'close' + audit land a tick after server shutdown; poll (fails if never emitted)
      await until(() => audits.some((a) => a.type === 'cdp-ws-close'), 3000, 'cdp-ws-close audit');
      assert(audits.some((a) => a.type === 'cdp-ws-open'), 'missing cdp-ws-open: ' + JSON.stringify(audits));
      ok('socket closed + server stopped + cdp-ws-open/close audited');
    } catch (e) {
      bad('clean teardown (close + audits)', e);
    }

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
      if (srv) await srv.close();
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
