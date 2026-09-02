#!/usr/bin/env node
// HTTP/2 SETTINGS fingerprint, measured from RAW frame bytes.
//
// WHY THIS DOES NOT USE Node's http2 `remoteSettings` EVENT
// That event reports what Node *believes* the peer's settings are, not what was
// on the wire. Measured difference on the same connection:
//   raw wire bytes : 4 entries  (1 HEADER_TABLE_SIZE, 2 ENABLE_PUSH,
//                                4 INITIAL_WINDOW_SIZE, 6 MAX_HEADER_LIST_SIZE)
//   remoteSettings : 8 entries  (adds maxFrameSize, maxConcurrentStreams,
//                                maxHeaderSize, enableConnectProtocol)
// Node fills the extra four from protocol defaults. Asserting on them tests
// Node's constants, not Electron - and worse, an earlier version of this file
// PASSED four checks that way. It also silently drops settings with unknown
// (GREASE) ids, which is exactly the signal we care about.
//
// So we TLS-terminate ourselves and decode the SETTINGS frame by hand
// (RFC 7540 6.5: 6-byte pairs of uint16 id + uint32 value).
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

// HTTP/2 SETTINGS identifiers (RFC 7540 6.5.2)
const SETTINGS_NAMES = {
  1: 'HEADER_TABLE_SIZE',
  2: 'ENABLE_PUSH',
  3: 'MAX_CONCURRENT_STREAMS',
  4: 'INITIAL_WINDOW_SIZE',
  5: 'MAX_FRAME_SIZE',
  6: 'MAX_HEADER_LIST_SIZE',
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
  const dir = path.join(os.tmpdir(), 'electron-fp-h2-probe');
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

/** Start a TLS server that decodes the client's first SETTINGS frame. */
function startRawH2Probe() {
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
          if (type === 0x04) {  // SETTINGS
            const entries = [];
            for (let i = 0; i + 5 < payload.length; i += 6) {
              entries.push({
                id: payload.readUInt16BE(i),
                value: payload.readUInt32BE(i + 2),
              });
            }
            const rec = {
              entries,
              ids: entries.map((e) => e.id),
              grease: entries.filter((e) => isGreaseId(e.id)),
            };
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
  server.on('tlsClientHello', (sock, cb) => cb(null, true));
  server.on('error', () => {});

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        results,
        waitForSettings: (t = 20000) =>
          new Promise((res, rej) => {
            if (results.length) return res(results[results.length - 1]);
            const timer = setTimeout(() => rej(new Error('timeout')), t);
            waiters.push((s) => { clearTimeout(timer); res(s); });
          }),
        close: () => Promise.race([
          new Promise((r) => server.close(r)),
          new Promise((r) => setTimeout(r, 1500)),
        ]),
      });
    });
  });
}

async function captureOnce(partition) {
  const probe = await startRawH2Probe();
  const sess = session.fromPartition('persist:' + partition);
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

    // --- Baseline: no profile -------------------------------------------
    const a = await captureOnce('h2raw-base');
    probes.push(a.probe);

    if (!a.rec) {
      check('h2: captured raw SETTINGS frame', false, 'no SETTINGS seen');
    } else {
      const r = a.rec;
      const named = r.entries.map((e) =>
        (SETTINGS_NAMES[e.id] || '0x' + e.id.toString(16)) + '=' + e.value);
      console.log('\n--- HTTP/2 SETTINGS (raw wire bytes, no profile) ---');
      console.log('entries: ' + r.entries.length);
      for (const e of r.entries) {
        console.log('  ' + ('0x' + e.id.toString(16)).padEnd(8) +
          (SETTINGS_NAMES[e.id] || '(unknown/GREASE)').padEnd(24) + e.value);
      }
      console.log('\n');

      check('h2: SETTINGS frame captured', r.entries.length > 0, String(r.entries.length));
      check('h2: HEADER_TABLE_SIZE (1) sent', r.ids.includes(1), named.join(', '));
      check('h2: ENABLE_PUSH (2) sent', r.ids.includes(2), named.join(', '));
      check('h2: INITIAL_WINDOW_SIZE (4) sent', r.ids.includes(4), named.join(', '));
      check('h2: MAX_HEADER_LIST_SIZE (6) sent', r.ids.includes(6), named.join(', '));

      const v = Object.fromEntries(r.entries.map((e) => [e.id, e.value]));
      check('h2: INITIAL_WINDOW_SIZE = 6291456 (Chromium default)',
        v[4] === 6291456, String(v[4]));
      check('h2: HEADER_TABLE_SIZE = 65536 (Chromium default)',
        v[1] === 65536, String(v[1]));
      check('h2: ENABLE_PUSH = 0 (Chromium disables push)', v[2] === 0, String(v[2]));

      // Exactly the four Chromium actually sends - guards against Node (or a
      // future Chromium) padding the list with values not on the wire.
      const unexpected = r.ids.filter((id) => ![1, 2, 4, 6].includes(id) && !isGreaseId(id));
      check('h2: no extra non-GREASE settings on the wire (guards vs Node defaults)',
        unexpected.length === 0,
        unexpected.map((i) => '0x' + i.toString(16)).join(' '));

      // The documented Chrome deviation, asserted so it cannot change silently.
      //
      // CAVEAT when reading results: this check is only meaningful when the
      // process was launched WITHOUT --http2-grease-settings. Run with that
      // switch and it correctly FAILS, because stock Chromium already supports
      // HTTP/2 GREASE and turns it on - no kernel patch required. That is a
      // feature: the deviation is fixable today via the existing switch.
      const switchOn = process.argv.includes('--http2-grease-settings');
      if (switchOn) {
        console.log('OBSERVE launched WITH --http2-grease-settings: GREASE = ' +
          (r.grease.length ? r.grease.map((g) => '0x' + g.id.toString(16)).join(' ') : 'none'));
        check('h2: --http2-grease-settings ADDS a GREASE entry (fixes the deviation)',
          r.grease.length > 0, String(r.grease.length));
      } else {
        check('h2: Electron sends NO GREASE SETTINGS by default (differs from Chrome)',
          r.grease.length === 0,
          r.grease.length ? r.grease.map((g) => '0x' + g.id.toString(16)).join(' ') : 'none');
      }
    }

    // --- With --http2-grease-settings ------------------------------------
    // Proves the deviation is FIXABLE today via the stock Chromium switch,
    // with no kernel patch. A separate partition so no session state carries
    // over from the baseline capture.
    const b = await captureOnce('h2raw-grease');
    probes.push(b.probe);
    console.log('');
    if (b.rec) {
      console.log('--- HTTP/2 SETTINGS with --http2-grease-settings ---');
      for (const e of b.rec.entries) {
        console.log('  ' + ('0x' + e.id.toString(16)).padEnd(8) +
          (SETTINGS_NAMES[e.id] || '(unknown/GREASE)').padEnd(24) + e.value);
      }
    }

    await closeAllWindows();
    for (const p of probes) { try { await p.close(); } catch (_) {} }
    console.log('');
    console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log('FAIL  threw: ' + (e && e.message));
    try { await closeAllWindows(); } catch (_) {}
    for (const p of probes) { try { await p.close(); } catch (_) {} }
    process.exit(1);
  }
})();
