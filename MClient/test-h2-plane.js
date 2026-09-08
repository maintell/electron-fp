#!/usr/bin/env node
// The HTTP/2 plane exists in the kernel but was unreachable from the product.
// This file closes that gap and, more importantly, pins down the ONE property
// that makes it different from TLS: it is frozen at partition creation.
//
// Three things get proved, all off the wire:
//   1. A profile carrying settingsGrease reaches the tab's own partition and
//      puts a GREASE entry on the SETTINGS frame. (The reachability gap.)
//   2. The same setting applied to an EXISTING tab does NOT move the bytes -
//      and the product says so instead of returning success. (The honesty gap:
//      a control that looks applied but is not is worse than a documented limit.)
//   3. The 3 H2 keys route to their own plane and are validated, so a wrong
//      type is refused with a message rather than silently dropping the profile.
//
// Why GREASE is the right signal: net/'s default is
// enable_http2_settings_grease = false while real Chrome turns it ON via
// components/network_session_configurator, which Electron never runs. So an
// unprofiled session differs from Chrome on EVERY HTTP/2 connection - the
// default state is already a fingerprint mismatch.
//
// Runs in the Electron main process (net/ is only reachable from there).

'use strict';

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, session } = require('electron');

const {
  FP_H2_KEYS, FP_H2_KEY_NAMES, fpSplitConfig, fpH2Validate, fpH2IsActive,
} = require('./fp-schema.js');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return; }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const T_SETTINGS = 0x04;
// draft-bishop-httpbis-grease-01 s2.2: id is 0x?a?a - both bytes have low nibble
// 0xa, the high nibbles are independent. (0x7a9a, 0x1a8a, 0xfa9a are all valid.)
const isGrease = (id) => ((id >> 8) & 0x0f) === 0x0a && (id & 0x0f) === 0x0a;

// Electron QUITS when the last BrowserWindow is destroyed, so hold one open for
// the whole run. Without this the process exits mid-suite with status 0 and the
// run looks green while measuring nothing.
let keepAlive = null;

function selfSigned() {
  const dir = path.join(os.tmpdir(), 'electron-fp-h2plane');
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

// Minimal TLS server: read the client preface + SETTINGS off the wire and stop.
// Parsing raw bytes matters - node's http2 server exposes SETTINGS as NAMED
// properties and silently DROPS unknown (GREASE) ids, so it cannot see the exact
// signal under test. (fingerprint/README.md records this trap.)
function startProbe() {
  const { key, cert } = selfSigned();
  return new Promise((resolve) => {
    let settle = null;
    const waited = new Promise((r) => { settle = r; });
    const srv = tls.createServer({ key, cert, ALPNProtocols: ['h2'] }, (sock) => {
      let buf = Buffer.alloc(0);
      let done = false;
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (done || buf.length < 33) return;
        const rest = buf.subarray(24); // 24-byte connection preface
        let off = 0;
        while (off + 9 <= rest.length) {
          const len = (rest[off] << 16) | (rest[off + 1] << 8) | rest[off + 2];
          const type = rest[off + 3];
          const ps = off + 9;
          if (ps + len > rest.length) return; // incomplete frame, wait
          if (type === T_SETTINGS) {
            const pl = rest.subarray(ps, ps + len);
            const entries = [];
            for (let i = 0; i + 6 <= pl.length; i += 6) {
              entries.push([pl.readUInt16BE(i), pl.readUInt32BE(i + 2)]);
            }
            done = true;
            settle({ entries, grease: entries.filter(([i]) => isGrease(i)) });
            try { sock.end(); } catch (_) {}
            return;
          }
          off = ps + len;
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        wait: () => Promise.race([waited, new Promise((r) => setTimeout(() => r(null), 15000))]),
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

async function capture(partition, h2Profile) {
  const probe = await startProbe();
  // The profile MUST ride on the first fromPartition() for this name.
  const sess = h2Profile && Object.keys(h2Profile).length
    ? session.fromPartition(partition, { http2Profile: h2Profile })
    : session.fromPartition(partition);
  sess.setCertificateVerifyProc((req, cb) => cb(0));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: sess },
  });
  win.loadURL(`https://127.0.0.1:${probe.port}/x`).catch(() => null);
  const rec = await probe.wait();
  try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  await probe.close();
  return rec;
}

(async () => {
  await app.whenReady();
  keepAlive = new BrowserWindow({ show: false, width: 80, height: 80 });

  // ---------------------------------------------------------------- schema
  console.log('--- schema: the H2 plane is separate and validated ---');
  check('3 HTTP/2 keys are declared', FP_H2_KEY_NAMES.length === 3,
    FP_H2_KEY_NAMES.join(', '));
  check('H2 keys are NOT in the TLS table (different plane)',
    FP_H2_KEY_NAMES.every((k) => !/^fp/.test(k)),
    'settingsGrease does not start with fp, unlike every TLS key');

  const split = fpSplitConfig({
    screen_width: 1920,
    fpGreaseEnabled: false,
    settingsGrease: true,
    endStreamWithDataFrame: true,
  });
  check('fpSplitConfig routes H2 keys to their own plane',
    split.h2 && split.h2.settingsGrease === true &&
    split.h2.endStreamWithDataFrame === true,
    JSON.stringify(split.h2));
  check('fpSplitConfig keeps the TLS plane separate',
    split.tls && split.tls.fpGreaseEnabled === false, JSON.stringify(split.tls));
  check('fpSplitConfig keeps the Blink plane separate',
    split.fingerprint && split.fingerprint.screen_width === 1920,
    'screen_width=' + split.fingerprint.screen_width);

  // A wrong type must be refused loudly. The gin converter bails on a type
  // mismatch and drops the WHOLE profile, so silence here means no H2 at all.
  for (const bad of [{ settingsGrease: 1 }, { settingsGrease: 'true' }]) {
    const v = fpH2Validate(bad);
    check('a wrong-typed H2 value is refused, naming the key',
      v.ok === false && /settingsGrease/.test(v.error || ''),
      JSON.stringify(bad) + ' -> ' + (v.error || ''));
  }
  check('greaseFrame.type out of range is refused',
    fpH2Validate({ greaseFrame: { type: 999 } }).ok === false,
    fpH2Validate({ greaseFrame: { type: 999 } }).error);
  check('a valid greaseFrame normalizes hex payload to bytes',
    JSON.stringify(fpH2Validate({ greaseFrame: { type: 42, flags: 0, payload: 'deadbeef' } })
      .profile.greaseFrame.payload) === '[222,173,190,239]',
    JSON.stringify(fpH2Validate({ greaseFrame: { type: 42, flags: 0, payload: 'deadbeef' } })
      .profile.greaseFrame.payload));
  check('fpH2IsActive sees a set bool',
    fpH2IsActive('settingsGrease', true) === true &&
    fpH2IsActive('settingsGrease', '') === false, 'true / empty');

  // ------------------------------------------------------------------ wire
  console.log('\n--- wire: the plane reaches the bytes on its own partition ---');
  const stock = await capture('h2plane-' + Date.now() + '-stock', null);
  if (!stock) {
    check('unprofiled session captured a SETTINGS frame', false, 'no capture');
  } else {
    check('unprofiled session sends NO GREASE (the Electron default)',
      stock.grease.length === 0, stock.grease.length + ' grease of ' + stock.entries.length + ' entries');
  }

  const greased = await capture('h2plane-' + Date.now() + '-grease', { settingsGrease: true });
  if (!greased) {
    check('greased session captured a SETTINGS frame', false, 'no capture');
  } else {
    check('settingsGrease:true ADDS a GREASE entry to SETTINGS',
      greased.grease.length > 0,
      greased.grease.map(([i, v]) => '0x' + i.toString(16) + '=' + v).join(',') || 'none');
    if (stock) {
      check('the difference is real, not a shared default',
        greased.grease.length > 0 && stock.grease.length === 0,
        'greased=' + greased.grease.length + ' stock=' + stock.grease.length);
    }
  }

  // ------------------------------------------------------- the frozen plane
  console.log('\n--- frozen: an existing partition cannot be changed ---');
  // This is the property that makes H2 unlike TLS, and the reason it needs its
  // own delivery rule. If this ever starts passing `true`, the ordering
  // constraint was broken and the UI must stop claiming per-tab H2 control.
  const p = 'h2plane-' + Date.now() + '-frozen';
  session.fromPartition(p); // first touch, no options - locks H2 off
  const post = await capture(p, { settingsGrease: true });
  if (post) {
    check('a profile passed after the first fromPartition() does NOT apply',
      post.grease.length === 0,
      'grease=' + post.grease.length + ' (must be 0: the plane is frozen)');
  } else {
    check('frozen-partition capture succeeded', false, 'no capture');
  }

  console.log('\n' + (fail === 0
    ? 'PASS: ' + pass + ' checks' + (skip ? ' (' + skip + ' skipped)' : '')
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));

  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR: ' + (e && e.stack || e));
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(1);
});
