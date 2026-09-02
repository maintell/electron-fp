#!/usr/bin/env node
// Measure the REAL TLS fingerprint of the built Electron against a local probe.
//
// This is the external-validation half of the TLS work. It does NOT ask the
// browser what it thinks it sent - it makes an actual HTTPS request from a real
// renderer and reads the ClientHello off the wire. Without this, any claim
// about JA3/JA4 is unverified.
//
// Key protocol detail (learned the hard way, documented in fingerprint/README):
//   Chromium inserts GREASE values per RFC 8701, and GREASE is RANDOMIZED. The
//   FIRST ClientHello of a process therefore differs from subsequent ones.
//   If you don't warm up, you read GREASE noise and wrongly conclude that your
//   config "changed the fingerprint". So: always discard the first sample and
//   compare STABLE samples only.
//
// Usage: node Client/test-tls-fingerprint.js

'use strict';

// Runs INSIDE the Electron main process (require('electron')), launched by
// Client/run-tests.js as `electron Client/test-tls-fingerprint.js`. Same
// convention as the other Client tests.
'use strict';

const { app, BrowserWindow, session } = require('electron');

// session.fromPartition() asks SpareRenderProcessHostManager to warm up a
// spare renderer. That renderer is created LAZILY, so if it is still pending
// when app.exit() runs, Chromium hits
//   render_process_host_impl.cc:1725 Check failed:
//   !BrowserMainRunner::ExitedMainMessageLoop()
// and aborts with a non-zero exit code - after every check had already
// printed PASS. Preventing the default window-all-closed quit keeps the
// browser alive long enough for the spare to be created normally.
// Without this the file exited 4294930435 while reporting 15/15 passes,
// which the runner previously reported as a clean pass.
app.on('window-all-closed', (e) => { e.preventDefault(); });

const { startProbe } = require('./tls/tls-probe.js');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return; }
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const PROBE_HTML = 'data:text/html,<html><body>probe</body></html>';

/**
 * Load the probe URL in a hidden BrowserWindow on |sess|.
 *
 * Returns the window so the caller can destroy it. Loading is best-effort:
 * we only need the ClientHello, which the network stack emits before the page
 * finishes (or fails). A cert error still yields a valid ClientHello, so we
 * swallow load failures rather than letting them abort the measurement.
 */
async function captureHello(sess, url, probe) {
  // Ignore cert errors so our self-signed probe cert does not abort the
  // handshake midway. This does NOT alter ClientHello contents.
  sess.setCertificateVerifyProc((req, cb) => cb(0));

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: sess,
    },
  });

  // IMPORTANT: start waiting for the sample BEFORE/ALONGSIDE the load, not
  // after it. The page never finishes loading (our probe speaks TLS but not
  // HTTP/2 + the cert is untrusted), so `await win.loadURL(...)` rejects with
  // ERR_TIMED_OUT. Waiting for the load first means we never reach the sample.
  const sampleP = probe.waitForSample(20000).catch(() => null);
  const loadP = win.loadURL(url).catch(() => null);

  const sample = await sampleP;
  // Let the load settle (or time out) so we can cleanly destroy the window.
  await Promise.race([loadP, new Promise((r) => setTimeout(r, 3000))]);
  return { win, sample };
}

async function run() {
  await app.whenReady();

  const probe = await startProbe({ port: 0 });
  const url = `https://127.0.0.1:${probe.port}/probe`;

  // ---- Sample 1: warm-up (DISCARDED - GREASE randomization) ----------------
  // Two different sessions prove whether config can move the TLS fingerprint
  // at all, and whether it is per-partition or process-global.
  const sessA = session.fromPartition('persist:tls-a');
  const sessB = session.fromPartition('persist:tls-b');

  // Warm up: the first handshake of a session carries randomized GREASE, so it
  // is discarded. Comparing it against later samples produces false positives.
  try {
    const { win } = await captureHello(sessA, url, probe);
    await win.destroy();
  } catch (e) { /* fall through */ }

  // ---- Sample 2: stable baseline (no fingerprint config) -------------------
  let baseA = null;
  try {
    const { win, sample } = await captureHello(sessA, url, probe);
    baseA = sample;
    await win.destroy();
  } catch (e) { /* fall through */ }

  if (!baseA || !baseA.fp || baseA.fp.error) {
    check('baseline: captured ClientHello', false,
      baseA ? String(baseA.fp && baseA.fp.error) : 'no sample');
    await probe.close();
    app.quit();
    process.exit(1);
  }

  const b = baseA.fp;
  console.log('\n--- Baseline Electron ClientHello (no fingerprint config) ---');
  console.log('JA3 : ' + b.ja3.hash);
  console.log('JA4 : ' + b.ja4.str);
  console.log('JA3 str: ' + b.ja3.str);
  console.log('ciphers(' + b.cipherSuiteCount + '): ' + b.cipherSuites.join(' '));
  console.log('extensions(' + b.extensionCount + '): ' + b.extensions.join(' '));
  console.log('groups: ' + b.supportedGroups.join(' '));
  console.log('keyShares: ' + b.keyShares.map(k => k.group).join(' '));
  console.log('sigAlgs: ' + b.signatureAlgorithms.join(' '));
  console.log('ALPN: ' + JSON.stringify(b.tls.alpn));
  console.log('GREASE: ' + b.grease.count +
    ' (ciphers ' + b.grease.cipherSuites.length +
    ', exts ' + b.grease.extensions.length +
    ', groups ' + b.grease.supportedGroups.length + ')');
  console.log('');

  // ---- Structural assertions on the real Chromium ClientHello -------------
  // These pin what a Chromium 154 ClientHello MUST look like. They catch the
  // case where our later changes accidentally break the handshake.
  check('baseline: TLS 1.3 advertised', b.tls.supportedVersions.includes('0x0304'), JSON.stringify(b.tls.supportedVersions));
  check('baseline: TLS 1.2 also advertised', b.tls.supportedVersions.includes('0x0303'), JSON.stringify(b.tls.supportedVersions));
  check('baseline: has supported_versions ext (0x002b)', b.extensions.includes('0x002b'));
  check('baseline: has key_share ext (0x0033)', b.extensions.includes('0x0033'));
  check('baseline: has sig_algs ext (0x000d)', b.extensions.includes('0x000d'));
  check('baseline: has ALPN ext (0x0010)', b.extensions.includes('0x0010'));
  check('baseline: has session_ticket ext (0x0023)', b.extensions.includes('0x0023'));
  check('baseline: has psk_key_exchange_modes (0x002d)', b.extensions.includes('0x002d'));
  check('baseline: GREASE present in ciphers', b.grease.cipherSuites.length > 0, String(b.grease.cipherSuites.length));
  check('baseline: X25519MLKEM768 group present', b.supportedGroups.includes('0x11ec'), b.supportedGroups.join(' '));
  // JA4 a1 = <proto=t><ver=13><sni d|i><cipher count><ext count><alpn 2ch>.
  // The SNI char is 'i' here because we connect to 127.0.0.1 (an IP literal),
  // not 'd' - JA4 encodes "SNI is a domain" vs "SNI is an IP". Asserting 'd'
  // would be wrong for a localhost probe.
  check('baseline: JA4 is TCP-TLS form (t13[di]...)', /^t13[di]/.test(b.ja4.str), b.ja4.str);
  check('baseline: JA4 SNI flag is "i" (IP literal target)', b.ja4.str.startsWith('t13i'), b.ja4.str);
  check('baseline: JA3 is 32 hex', /^[0-9a-f]{32}$/.test(b.ja3.hash), b.ja3.hash);

  // ALPN: a top-level navigation should offer h2 and http/1.1
  check('baseline: ALPN offers h2', b.tls.alpn.includes('h2'), JSON.stringify(b.tls.alpn));
  check('baseline: ALPN offers http/1.1', b.tls.alpn.includes('http/1.1'), JSON.stringify(b.tls.alpn));

  // ---- Cross-session: is TLS per-partition or process-global? -------------
  // This is the empirical test of the central architectural question. If
  // partition B (fresh, no config) yields the same JA4 as partition A, the
  // network stack is shared regardless of partition.
  let baseB = null;
  try {
    const { win, sample } = await captureHello(sessB, url, probe);
    baseB = sample;
    await win.destroy();
  } catch (e) { /* fall through */ }

  if (baseB && baseB.fp && !baseB.fp.error) {
    const sameJa4 = baseB.fp.ja4.str === b.ja4.str;
    check('cross-partition: JA4 identical (shared network stack)',
      sameJa4 === true,
      'A=' + b.ja4.str + ' B=' + baseB.fp.ja4.str);
    console.log('\n--- Partition B (fresh session, no config) ---');
    console.log('JA4 : ' + baseB.fp.ja4.str);
    console.log('JA3 : ' + baseB.fp.ja3.hash);
  } else {
    check('cross-partition: captured', false, baseB ? String(baseB.fp && baseB.fp.error) : 'no sample');
  }

  // ---- Stability: same session, repeated connection -----------------------
  // A fingerprint that changes every request is worse than no fingerprint.
  let baseA2 = null;
  try {
    const { win, sample } = await captureHello(sessA, url, probe);
    baseA2 = sample;
    await win.destroy();
  } catch (e) { /* fall through */ }

  if (baseA2 && baseA2.fp && !baseA2.fp.error) {
    check('stability: JA4 stable across repeat connections',
      baseA2.fp.ja4.str === b.ja4.str,
      baseA2.fp.ja4.str + ' vs ' + b.ja4.str);
  }

  await probe.close();

  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
  app.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.log("FAIL  threw: " + (e && e.message));
  console.log(e && e.stack);
  app.exit(1);
});
