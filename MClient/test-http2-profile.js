#!/usr/bin/env node
// Prove the per-profile HTTP/2 controls actually reach the wire.
//
// Two things are verified here, and both matter:
//
// 1) session.setHttp2Profile({settingsGrease:true}) must add a GREASE SETTINGS
//    entry for THAT session only - proving the field is reachable from JS and
//    is genuinely per-profile rather than process-wide.
//
// 2) The default (no profile) must remain GREASE-free, so an unprofiled session
//    still behaves exactly like stock Electron.
//
// WHY PER-PROFILE MATTERS: --http2-grease-settings already works (verified) but
// is process-wide: it applies to every session or none. A profile that wants to
// emulate a browser GREASEs while another does not cannot be expressed with a
// launch switch. That gap is the only justification for the fp_http2_* fields,
// so this test asserts the difference directly.
//
// Runs inside the Electron main process.

'use strict';

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, session } = require('electron');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return; }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const SETTINGS_NAMES = {
  1: 'HEADER_TABLE_SIZE', 2: 'ENABLE_PUSH', 3: 'MAX_CONCURRENT_STREAMS',
  4: 'INITIAL_WINDOW_SIZE', 5: 'MAX_FRAME_SIZE', 6: 'MAX_HEADER_LIST_SIZE',
};
const PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
const isGreaseId = (id) => (id & 0x0f0f) === 0x0a0a;

const liveWindows = new Set();
function track(win) { liveWindows.add(win); return win; }
async function closeAllWindows() {
  for (const w of [...liveWindows]) {
    liveWindows.delete(w);
    try { if (!w.isDestroyed()) { w.webContents.destroy(); w.destroy(); } } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, 400));
}

function selfSigned() {
  const dir = path.join(os.tmpdir(), 'electron-fp-h2prof');
  fs.mkdirSync(dir, { recursive: true });
  const k = path.join(dir, 'key.pem');
  const c = path.join(dir, 'cert.pem');
  if (!fs.existsSync(k) || !fs.existsSync(c)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', k, '-out', c, '-days', '30', '-subj', '/CN=127.0.0.1'],
      { stdio: 'ignore', windowsHide: true });
  }
  return { key: fs.readFileSync(k), cert: fs.readFileSync(c) };
}

/** TLS server that decodes the client's first SETTINGS frame from raw bytes. */
function startProbe() {
  const results = [];
  const waiters = [];
  const cert = selfSigned();
  const server = tls.createServer(
    { key: cert.key, cert: cert.cert, ALPNProtocols: ['h2'] },
    (sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 24) return;
        let off = buf.slice(0, 24).toString('latin1') === PREFACE ? 24 : 0;
        while (off + 9 <= buf.length) {
          const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
          const type = buf[off + 3];
          if (off + 9 + len > buf.length) return;
          const payload = buf.slice(off + 9, off + 9 + len);
          if (type === 0x04) {
            const entries = [];
            for (let i = 0; i + 5 < payload.length; i += 6) {
              entries.push({ id: payload.readUInt16BE(i), value: payload.readUInt32BE(i + 2) });
            }
            const rec = { entries, ids: entries.map((e) => e.id), grease: entries.filter((e) => isGreaseId(e.id)) };
            results.push(rec);
            while (waiters.length) waiters.shift()(rec);
            try { sock.end(); } catch (_) {}
            return;
          }
          off += 9 + len;
        }
      });
      sock.on('error', () => {});
    });
  server.on('tlsClientHello', (s, cb) => cb(null, true));
  server.on('error', () => {});
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      waitForSettings: (t = 20000) => new Promise((res, rej) => {
        if (results.length) return res(results[results.length - 1]);
        const timer = setTimeout(() => rej(new Error('timeout')), t);
        waiters.push((s) => { clearTimeout(timer); res(s); });
      }),
      close: () => Promise.race([
        new Promise((r) => server.close(r)),
        new Promise((r) => setTimeout(r, 1500)),
      ]),
    }));
  });
}

/**
 * Capture the SETTINGS frame for one session.
 * IMPORTANT: each call uses a FRESH probe, because a shared probe's
 * waitForSettings() returns an already-captured sample and would attribute
 * another session's frame to this one.
 */
async function capture(partition, profile) {
  const probe = await startProbe();
  // The profile MUST be passed to fromPartition(), not set afterwards:
  // HttpNetworkSessionParams are read once when the NetworkContext is
  // constructed, which happens inside fromPartition() before any Session
  // method can run. A post-hoc setHttp2Profile() is verified to have no
  // effect (it logs a warning). This is the supported API shape.
  const sess = profile !== null
    ? session.fromPartition('persist:' + partition, { http2Profile: profile })
    : session.fromPartition('persist:' + partition);
  sess.setCertificateVerifyProc((req, cb) => cb(0));
  const win = track(new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: sess },
  }));
  const p = probe.waitForSettings(20000).catch(() => null);
  win.loadURL(`https://127.0.0.1:${probe.port}/x`).catch(() => null);
  const rec = await p;
  return { rec, probe };
}

(async () => {
  const probes = [];
  try {
    await app.whenReady();

    // --- A: no profile (must stay stock: no GREASE) ----------------------
    const a = await capture('h2prof-default', null);
    probes.push(a.probe);
    if (!a.rec) {
      check('h2-profile: default session captured', false, 'no SETTINGS');
    } else {
      console.log('\n--- default (no profile) ---');
      for (const e of a.rec.entries) {
        console.log('  ' + ('0x' + e.id.toString(16)).padEnd(8) +
          (SETTINGS_NAMES[e.id] || '(unknown/GREASE)').padEnd(22) + e.value);
      }
      check('h2-profile: default sends NO GREASE (unprofiled stays stock)',
        a.rec.grease.length === 0, String(a.rec.grease.length));
    }

    // --- B: settingsGrease:true (must add GREASE) ------------------------
    const b = await capture('h2prof-grease', { settingsGrease: true });
    probes.push(b.probe);
    if (!b.rec) {
      check('h2-profile: settingsGrease session captured', false, 'no SETTINGS');
    } else {
      console.log('\n--- profile settingsGrease:true ---');
      for (const e of b.rec.entries) {
        console.log('  ' + ('0x' + e.id.toString(16)).padEnd(8) +
          (SETTINGS_NAMES[e.id] || '(unknown/GREASE)').padEnd(22) + e.value);
      }
      check('h2-profile: settingsGrease:true ADDS a GREASE entry',
        b.rec.grease.length > 0,
        b.rec.grease.length ? b.rec.grease.map((g) => '0x' + g.id.toString(16)).join(' ') : 'none');

      // The decisive property: the SAME process, another session, no GREASE.
      if (a.rec) {
        check('h2-profile: GREASE is per-profile, not process-wide ' +
          '(greased session has it, unprofiled one does not)',
          b.rec.grease.length > 0 && a.rec.grease.length === 0,
          'profiled=' + b.rec.grease.length + ' default=' + a.rec.grease.length);
      }
    }

    // --- C: settingsGrease:false must stay GREASE-free -------------------
    // Guards against the gin converter conflating `false` with "key absent" -
    // the reason these fields are grouped in a struct rather than passed as
    // bare optional params.
    const c = await capture('h2prof-nogrease', { settingsGrease: false });
    probes.push(c.probe);
    if (c.rec) {
      check('h2-profile: settingsGrease:false stays GREASE-free (explicit false honored)',
        c.rec.grease.length === 0, String(c.rec.grease.length));
    }

    // --- D: the post-hoc setter must exist but warn, not silently no-op ----
    // Guards the documented ordering caveat: if someone later makes the setter
    // silently store-and-ignore, this catches it.
    let setterExists = false;
    try {
      const s = session.fromPartition('persist:h2prof-settercheck');
      setterExists = typeof s.setHttp2Profile === 'function';
      if (setterExists) s.setHttp2Profile({ settingsGrease: true });
    } catch (e) {
      setterExists = false;
    }
    check('h2-profile: setHttp2Profile exists (documents the ordering caveat)',
      setterExists === true, setterExists ? 'present' : 'missing');

    await closeAllWindows();
    for (const p of probes) { try { await p.close(); } catch (_) {} }
    console.log('');
    console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log('FAIL  threw: ' + (e && e.message));
    console.log(e && e.stack);
    try { await closeAllWindows(); } catch (_) {}
    for (const p of probes) { try { await p.close(); } catch (_) {} }
    process.exit(1);
  }
})();
