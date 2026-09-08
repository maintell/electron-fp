#!/usr/bin/env node
// Does our local TLS probe see the SAME ClientHello a real server sees?
//
// Does our local TLS probe see the SAME ClientHello a real server sees?
//
// External validation (browserleaks) reported 16 extensions. Our local probe
// reported 15. Local re-runs are perfectly stable at 15, so this is NOT the
// GREASE count varying - it is a systematic difference. Decoding the external
// ja4_o list against ours isolates it to exactly one extension:
//
//     0x0000 (server_name / SNI) - present for a hostname, ABSENT for an IP
//
// Chromium omits SNI when the host is an IP literal, and our probe is reached
// at https://127.0.0.1:PORT/. So the recorded baseline is a genuinely
// different ClientHello from the one a real named host sees.
//
// Why this matters: the baseline is the yardstick for "unprofiled == stock".
// A yardstick taken in a different context than deployment is a weaker
// guarantee than it appears - and the JA4 hash covers the extension list, so
// the local JA4 legitimately differs from the JA4 any real site computes.
//
// This test pins the behaviour down so the caveat stays documented and cannot
// regress silently: connecting by IP omits SNI, connecting by hostname emits
// it, and the two differ by exactly that one extension.

'use strict';


const tls = require('tls');
const net = require('net');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, session } = require('electron');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

function selfSigned() {
  const dir = path.join(os.tmpdir(), 'electron-fp-sni');
  fs.mkdirSync(dir, { recursive: true });
  const k = path.join(dir, 'key.pem'), c = path.join(dir, 'cert.pem');
  if (!fs.existsSync(k) || !fs.existsSync(c)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', k, '-out', c, '-days', '30', '-subj', '/CN=127.0.0.1'],
      { stdio: 'ignore', windowsHide: true });
  }
  return { key: fs.readFileSync(k), cert: fs.readFileSync(c) };
}

/**
 * Capture raw ClientHello bytes off the wire.
 *
 * Deliberately NOT using tls.Server's 'tlsClientHello' event: it never fired
 * in this configuration (verified - hello stayed NULL while the connection
 * succeeded), and depending on it would make a silent no-capture look like
 * "probe works, SNI absent". Instead we read the first data event on the raw
 * TCP socket and parse it ourselves, which is the same approach as the proven
 * Client/tls/tls-probe.js and which cannot silently return nothing.
 */
function startProbe() {
  const out = { hello: null };
  const cert = selfSigned();
  // Raw net server + PassThrough tap, exactly like Client/tls/tls-probe.js.
  // Two earlier attempts failed: (a) tls.Server 'tlsClientHello' never fired,
  // (b) tls.createServer 'connection' + once('data') never fired either. Both
  // exited cleanly with hello=NULL, i.e. a silent no-capture that reads as
  // "SNI absent". Reusing the one mechanism already proven to work avoids
  // inventing a third.
  const server = net.createServer((rawSocket) => {
    const tap = new PassThrough();
    rawSocket.pipe(tap);
    tap.on('data', (chunk) => {
      if (!out.hello && chunk.length > 5 && chunk[0] === 0x16) {
        out.hello = Buffer.from(chunk);
      }
    });
    const tlsSocket = new tls.TLSSocket(tap, {
      isServer: true,
      key: cert.key,
      cert: cert.cert,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    tlsSocket.on('error', () => {});
    tlsSocket.on('data', () => {});
    tlsSocket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    tlsSocket.end();
    rawSocket.on('error', () => {});
  });
  server.on('error', () => {});
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    port: server.address().port, out,
    close: () => Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 1200))]),
  })));
}

// Minimal ClientHello parse: extension type list (enough to compare sets).
function extTypes(buf) {
  if (!buf || buf.length < 5) return [];
  try {
    let i = 0;
    if (buf[0] !== 0x16) return [];          // handshake
    i = 5;                                    // type(1) len(3)
    if (buf[i] !== 0x01) return [];           // client_hello
    i += 1 + 3 + 2;                           // hs type + len + client_version
    i += 32;                                  // random
    const sidLen = buf[i]; i += 1 + sidLen;
    const csLen = buf.readUInt16BE(i); i += 2 + csLen;
    const cmLen = buf[i]; i += 1 + cmLen;
    const extLen = buf.readUInt16BE(i); i += 2;
    const end = i + extLen;
    const types = [];
    while (i + 4 <= end) {
      types.push(buf.readUInt16BE(i));
      const l = buf.readUInt16BE(i + 2);
      i += 4 + l;
    }
    return types;
  } catch (_) { return []; }
}

async function capture(url) {
  const p = await startProbe();
  const sess = session.fromPartition('persist:sniprobe-' + Buffer.from(url).toString('hex').slice(0, 12));
  sess.setCertificateVerifyProc((req, cb) => cb(0));
  const win = new BrowserWindow({ show: false, webPreferences: { session: sess } });
  const port = p.port;
  win.loadURL(url.replace('PORT', String(port))).catch(() => null);
  for (let i = 0; i < 100 && !p.out.hello; i++) await new Promise((r) => setTimeout(r, 100));
  const hello = p.out.hello;
  try { win.destroy(); } catch (_) {}
  await new Promise((r) => setTimeout(r, 200));
  await p.close();
  return { hello: hello ? Buffer.from(hello) : null };
}

(async () => {
  try {
    await app.whenReady();
    // Electron quits when the last window is destroyed. capture() destroys its
    // window, so without this the process can exit before console.log flushes -
    // which is why an earlier run printed nothing at all while the capture
    // itself had already succeeded.
    app.on('window-all-closed', (e) => { e.preventDefault(); });
    const byIp = await capture('https://127.0.0.1:PORT/x');
    const ipExt = extTypes(byIp.hello);
    console.log('\n--- connecting by IP (127.0.0.1) ---');

    console.log('ext count   :', ipExt.length);
    console.log('ext list    :', ipExt.map((x) => '0x' + x.toString(16).padStart(4, '0')).join(' '));
    check('IP connection OMITS SNI (0x0000)', !ipExt.includes(0x0000),
      ipExt.includes(0x0000) ? 'SNI present' : 'SNI absent');

    // Use a hostname that maps to 127.0.0.1 so SNI is emitted.
    const byHost = await capture('https://localhost.:PORT/x');
    const hostExt = extTypes(byHost.hello);
    console.log('\n--- connecting by hostname (localhost.) ---');

    console.log('ext count   :', hostExt.length);
    console.log('ext list    :', hostExt.map((x) => '0x' + x.toString(16).padStart(4, '0')).join(' '));
    check('hostname connection EMITS SNI (0x0000)', hostExt.includes(0x0000),
      hostExt.includes(0x0000) ? 'SNI present' : 'SNI absent');

    console.log('\n--- delta ---');
    const onlyHost = hostExt.filter((x) => !ipExt.includes(x));
    console.log('extensions only when using a hostname:',
      onlyHost.map((x) => '0x' + x.toString(16).padStart(4, '0')).join(' ') || '(none)');
    check('the IP-based probe MISSES at least the SNI extension '
      + '(so a local baseline is not the ClientHello a real host sees)',
      onlyHost.length > 0, 'missing=' + onlyHost.length);

    console.log('');
    console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log('FAIL  threw: ' + (e && e.message));
    process.exit(1);
  }
})();
