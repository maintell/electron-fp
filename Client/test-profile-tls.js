'use strict';
// A profile that names a browser must not emit Chromium's native ClientHello.
//
// The bug: all 4 preset profiles set 29-31 Blink keys each and ZERO TLS keys.
// "macOS / Safari-like" therefore announced itself as Safari on every surface
// the page can see while the network layer still said Chromium - and JA3/JA4 is
// the single most browser-distinguishing signal there is. Nothing caught it
// because no test compared a profile's LABEL to what it puts on the wire.
//
// This file asserts the connection in both directions:
//   * every non-default profile sets at least one TLS key
//   * each profile's TLS shape matches its claimed browser family
//   * the default profile stays native passthrough (it is the self-test baseline)
const path = require('path');
const fs = require('fs');
const schema = require('./fp-schema');
const { captureClientHello } = require('./tls-probe');
const { app, session } = require('electron');

let pass = 0, fail = 0, skip = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};
const sk = (n, why) => { console.log('SKIP  ' + n + '  (' + why + ')'); skip++; };

// The TLS keys, recognised by camelCase - they are the only keys in a profile's
// fingerprint object that travel by session.setSSLConfig() instead of
// --fingerprint-config.
const isTlsKey = (k) => /^fp[A-Z]/.test(k);

// What each profile claims, and the assertion that claim implies.
// Every assertion is grounded in a measurement on this kernel:
//   * fpGreaseEnabled is the clean browser-family signal (Chromium GREASEs per
//     RFC 8701, WebKit and NSS do not). Verified stable 6/6 either way.
//   * fpAdvertisedVersionMax=771 is the ONLY way to drop the TLS 1.3 suites -
//     fpCipherList cannot remove 1301/1302/1303, measured.
const CLAIMS = {
  'win10-chrome': {
    family: 'Chromium',
    check: (h) => h.greaseCipherCount + h.greaseExtCount > 0,
    why: 'Chromium GREASEs (RFC 8701)',
  },
  'mobile-android': {
    family: 'Chromium',
    check: (h) => h.greaseCipherCount + h.greaseExtCount > 0,
    why: 'mobile Chromium GREASEs too',
  },
  'macos-safari': {
    family: 'WebKit',
    check: (h) => h.greaseCipherCount + h.greaseExtCount === 0,
    why: 'WebKit does not implement GREASE',
  },
  'linux-firefox': {
    family: 'NSS/Firefox',
    check: (h) => h.greaseCipherCount + h.greaseExtCount === 0 &&
      !h.ciphers.includes('1301') && !h.ciphers.includes('1302') &&
      !h.ciphers.includes('1303'),
    why: 'NSS does not GREASE; fpAdvertisedVersionMax=771 drops the TLS 1.3 suites',
  },
};

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  const keep = new BrowserWindow({ show: false, width: 80, height: 80 });

  const profilesPath = path.join(__dirname, 'profiles.json');
  if (!fs.existsSync(profilesPath)) {
    sk('profile TLS coherence', 'profiles.json not present');
    console.log('\nPASS: ' + pass + ' checks, ' + skip + ' skipped');
    app.exit(0);
    return;
  }
  const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')).profiles;

  for (const pr of profiles) {
    const fp = pr.fingerprint || {};
    const tlsKeys = Object.keys(fp).filter(isTlsKey);

    // The default profile must stay native: it is the baseline the self-test
    // compares a configured profile against.
    if (pr.id === 'default') {
      ck('default profile stays native passthrough (self-test baseline)',
        tlsKeys.length === 0, tlsKeys.join(', ') || 'no TLS keys');
      continue;
    }

    // 1. It must configure the TLS plane at all.
    ck(pr.id + ' configures the TLS plane', tlsKeys.length > 0,
      tlsKeys.length ? tlsKeys.join(', ') : 'ZERO - claims ' + pr.id + ', emits Chromium');

    // 2. Every TLS key it sets must be one the kernel actually reads.
    const unknown = tlsKeys.filter((k) => !schema.FP_TLS_KEYS[k]);
    ck(pr.id + ' sets only real TLS keys', unknown.length === 0,
      unknown.join(', ') || tlsKeys.length + ' keys');

    // 3. The wire must agree with the label.
    const claim = CLAIMS[pr.id];
    if (!claim) {
      sk(pr.id + ' shape assertion', 'no claim recorded for this profile');
      continue;
    }
    const split = schema.fpSplitConfig(fp);
    ck(pr.id + ' TLS keys survive fpSplitConfig',
      Object.keys(split.tls).length === tlsKeys.length,
      Object.keys(split.tls).length + '/' + tlsKeys.length);

    const sess = session.fromPartition('pt-' + Math.random().toString(36).slice(2));
    try { sess.setSSLConfig(split.tls); }
    catch (e) { ck(pr.id + ' shape matches "' + claim.family + '"', false,
      'setSSLConfig threw: ' + e.message); continue; }

    const cap = await captureClientHello(sess, 3500);
    if (!cap.ok) { ck(pr.id + ' shape matches "' + claim.family + '"', false,
      'capture failed: ' + cap.error); continue; }
    ck(pr.id + ' shape matches "' + claim.family + '" (' + claim.why + ')',
      claim.check(cap.hello),
      'grease=' + (cap.hello.greaseCipherCount + cap.hello.greaseExtCount) +
      ' ext=' + cap.hello.extCount +
      ' tls13=' + (cap.hello.ciphers.includes('1301') ? 'yes' : 'no'));
  }

  console.log('\n' + (fail === 0
    ? 'PASS: ' + pass + ' checks, ' + skip + ' skipped'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));

  if (!keep.isDestroyed()) keep.destroy();
  app.exit(fail === 0 ? 0 : 1);
});
setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 240000);
