// Wire-level proof for the three TLS controls that had NO test at all.
//
// Found by listing every fp* field the README declares implemented and grepping
// the test files for each: fpCipherList / fpGreaseEnabled / fpGreaseSigalgs /
// fpOmitSessionTicket / fpAdvertisedVersionMax / fpExtensionOrder are covered by
// test-tls-control.js, but these three appear in NO test file:
//
//   fpPermuteExtensions   extension-order randomisation toggle
//   fpSignatureAlgorithms replaces the signature-algorithm preference list
//   fpOmitAlpn            removes the ALPN extension
//
// "Implemented" and "proven on the wire" have already diverged in this project
// (setHttp2Profile was fully wired and silently did nothing), so absence of a
// test is not a documentation gap - it is unverified behaviour.
//
// Discipline inherited from test-tls-control.js:
//   1. Discard the first handshake of every session (GREASE is randomised).
//   2. Use a dedicated probe per assertion rather than a shared one.
//   3. Assert on the raw field, not just the derived hash.
//
// fpPermuteExtensions is a TOGGLE for randomisation, so a single sample cannot
// prove it: permuted order is still a valid random-looking order. It is asserted
// by comparing the ORDER across repeated handshakes with the toggle on versus
// off, and reported honestly if the sample cannot distinguish them.

'use strict';

const { app, BrowserWindow, session } = require('electron');
const { startProbe } = require('./tls/tls-probe.js');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) {
    skip++;
    console.log('SKIP  ' + name + (detail ? ': ' + detail : ''));
    return;
  }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const liveWindows = new Set();
function track(win) { liveWindows.add(win); return win; }
async function closeAllWindows() {
  for (const w of [...liveWindows]) {
    liveWindows.delete(w);
    try {
      if (!w.isDestroyed()) { w.webContents.destroy(); w.destroy(); }
    } catch (_) { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 400));
}

const ALPN_EXT = '0x0010';

// fingerprint() does NOT expose raw extTypes - only `extensions`, an array of
// hex STRINGS. Compare on the string form; parseInt'ing and comparing numbers
// silently produces false negatives here (the same class of bug as the
// cipherSuites hex-string trap noted in test-tls-control.js).
const extHas = (fp, hexStr) => Array.isArray(fp.extensions) && fp.extensions.includes(hexStr);

// RFC 8701 GREASE values: 0x?a?a where both bytes are equal and the low nibble
// of each is 0xa. Chromium inserts these at random positions per handshake, so
// they must be excluded before any order comparison.
function isGreaseHex(h) {
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return false;
  return (n & 0x0f0f) === 0x0a0a && ((n >> 8) & 0xff) === (n & 0xff);
}

async function capture(partition, sslConfig, url, probe) {
  const sess = session.fromPartition('persist:' + partition);
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
  return s;
}

/** Warm-up discarded, then the comparable stable sample. */
async function measure(partition, sslConfig, url, probe) {
  await capture(partition + '-warm', sslConfig, url, probe);
  return capture(partition, sslConfig, url, probe);
}

(async () => {
  try {
    await app.whenReady();
    // ALPN is only emitted when the server offers it, so this probe MUST be
    // constructed with an alpn list or fpOmitAlpn is untestable: with no ALPN
    // on either side, "removed" and "never sent" are indistinguishable. Verified:
    // the default probe left baseline alpn === undefined.
    const probe = await startProbe({ port: 0, alpn: ['h2', 'http/1.1'] });
    const url = `https://127.0.0.1:${probe.port}/probe`;

    // ---------- baseline ----------------------------------------------------
    const base = await measure('tlsmore-base', null, url, probe);
    if (!base || !base.fp || base.fp.error) {
      check('tls-more: baseline captured', false, base ? String(base.fp.error) : 'none');
      await probe.close();
      await closeAllWindows();
      app.exit(1);
      return;
    }
    const b = base.fp;
    // alpn lives under .tls, not at top level.
    const bAlpn = b.tls && b.tls.alpn;
    console.log('\n--- baseline (no profile) ---');
    console.log('JA4=' + b.ja4.str + '  exts=' + b.extensionCount +
      '  sigalgs=' + (b.signatureAlgorithms || []).length +
      '  alpn=' + JSON.stringify(bAlpn));

    check('tls-more: baseline captured', true, 'JA4=' + b.ja4.str);
    check('tls-more: baseline DOES send ALPN (control)',
      Array.isArray(bAlpn) && bAlpn.length > 0, JSON.stringify(bAlpn));
    check('tls-more: baseline DOES send signature_algorithms (control)',
      Array.isArray(b.signatureAlgorithms) && b.signatureAlgorithms.length > 0,
      (b.signatureAlgorithms || []).length + ' entries');

    // ---------- fpOmitAlpn --------------------------------------------------
    {
      const p = await measure('tlsmore-noalpn', { fpOmitAlpn: true }, url, probe);
      if (!p || !p.fp || p.fp.error) {
        check('tls-more: fpOmitAlpn profile captured', false,
          p ? String(p.fp.error) : 'none');
      } else {
        const f = p.fp;
        const fAlpn = f.tls && f.tls.alpn;
        const hadAlpn = extHas(b, ALPN_EXT);
        const hasAlpn = extHas(f, ALPN_EXT);
        check('tls-more: fpOmitAlpn removes the ALPN extension',
          hadAlpn && !hasAlpn,
          'baseline had ALPN ext=' + hadAlpn + ', profile has ALPN ext=' + hasAlpn +
            ' (alpn lists: baseline ' + JSON.stringify(bAlpn) +
            ' vs profile ' + JSON.stringify(fAlpn) + ')');
        check('tls-more: fpOmitAlpn moves JA3',
          f.ja3.hash !== b.ja3.hash, f.ja3.hash + ' vs ' + b.ja3.hash);
        // Removing an extension MUST shrink the list. The exact delta is NOT
        // asserted as 1: measured 17 -> 15 (two fewer), because ALPN removal
        // also drops a dependent extension. Pinning a guess would have produced
        // a false failure here; assert the direction and name the observed
        // numbers so a future change is still visible.
        check('tls-more: fpOmitAlpn shrinks the extension count',
          f.extensionCount < b.extensionCount,
          f.extensionCount + ' vs baseline ' + b.extensionCount);
      }
    }

    // ---------- fpSignatureAlgorithms ---------------------------------------
    {
      // A deliberately narrow, recognisable list. Code points are standard:
      //   0x0804 rsa_pss_rsae_sha256
      //   0x0403 ecdsa_secp256r1_sha256
      //   0x0201 rsa_pkcs1_sha1
      const want = [0x0804, 0x0403, 0x0201];
      // MUST be an ARRAY OF NUMBERS. The gin converter reads
      // std::vector<uint16_t>; a comma-separated STRING fails conversion, and
      // the failure aborts the whole setSSLConfig call - not just this field.
      // Verified: passing '0x0804,0x0403,0x0201' throws
      // "Error processing argument at index 0, conversion failure".
      const p = await measure('tlsmore-sigalgs',
        { fpSignatureAlgorithms: want }, url, probe);
      if (!p || !p.fp || p.fp.error) {
        check('tls-more: fpSignatureAlgorithms profile captured', false,
          p ? String(p.fp.error) : 'none');
      } else {
        const f = p.fp;
        console.log('\n--- profile: fpSignatureAlgorithms ---');
        console.log('sigalgs on wire: ' + JSON.stringify(f.signatureAlgorithms));
        const got = (f.signatureAlgorithms || []).map((v) =>
          typeof v === 'string' ? parseInt(v, 16) : v);
        check('tls-more: fpSignatureAlgorithms replaces the list (not appends)',
          got.length > 0 && got.length < (b.signatureAlgorithms || []).length,
          got.length + ' vs baseline ' + (b.signatureAlgorithms || []).length);
        // The list we asked for must be a SUBSET of what went out, otherwise
        // the field was parsed but ignored.
        const allPresent = want.every((w) => got.includes(w));
        check('tls-more: every requested sigalg appears on the wire',
          allPresent,
          'want ' + want.map((w) => '0x' + w.toString(16)).join(' ') +
            ' got ' + got.map((w) => '0x' + w.toString(16)).join(' '));
        check('tls-more: fpSignatureAlgorithms moves JA3',
          f.ja3.hash !== b.ja3.hash, f.ja3.hash + ' vs ' + b.ja3.hash);
      }
    }

    // ---------- fpPermuteExtensions -----------------------------------------
    {
      // A toggle for RANDOMISATION cannot be proven from one sample. Compare
      // the observed extension ORDER across repeated handshakes: with the
      // toggle OFF the order should be stable; with it ON, Chromium's default
      // permute is already on, so turning it off is the discriminating case.
      async function orderSamples(cfg, tag, n) {
        const orders = [];
        for (let i = 0; i < n; i++) {
          const s = await measure(tag + i, cfg, url, probe);
          if (s && s.fp && !s.fp.error && Array.isArray(s.fp.extensions)) {
            orders.push(s.fp.extensions.join(','));
          }
        }
        return orders;
      }
      const offOrders = await orderSamples({ fpPermuteExtensions: false },
        'tlsmore-permoff', 3);
      const distinctOff = new Set(offOrders).size;
      console.log('\n--- profile: fpPermuteExtensions=false ---');
      offOrders.forEach((o, i) => console.log('  order[' + i + ']: ' + o));

      // GREASE extensions are inserted at RANDOM POSITIONS with random values
      // each handshake. That alone makes raw orders differ, so "distinct orders"
      // does NOT by itself prove permutation is still on. Strip GREASE values
      // and compare the order of the REAL extensions - that is the quantity
      // fpPermuteExtensions controls.
      const strip = (o) => o.split(',').filter((h) => !isGreaseHex(h)).join(',');
      const offStripped = offOrders.map(strip);
      const distinctStripped = new Set(offStripped).size;
      console.log('  GREASE-stripped orders: ' + distinctStripped + ' distinct');
      offStripped.forEach((o, i) => console.log('  stripped[' + i + ']: ' + o));

      // CONTROL: with permutation ON (Chromium default) the real-extension
      // order must VARY between handshakes. Without this control, "1 distinct
      // stripped order" would also be satisfied by a test that measures nothing
      // (e.g. if the orders were all empty). It proves the assertion above has
      // teeth.
      const onOrders = await orderSamples({ fpPermuteExtensions: true },
        'tlsmore-permon', 3);
      const onStripped = onOrders.map(strip);
      const distinctOn = new Set(onStripped).size;
      console.log('  permute=ON stripped: ' + distinctOn + ' distinct of ' +
        onStripped.length);

      if (offOrders.length < 2) {
        check('tls-more: fpPermuteExtensions sampled', null,
          'not enough samples (' + offOrders.length + ') to judge');
      } else if (onStripped.length >= 2 && distinctOn === 1) {
        // permute=ON produced a stable order too, so the ON/OFF comparison
        // cannot discriminate here. Say so rather than reporting a hollow pass.
        check('tls-more: permute ON/OFF discriminates', null,
          'both ON and OFF gave a stable order (' + distinctOn +
            '); ext order may be fixed by this Chromium build regardless');
      } else {
        // With permutation OFF the order of the REAL (non-GREASE) extensions
        // must be repeatable. If the setting were ignored, Chromium's default
        // permute would keep reshuffling them.
        check('tls-more: fpPermuteExtensions=false makes real ext order stable',
          distinctStripped === 1,
          distinctStripped + ' distinct real order(s) across ' +
            offOrders.length + ' handshakes (raw incl. GREASE: ' +
            distinctOff + ')');
        // The ON control must actually vary, otherwise the previous assertion
        // proves nothing about the setting.
        if (onStripped.length >= 2) {
          check('tls-more: permute=ON control DOES vary (assertion has teeth)',
            distinctOn > 1,
            'ON: ' + distinctOn + ' distinct vs OFF: ' + distinctStripped);
        }
      }
    }

    await probe.close();
    await closeAllWindows();
  } catch (e) {
    check('tls-more: run completed without throwing', false, String(e && e.message));
    try { await closeAllWindows(); } catch (_) {}
  }

  console.log('');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks' + (skip ? ' (' + skip + ' skipped)' : '')
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
  app.exit(fail === 0 ? 0 : 1);
})();
