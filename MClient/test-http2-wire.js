#!/usr/bin/env node
// Prove the two REMAINING HTTP/2 profile fields move real bytes:
//   greaseFrame            - emit a reserved-type frame after SETTINGS
//   endStreamWithDataFrame - END_STREAM on an empty DATA frame, not on HEADERS
//
// settingsGrease is already proven by test-http2-profile.js. These two were
// wired through mojom but never shown to reach the wire, which is the gap this
// file closes: a field that is accepted-and-ignored looks identical to one that
// works unless you inspect the bytes. That is precisely how the gin whitelist
// bug survived - every profile produced an identical JA4.
//
// Unlike the probe in test-http2-profile.js, this one stays OPEN past the
// SETTINGS frame, because both fields under test affect what the client sends
// AFTER SETTINGS. It also plays the server side of the HTTP/2 handshake (send
// SETTINGS + ACK) so the client proceeds to send HEADERS at all.
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

const PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
const T_DATA = 0x00, T_HEADERS = 0x01, T_SETTINGS = 0x04;
const END_STREAM = 0x01, ACK = 0x01;

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
  const dir = path.join(os.tmpdir(), 'electron-fp-h2wire');
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

function buildFrame(type, flags, payload) {
  const p = Buffer.from(payload || []);
  const h = Buffer.alloc(9);
  h.writeUIntBE(p.length, 0, 3);
  h[3] = type;
  h[4] = flags;
  h.writeUInt32BE(0, 5);
  return Buffer.concat([h, p]);
}

/**
 * Decode every frame the client sends, keeping the connection open.
 * Resolves once a HEADERS frame is seen (so we know the request went out) or
 * after `timeout`; returns all frames decoded up to that point.
 */
function startProbe(timeoutMs = 15000) {
  const frames = [];
  let resolveWait = null;
  let settled = false;
  const cert = selfSigned();

  const server = tls.createServer(
    { key: cert.key, cert: cert.cert, ALPNProtocols: ['h2'] },
    (sock) => {
      let buf = Buffer.alloc(0);
      let seenSettings = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        if (resolveWait) resolveWait();
      };

      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 24) return;
        let off = buf.slice(0, 24).toString('latin1') === PREFACE ? 24 : 0;

        while (off + 9 <= buf.length) {
          const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
          const type = buf[off + 3];
          const flags = buf[off + 4];
          const stream = buf.readUInt32BE(off + 5);
          if (off + 9 + len > buf.length) return;
          const payload = buf.slice(off + 9, off + 9 + len);
          frames.push({ type, flags, stream, len, payload });
          off += 9 + len;

          // Play the server side so the client sends its request.
          if (type === T_SETTINGS && !seenSettings) {
            seenSettings = true;
            try {
              sock.write(buildFrame(T_SETTINGS, 0, []));        // server SETTINGS
              sock.write(buildFrame(T_SETTINGS, ACK, []));      // ACK client's
            } catch (_) {}
          }
          if (type === T_HEADERS) {
            // Do not settle immediately: when END_STREAM is deferred to a DATA
            // frame, that DATA frame is written right after HEADERS within the
            // same TCP segment or the next one. Settling on HEADERS alone
            // truncates the capture before it can arrive, which would make a
            // working field look broken. Give it a brief window to land.
            setTimeout(settle, 1200);
          }
        }
      });
      sock.on('error', () => {});
      sock.on('close', () => settle());
    });

  server.on('tlsClientHello', (s, cb) => cb(null, true));
  server.on('error', () => {});

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      wait: () => new Promise((res) => {
        if (settled) return res(frames);
        resolveWait = () => res(frames);
        setTimeout(() => { settled = true; res(frames); }, timeoutMs);
      }),
      close: () => Promise.race([
        new Promise((r) => server.close(r)),
        new Promise((r) => setTimeout(r, 1500)),
      ]),
    }));
  });
}

async function capture(partition, profile) {
  const probe = await startProbe();
  const sess = profile !== null
    ? session.fromPartition('persist:' + partition, { http2Profile: profile })
    : session.fromPartition('persist:' + partition);
  sess.setCertificateVerifyProc((req, cb) => cb(0));
  const win = track(new BrowserWindow({
    show: false, webPreferences: { session: sess },
  }));
  const p = probe.wait();
  win.loadURL(`https://127.0.0.1:${probe.port}/x`).catch(() => null);
  const frames = await p;
  return { frames, probe };
}

function dump(label, frames) {
  console.log('\n--- ' + label + ' ---');
  for (const f of frames) {
    const hex = f.payload.length ? f.payload.toString('hex') : '(empty)';
    console.log('  type=0x' + f.type.toString(16).padStart(2, '0') +
      ' flags=0x' + f.flags.toString(16) +
      ' stream=' + f.stream +
      ' len=' + f.len + '  ' + hex.slice(0, 40));
  }
}

const framesOfType = (frames, t) => frames.filter((f) => f.type === t);
const headersFrame = (frames) => framesOfType(frames, T_HEADERS)[0] || null;

(async () => {
  const probes = [];
  try {
    await app.whenReady();

    // ================= greaseFrame =================
    const GREASE_TYPE = 0x2a;   // reserved: 0x0b + 0x1f*1
    const GREASE_PAYLOAD = [0xde, 0xad, 0xbe, 0xef];

    const d = await capture('h2wire-default', null);
    probes.push(d.probe);
    dump('default (no profile)', d.frames);
    const dGrease = framesOfType(d.frames, GREASE_TYPE);
    check('greaseFrame: default sends NO reserved-type frame (stock preserved)',
      dGrease.length === 0, String(dGrease.length));

    const g = await capture('h2wire-grease', {
      greaseFrame: { type: GREASE_TYPE, flags: 0, payload: GREASE_PAYLOAD },
    });
    probes.push(g.probe);
    dump('profile greaseFrame type=0x2a payload=deadbeef', g.frames);
    const gGrease = framesOfType(g.frames, GREASE_TYPE);
    check('greaseFrame: profile EMITS the reserved-type frame',
      gGrease.length > 0, gGrease.length ? 'count=' + gGrease.length : 'none');
    if (gGrease.length) {
      check('greaseFrame: emitted frame carries the configured flags',
        gGrease[0].flags === 0, 'flags=0x' + gGrease[0].flags.toString(16));
      check('greaseFrame: emitted frame carries the configured payload',
        gGrease[0].payload.toString('hex') === 'deadbeef',
        gGrease[0].payload.toString('hex'));
      // It must come after SETTINGS - that is the documented position.
      const si = g.frames.findIndex((f) => f.type === T_SETTINGS);
      const gi = g.frames.indexOf(gGrease[0]);
      check('greaseFrame: emitted AFTER the SETTINGS frame',
        si >= 0 && gi > si, 'settings@' + si + ' grease@' + gi);
    }

    // ================= endStreamWithDataFrame =================
    const e0 = await capture('h2wire-es-false', { endStreamWithDataFrame: false });
    probes.push(e0.probe);
    dump('profile endStreamWithDataFrame:false', e0.frames);
    const h0 = headersFrame(e0.frames);
    check('endStream:false - HEADERS carries END_STREAM',
      h0 !== null && (h0.flags & END_STREAM) !== 0,
      h0 ? 'flags=0x' + h0.flags.toString(16) : 'no HEADERS');
    const emptyData0 = framesOfType(e0.frames, T_DATA)
      .filter((f) => f.len === 0 && (f.flags & END_STREAM) !== 0);
    check('endStream:false - NO empty END_STREAM DATA frame',
      emptyData0.length === 0, String(emptyData0.length));

    const e1 = await capture('h2wire-es-true', { endStreamWithDataFrame: true });
    probes.push(e1.probe);
    dump('profile endStreamWithDataFrame:true', e1.frames);
    const h1 = headersFrame(e1.frames);
    check('endStream:true - HEADERS does NOT carry END_STREAM',
      h1 !== null && (h1.flags & END_STREAM) === 0,
      h1 ? 'flags=0x' + h1.flags.toString(16) : 'no HEADERS');
    const emptyData1 = framesOfType(e1.frames, T_DATA)
      .filter((f) => f.len === 0 && (f.flags & END_STREAM) !== 0);
    check('endStream:true - an empty DATA frame carries END_STREAM',
      emptyData1.length > 0, 'count=' + emptyData1.length);

    if (h0 && h1) {
      check('endStream:false and :true produce OPPOSITE HEADERS END_STREAM bits '
        + '(proves the field is read, not ignored)',
        ((h0.flags & END_STREAM) !== 0) !== ((h1.flags & END_STREAM) !== 0),
        'false=0x' + h0.flags.toString(16) + ' true=0x' + h1.flags.toString(16));
    }

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
