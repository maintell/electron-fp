'use strict';
// Positive coexistence probe (doc 17 §B.9): with the proxy-only single-attach broker, built-in
// automation and external CDP clients share ONE webContents.debugger attach. This replaces the old
// R10 conflict detector — the assertions below are the acceptance contract for Part B Phase 1.
//
// Run (built binary; stash resources/app first per AGENTS.md §2):
//   $env:RTK_DISABLED='1'; & "F:\code\src\out\Default\electron.exe" automation\probe-attach-coexist.js
const { app, BrowserWindow } = require('electron');
const net = require('node:net');
const crypto = require('node:crypto');
const { createAttachBroker } = require('./runtime/attach-broker');
const { createBrowserSession } = require('./runtime/browser-session');
const { createElectronSession } = require('./electron/glue');
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

const PROFILE = 'attach-coexist';
const TOKEN = 'tk';

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch (_) {}
    }
  } catch (_) {}
}

async function until(cond, ms, what) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

// minimal masked-text WS client with frame parsing (same wire pattern as probe-cdp-server.js)
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

async function rpc(st, id, method, params, sessionId) {
  const msg = { id, method };
  if (params !== undefined) msg.params = params;
  if (sessionId) msg.sessionId = sessionId;
  st.send(msg);
  await until(() => st.all.some((m) => m.id === id && (m.result !== undefined || m.error !== undefined)), 15000, method + ' reply');
  return st.all.find((m) => m.id === id);
}

function cdpValue(reply) {
  const r = reply && reply.result && reply.result.result;
  return r && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : undefined;
}

async function main() {
  await app.whenReady();
  app.on('window-all-closed', () => {});

  const hardKill = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 90s budget exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 90000);
  if (hardKill.unref) hardKill.unref();

  const audits = [];
  const audit = (r) => audits.push(r);
  let win = null;
  let es = null;
  let es2 = null;
  let es3 = null;
  let cdpSrv = null;
  let extA = null;
  let extB = null;
  try {
    win = new BrowserWindow({
      width: 400,
      height: 300,
      show: false,
      webPreferences: { partition: 'persist:auto-attach-coexist', contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    const wc = win.webContents;
    const dbg = wc.debugger;
    // Core evidence: count every real webContents.debugger.attach for the whole run.
    const realAttach = dbg.attach.bind(dbg);
    let attachCount = 0;
    dbg.attach = (...a) => {
      attachCount++;
      return realAttach(...a);
    };

    const broker = createAttachBroker({ createSession: createBrowserSession, audit });

    // ① built-in automation attaches first, through the broker
    es = createElectronSession({ webContents: wc, profileId: PROFILE, audit, broker });
    await es.start();
    assert(es.session.getState() === 'attached', 'built-in state=' + es.session.getState());
    ok('① built-in attached first (state=attached, isAttached=' + dbg.isAttached() + ')');

    // cdp-server shares the SAME broker
    const launcher = {
      acquire: (id) => (id === PROFILE ? { webContents: wc } : undefined),
      list: () => [PROFILE],
    };
    cdpSrv = createProfileCdpServer({ launcher, token: TOKEN, audit, broker });
    await cdpSrv.start();
    const url = cdpSrv.urlFor(PROFILE);
    const u = new URL(url);

    // ② external WS client joins the existing attach -> 101 (NOT 500)
    extA = await wsConnect(Number(u.port), u.pathname + u.search);
    assert(extA.status === 101, 'external upgrade status=' + extA.status + ' (expected 101)');
    ok('② external WS upgrade joined shared attach -> 101 (not 500)');

    // ③ total attach count === 1 for the whole run so far
    assert(attachCount === 1, 'attach count=' + attachCount + ' (expected 1)');
    ok('③ total webContents.debugger.attach count === 1');

    // ④ concurrent independent replies: built-in 6*7 -> 42, external 2+2 -> 4
    const gt = await rpc(extA, 1, 'Target.getTargets');
    const targetId = gt.result.targetInfos[0].targetId;
    const at = await rpc(extA, 2, 'Target.attachToTarget', { targetId, flatten: true });
    const sidA = at.result.sessionId;
    assert(typeof sidA === 'string' && sidA.length > 0, 'sidA=' + sidA);
    const builtinP = es.session.sendCommand('Runtime.evaluate', { expression: '6*7', returnByValue: true });
    const extP = rpc(extA, 3, 'Runtime.evaluate', { expression: '2+2', returnByValue: true }, sidA);
    const [bRes, eRes] = await Promise.all([builtinP, extP]);
    const bVal = bRes && bRes.result && bRes.result.value;
    const eVal = cdpValue(eRes);
    assert(bVal === 42, 'built-in eval=' + JSON.stringify(bVal));
    assert(eVal === 4, 'external eval=' + JSON.stringify(eVal));
    ok('④ concurrent replies independent (built-in 6*7=' + bVal + ', external 2+2=' + eVal + ')');

    // ⑤ two external clients at once -> both 101, distinct synthetic sessionIds, independent replies
    extB = await wsConnect(Number(u.port), u.pathname + u.search);
    assert(extB.status === 101, 'second external upgrade status=' + extB.status);
    const gtB = await rpc(extB, 4, 'Target.getTargets');
    const atB = await rpc(extB, 5, 'Target.attachToTarget', { targetId: gtB.result.targetInfos[0].targetId, flatten: true });
    const sidB = atB.result.sessionId;
    assert(typeof sidB === 'string' && sidB.length > 0, 'sidB=' + sidB);
    assert(sidA !== sidB, 'sessionIds must differ: ' + sidA + ' vs ' + sidB);
    const [ra, rb] = await Promise.all([
      rpc(extA, 6, 'Runtime.evaluate', { expression: '"A"', returnByValue: true }, sidA),
      rpc(extB, 7, 'Runtime.evaluate', { expression: '"B"', returnByValue: true }, sidB),
    ]);
    assert(ra.sessionId === sidA && cdpValue(ra) === 'A', 'A reply=' + JSON.stringify(ra));
    assert(rb.sessionId === sidB && cdpValue(rb) === 'B', 'B reply=' + JSON.stringify(rb));
    ok('⑤ two external clients both 101, distinct sessions (' + sidA + '/' + sidB + '), replies independent');

    // ⑥ denied for external too: the shared session's FP-scrub gate rejects the call (audit cdp-deny)
    const denied = await rpc(extA, 8, 'Runtime.evaluate', { expression: "'FP_CONFIG_DATA'.length", returnByValue: true }, sidA);
    assert(denied.error, 'expected error reply, got ' + JSON.stringify(denied));
    await until(() => audits.some((a) => a.type === 'cdp-deny'), 3000, 'cdp-deny audit');
    ok('⑥ external denied by the shared gate (error + cdp-deny audit)');

    // ⑦ close external clients -> built-in stays attached and can still evaluate (ref-count not over-killed)
    extA.close();
    extB.close();
    extA = null;
    extB = null;
    await until(() => audits.filter((a) => a.type === 'cdp-ws-close').length >= 2, 5000, 'cdp-ws-close x2');
    await sleep(100);
    assert(dbg.isAttached() === true, 'debugger detached after external close');
    const still = await es.session.sendCommand('Runtime.evaluate', { expression: '40+2', returnByValue: true });
    assert(still && still.result && still.result.value === 42, 'built-in eval after close=' + JSON.stringify(still));
    ok('⑦ external close did not detach built-in (still attached, 40+2=42)');

    // ⑧ all consumers released -> isAttached()===false; re-acquire re-attaches exactly once, no error
    await es.stop();
    es = null;
    await until(() => dbg.isAttached() === false, 5000, 'debugger detach after all released');
    ok('⑧a all released -> isAttached()===false');
    const beforeRe = attachCount;
    es2 = createElectronSession({ webContents: wc, profileId: PROFILE, audit, broker });
    await es2.start();
    assert(dbg.isAttached() === true, 're-attach did not attach');
    assert(attachCount === beforeRe + 1, 're-attach count=' + (attachCount - beforeRe) + ' (expected 1)');
    ok('⑧b re-acquire re-attached cleanly (attach count ' + beforeRe + '->' + attachCount + ', no "already attached")');

    // ⑨ unexpected dbg.detach() (target/RFH-style) -> broker invalidates -> acquire re-attaches cleanly
    dbg.detach();
    await until(() => dbg.isAttached() === false, 3000, 'forced detach');
    const beforeRe2 = attachCount;
    es3 = createElectronSession({ webContents: wc, profileId: PROFILE, audit, broker });
    await es3.start();
    assert(dbg.isAttached() === true, 're-attach after forced detach failed');
    assert(attachCount === beforeRe2 + 1, 'forced re-attach count=' + (attachCount - beforeRe2) + ' (expected 1)');
    ok('⑨ after unexpected detach, acquire re-attached cleanly (count ' + beforeRe2 + '->' + attachCount + ')');

    // ⑩ audit: cdp-ws-open + cdp-ws-share present; no cdp-ws-deny reason:'attach'
    assert(audits.some((a) => a.type === 'cdp-ws-open'), 'missing cdp-ws-open: ' + JSON.stringify(audits.map((a) => a.type)));
    assert(audits.some((a) => a.type === 'cdp-ws-share'), 'missing cdp-ws-share: ' + JSON.stringify(audits.map((a) => a.type)));
    assert(!audits.some((a) => a.type === 'cdp-ws-deny' && a.reason === 'attach'), 'unexpected attach deny: ' + JSON.stringify(audits));
    ok('⑩ audit has cdp-ws-open + cdp-ws-share, no cdp-ws-deny reason:attach');

    console.log('INFO attachCount(final)=' + attachCount);
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
    for (const st of [extA, extB]) {
      try {
        if (st) st.close();
      } catch (_) {}
    }
    for (const s of [es, es2, es3]) {
      try {
        if (s) await s.stop();
      } catch (_) {}
    }
    try {
      if (cdpSrv) await cdpSrv.stop();
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
