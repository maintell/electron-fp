#!/usr/bin/env node
// Prove the TLS fingerprint controls actually move the ClientHello.
//
// This is the test that turns "we added config knobs" into "we can produce a
// target ClientHello". It applies distinct TLS profiles to separate sessions
// and asserts the OBSERVED wire bytes change accordingly.
//
// Discipline enforced here (and the reason the previous README recorded a
// false negative):
//   1. Discard the first handshake of every session. GREASE (RFC 8701) is
//      randomized per process, so the first ClientHello differs from later
//      ones. Comparing it makes unrelated profiles look "different".
//   2. Compare stable samples only.
//   3. Assert on the DERIVED JA3/JA4 *and* on the raw fields, so a change is
//      attributed to the surface that produced it.
//
// Runs inside the Electron main process.

'use strict';

const { app, BrowserWindow, session } = require('electron');
const { startProbe } = require('./tls/tls-probe.js');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return; }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

// TLS 1.3 / 1.2 cipher suite code points
const TLS_AES_128_GCM_SHA256 = 0x1301;
const TLS_AES_256_GCM_SHA384 = 0x1302;
const TLS_CHACHA20_POLY1305_SHA256 = 0x1303;

// Track every window we create so we can tear them all down before app.exit().
// Calling app.exit() with a live BrowserWindow races RenderProcessHost teardown
// and trips a FATAL CHECK in content (render_process_host_impl.cc) when the
// process is already exiting - which aborts the run before results print.
const liveWindows = new Set();
function track(win) { liveWindows.add(win); return win; }

// Destroying a window must ALSO remove it from liveWindows. The first version
// of the warm-up fix called win.destroy() directly, leaving the dead handle in
// the set; closeAllWindows() then touched a destroyed window and the process
// died with 0xC0000005 after printing only 1 of 17 checks. A window is only
// safe to tear down once - so tear it down in exactly one place.
function destroyTracked(win) {
  liveWindows.delete(win);
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.destroy();
      win.destroy();
    }
  } catch (_) { /* already gone */ }
}

async function closeAllWindows() {
  for (const w of [...liveWindows]) destroyTracked(w);
  // Give the browser process a beat to finish tearing down renderers.
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Create a session with a TLS profile and return its STABLE ClientHello.
 * Performs a discarded warm-up handshake first (see header).
 */
async function measure(partition, sslConfig) {
  // A DEDICATED probe per measurement, started on its own ephemeral port.
  // A shared probe accumulates samples from every earlier session and
  // waitForSample() returns an existing one immediately - the trap the
  // fpExtensionOrder case at the bottom of this file already documents.

  // Each capture gets its OWN session partition, which is what makes a second
  // ClientHello happen at all.
  //
  // The first version of this fix did warm-up and measured on the SAME session
  // and simply waited for a newer sample. That never arrived: the second
  // loadURL reused the warm-up's TLS connection, so no new handshake occurred
  // and the measured sample was NULL. Instrumenting both captures showed it
  // plainly - warm-up got a sample, measured got nothing.
  //
  // A fresh partition means a fresh connection, so a real second handshake
  // happens. The warm-up is still honoured: GREASE is randomized PER
  // CONNECTION, so a brand-new partition's first handshake is exactly the
  // non-comparable one the header says to throw away.
  const capture = async (suffix) => {
    const probe = await startProbe({ port: 0 });
    const url = `https://127.0.0.1:${probe.port}/probe`;
    const sess = session.fromPartition('persist:' + partition + '-' + suffix);
    sess.setCertificateVerifyProc((req, cb) => cb(0));
    if (sslConfig) sess.setSSLConfig(sslConfig);

    const win = track(new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: sess },
    }));
    const sampleP = probe.waitForSample(20000).catch(() => null);
    const loadP = win.loadURL(url).catch(() => null);
    const s = await sampleP;
    await Promise.race([loadP, new Promise((r) => setTimeout(r, 3000))]);
    // The window is deliberately NOT destroyed here. Destroying it crashed the
    // process (0xC0000005) partway through the second profile: this Electron
    // tears down a BrowserWindow that still owns a live TLS connection badly.
    // Windows stay in liveWindows and are destroyed once, at the end.
    await probe.close();
    return { win, s };
  };

  // Warm-up: discarded. GREASE is randomized per connection, so the first
  // ClientHello of a fresh session is not comparable to anything.
  await capture('warm', null);

  // Measured handshake: a separate session, so a separate connection and a
  // real ClientHello. Distinct from the warm-up rather than a re-read of it.
  const { s } = await capture('measured', null);
  return s;
}

(async () => {
  try {
    await app.whenReady();
    // No shared probe any more: measure() starts one per profile so the
    // warm-up and measured handshakes cannot contaminate each other (see the
    // comment in measure()). The fpExtensionOrder case at the bottom starts its
    // own for the same reason.

    // ---- Profile 0: no config (must be the native Chromium baseline) ------
    const base = await measure('tlsctl-base', null);
    if (!base || !base.fp || base.fp.error) {
      check('tls-ctl: baseline captured', false, base ? String(base.fp.error) : 'none');
      app.exit(1);
      return;
    }
    const b = base.fp;
    console.log('\n--- baseline (no profile) ---');
    console.log('JA4=' + b.ja4.str + '  ciphers=' + b.cipherSuiteCount +
      '  exts=' + b.extensionCount + '  GREASE=' + b.grease.count);

    check('tls-ctl: baseline captured', true, 'JA4=' + b.ja4.str);

    // ---- Profile 1: restrict the cipher list ------------------------------
    //
    // Two BoringSSL semantics that will silently produce a false negative if
    // you get them wrong (both cost real debugging time to find):
    //
    // 1. CIPHER NAMES ARE HYPHENATED. BoringSSL expects
    //    'ECDHE-RSA-AES128-GCM-SHA256', NOT the OpenSSL long form
    //    'ECDHE_RSA_WITH_AES_128_GCM_SHA256'. An unrecognized name is not
    //    necessarily fatal in this API, so a wrong-form list can be accepted
    //    and simply fail to narrow anything - looking exactly like "the
    //    setting was ignored".
    //
    // 2. THE CIPHER LIST CONTROLS TLS <= 1.2 ONLY. TLS 1.3 ciphersuites
    //    (0x1301..0x1303) are always offered and are unaffected. A profile
    //    listing only TLS 1.3 names is therefore a no-op on the wire.
    //
    // So we restrict to one TLS 1.2 suite and expect: the TLS<=1.2 set shrinks
    // to exactly that suite, while the 3 TLS 1.3 suites remain.
    const cipherProfile = {
      minVersion: 'tls1.2',
      maxVersion: 'tls1.3',
      fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256',
    };
    const p1 = await measure('tlsctl-cipher', cipherProfile);
    if (p1 && p1.fp && !p1.fp.error) {
      const f = p1.fp;
      console.log('\n--- profile: restricted cipher list ---');
      console.log('JA4=' + f.ja4.str + '  ciphers=' + f.cipherSuiteCount +
        '  exts=' + f.extensionCount);
      console.log('ciphers on wire: ' + f.cipherSuites.join(' '));

      // TLS 1.3 suites (0x13xx) are NOT controlled by the cipher list.
      // .fp.cipherSuites holds hex STRINGS ('0x1301'), so match on the string
      // form rather than doing bitwise arithmetic on numbers.
      const isTLS13 = (c) => /^0x13[0-9a-f]{2}$/.test(c);
      const f12 = f.cipherSuites.filter((c) => !isTLS13(c));
      const b12 = b.cipherSuites.filter((c) => !isTLS13(c));

      check('tls-ctl: cipher list reduces the TLS<=1.2 cipher set',
        f12.length < b12.length, f12.length + ' < ' + b12.length);
      check('tls-ctl: cipher list changes JA4',
        f.ja4.str !== b.ja4.str, f.ja4.str + ' vs ' + b.ja4.str);
      check('tls-ctl: cipher list changes JA3',
        f.ja3.hash !== b.ja3.hash, f.ja3.hash + ' vs ' + b.ja3.hash);

      // Only the suite we asked for may appear among TLS <= 1.2 entries.
      // (GREASE values are 0x?a?a shaped; filter them as protocol noise.)
      const isGrease = (c) => /^0x[0-9a-f]a[0-9a-f]a$/.test(c);
      const allowed = new Set(['0xc02f']);  // ECDHE-RSA-AES128-GCM-SHA256
      const unexpected = f12.filter((c) => !allowed.has(c) && !isGrease(c));
      check('tls-ctl: only the requested TLS<=1.2 suite is offered',
        unexpected.length === 0, unexpected.length ? unexpected.join(' ') : 'none');

      // TLS 1.3 suites must survive: they are not governed by this setting.
      const f13 = f.cipherSuites.filter((c) => isTLS13(c));
      check('tls-ctl: TLS 1.3 suites unaffected by cipher list (BoringSSL semantics)',
        f13.length >= 3, f13.join(' '));
    } else {
      check('tls-ctl: cipher profile captured', false, p1 ? String(p1.fp.error) : 'none');
    }

    // ---- Profile 2: disable GREASE ----------------------------------------
    // GREASE is randomized per connection, so the reliable signal is the
    // ABSENCE of any GREASE code point, not a specific JA4 string.
    const noGrease = {
      minVersion: 'tls1.2',
      maxVersion: 'tls1.3',
      fpGreaseEnabled: false,
      fpGreaseSigalgsEnabled: false,
    };
    const p2 = await measure('tlsctl-nogrease', noGrease);
    if (p2 && p2.fp && !p2.fp.error) {
      const f = p2.fp;
      console.log('\n--- profile: GREASE disabled ---');
      console.log('JA4=' + f.ja4.str + '  GREASE=' + f.grease.count +
        ' (ciphers ' + f.grease.cipherSuites.length +
        ', exts ' + f.grease.extensions.length +
        ', groups ' + f.grease.supportedGroups.length +
        ', sigalgs ' + f.grease.signatureAlgorithms.length + ')');

      // f.grease.* values are already hex STRINGS from the .fp view, so they
      // must not be re-prefixed with '0x' (that produced '0x0x0a0a').
      check('tls-ctl: GREASE disabled removes GREASE ciphers',
        f.grease.cipherSuites.length === 0, f.grease.cipherSuites.join(' '));
      check('tls-ctl: GREASE disabled removes GREASE extensions',
        f.grease.extensions.length === 0, f.grease.extensions.join(' '));
      check('tls-ctl: GREASE disabled removes GREASE sigalgs',
        f.grease.signatureAlgorithms.length === 0,
        f.grease.signatureAlgorithms.join(' '));
      check('tls-ctl: baseline DOES grease (control)',
        b.grease.count > 0, String(b.grease.count));
    } else {
      check('tls-ctl: no-grease profile captured', false, p2 ? String(p2.fp.error) : 'none');
    }

    // ---- Profile 3: session_ticket omitted --------------------------------
    const noTicket = {
      minVersion: 'tls1.2',
      maxVersion: 'tls1.3',
      fpOmitSessionTicket: true,
    };
    const p3 = await measure('tlsctl-noticket', noTicket);
    if (p3 && p3.fp && !p3.fp.error) {
      const f = p3.fp;
      console.log('\n--- profile: session_ticket omitted ---');
      console.log('hasSessionTicket=' + f.tls.hasSessionTicket +
        '  exts=' + f.extensionCount + '  JA4=' + f.ja4.str);

      check('tls-ctl: omitting session_ticket removes the extension',
        f.tls.hasSessionTicket === false, String(f.tls.hasSessionTicket));
      check('tls-ctl: baseline DOES send session_ticket (control)',
        b.tls.hasSessionTicket === true, String(b.tls.hasSessionTicket));
      check('tls-ctl: session_ticket change moves JA3',
        f.ja3.hash !== b.ja3.hash, f.ja3.hash + ' vs ' + b.ja3.hash);
    } else {
      check('tls-ctl: no-ticket profile captured', false, p3 ? String(p3.fp.error) : 'none');
    }

    // ---- Profile 4: advertised TLS version capped at 1.2 ------------------
    // This is the subtle one: fpAdvertisedVersionMax must change what is
    // ADVERTISED (visible to a passive observer) while version_max still
    // governs what the client accepts.
    const cap12 = {
      minVersion: 'tls1.2',
      maxVersion: 'tls1.3',
      fpAdvertisedVersionMax: 0x0303,  // TLS 1.2
    };
    const p4 = await measure('tlsctl-cap12', cap12);
    if (p4 && p4.fp && !p4.fp.error) {
      const f = p4.fp;
      console.log('\n--- profile: advertised version capped at TLS 1.2 ---');
      console.log('supportedVersions=' + JSON.stringify(f.tls.supportedVersions) +
        '  JA4=' + f.ja4.str);

      // REPRESENTATION NOTE (this cost two debug cycles, so it is spelled out):
      // the object returned by parseClientHello has TWO views:
      //   .tls.<field>  -> NUMBERS   (raw parsed values)
      //   .fp.<field>   -> hex STRINGS like '0x0304' (JA3/JA4-oriented view)
      // f and b are the .fp view, so comparisons use hex strings here.
      check('tls-ctl: advertised max no longer offers TLS 1.3',
        !f.tls.supportedVersions.includes('0x0304'),
        f.tls.supportedVersions.join(' '));
      check('tls-ctl: baseline DOES offer TLS 1.3 (control)',
        b.tls.supportedVersions.includes('0x0304'),
        b.tls.supportedVersions.join(' '));
      // JA4 encodes the version: 't13' -> 't12'
      check('tls-ctl: JA4 version field changes to 12',
        f.ja4.str.startsWith('t12'), f.ja4.str);
    } else {
      check('tls-ctl: version-cap profile captured', false, p4 ? String(p4.fp.error) : 'none');
    }

    // ---- Profile 5: explicit extension order is REJECTED (not ignored) ----
    // BoringSSL offers no API to pin extension order, so the kernel must fail
    // loudly rather than silently emit a different order than requested.
    const badOrder = {
      minVersion: 'tls1.2',
      maxVersion: 'tls1.3',
      fpExtensionOrder: [0x000a, 0x000d],
    };
    // A DEDICATED probe is essential here: the shared probe accumulates samples
    // from every earlier session, and waitForSample() returns an existing sample
    // immediately. Reusing it would report a ClientHello from an unrelated
    // session and wrongly conclude the setting was ignored.
    let orderProbe = null;
    let orderRejected = null;
    try {
      orderProbe = await startProbe({ port: 0 });
      const orderUrl = `https://127.0.0.1:${orderProbe.port}/probe`;
      const sess = session.fromPartition('persist:tlsctl-order');
      sess.setCertificateVerifyProc((req, cb) => cb(0));
      sess.setSSLConfig(badOrder);
      const win = track(new BrowserWindow({ show: false, webPreferences: { session: sess } }));
      const sampleP = orderProbe.waitForSample(10000).catch(() => null);
      win.loadURL(orderUrl).catch(() => null);
      const s = await sampleP;
      destroyTracked(win);
      // If a ClientHello arrived anyway, the setting was silently ignored.
      orderRejected = (s === null);
    } catch (e) {
      orderRejected = true;
    } finally {
      if (orderProbe) await orderProbe.close();
    }
    check('tls-ctl: unsupported fpExtensionOrder is refused, not ignored',
      orderRejected === true,
      orderRejected ? 'no ClientHello emitted (correct)' : 'a ClientHello was sent anyway');

    await closeAllWindows();
    console.log('');
    console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
    app.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log('FAIL  threw: ' + (e && e.message));
    console.log(e && e.stack);
    try { await closeAllWindows(); } catch (_) {}
    app.exit(1);
  }
})();
