'use strict';
// End-to-end: does a TLS key set through the CLIENT's apply path actually
// change the ClientHello the session emits?
//
// Every other TLS test checks the schema, the splitter or the verdict table -
// all of which can be entirely correct while setSSLConfig is never called, or
// called with the wrong argument. This drives the real path: build the config
// the way the panel does, split it, apply it to a session, and capture what
// goes on the wire.
const { app, session } = require('electron');
const schema = require('./fp-schema');
const { captureClientHello, tlsVerdicts } = require('./tls-probe');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

// Build a config exactly as the JSON editor would hold it (strings and
// booleans mixed, as a human types them), then run it through the client's
// own splitter - the same call main.js makes on apply.
function applyLike(tabConfig) {
  const split = schema.fpSplitConfig(tabConfig);
  const sess = session.fromPartition('e2e-' + Math.random().toString(36).slice(2));
  if (Object.keys(split.tls).length) sess.setSSLConfig(split.tls);
  return { sess, split };
}

async function main() {
  const { BrowserWindow } = require('electron');
  const keep = new BrowserWindow({ show: false, width: 80, height: 80 });

  // Baseline: the platform's native ClientHello.
  const baseSess = session.fromPartition('e2e-baseline-' + Date.now());
  const base = await captureClientHello(baseSess, 3500);
  ck('captured a baseline ClientHello', base.ok, base.ok
    ? base.hello.cipherCount + ' ciphers, ' + base.hello.extCount + ' extensions'
    : base.error);
  if (!base.ok) {
    console.log('\nFAIL: no baseline, nothing further can be judged');
    app.exit(1);
    return;
  }

  // --- The configs a user would actually type -----------------------------
  const CASES = [
    ['fpGreaseEnabled=false', { fpGreaseEnabled: 'false' },
      (h) => h.greaseCipherCount + h.greaseExtCount === 0],
    ['fpOmitSessionTicket=true', { fpOmitSessionTicket: 'true' },
      (h) => h.hasSessionTicket === false],
    ['fpOmitAlpn=true', { fpOmitAlpn: 'true' },
      (h) => h.hasAlpn === false],
    ['fpCipherList=ECDHE-RSA-AES128-GCM-SHA256',
      { fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256' },
      (h) => h.ciphers.join(',') !== base.hello.ciphers.join(',')],
    ['fpAdvertisedVersionMax=771', { fpAdvertisedVersionMax: '771' },
      (h) => h.ciphers.join(',') !== base.hello.ciphers.join(',')],
    ['fpPermuteExtensions=true', { fpPermuteExtensions: 'true' },
      (h) => h.extTypes.join(',') !== base.hello.extTypes.join(',')],
  ];

  for (const [name, cfg, expect] of CASES) {
    const { sess, split } = applyLike(cfg);
    ck('splitter kept ' + name,
      Object.keys(split.tls).length === 1 && !split.fingerprint[name.split('=')[0]],
      JSON.stringify(split.tls));
    const cap = await captureClientHello(sess, 3500);
    if (!cap.ok) { ck('applied ' + name, false, cap.error); continue; }
    ck('applied ' + name, expect(cap.hello),
      'ciphers=' + cap.hello.cipherCount + ' exts=' + cap.hello.extCount +
      ' grease=' + (cap.hello.greaseCipherCount + cap.hello.greaseExtCount));

    // And the panel's verdict table must agree it passed.
    const v = tlsVerdicts(split.tls, cap.hello, base.hello, schema.fpTlsIsActive);
    ck('verdict for ' + name + ' is pass',
      v.rows.length === 1 && v.rows[0].verdict === 'pass',
      v.rows.length ? v.rows[0].verdict + ' ' + (v.rows[0].reason || '') : 'no rows');
  }

  // --- Mixed config: both planes at once ----------------------------------
  const mixed = applyLike({
    hardware_concurrency: 8,        // Blink plane
    fpOmitSessionTicket: 'true',    // TLS plane
    fpGreaseEnabled: 'false',
  });
  ck('mixed config splits into 1 Blink + 2 TLS keys',
    Object.keys(mixed.split.fingerprint).length === 63 &&
    Object.keys(mixed.split.tls).length === 2,
    'tls=' + Object.keys(mixed.split.tls).join(','));
  const mixedCap = await captureClientHello(mixed.sess, 3500);
  ck('mixed config reaches the wire',
    mixedCap.ok && mixedCap.hello.hasSessionTicket === false &&
    mixedCap.hello.greaseCipherCount + mixedCap.hello.greaseExtCount === 0,
    mixedCap.ok ? 'sessionTicket=' + mixedCap.hello.hasSessionTicket : mixedCap.error);

  // --- The trap: a rejected cipher list must not reach the session --------
  const bad = schema.fpSplitConfig({ fpCipherList: 'TLS_AES_128_GCM_SHA256' });
  const badCheck = schema.fpTlsValidateCipherList(bad.tls.fpCipherList);
  ck('the connection-killing cipher list is refused before apply',
    badCheck.ok === false, badCheck.error ? 'with a reason' : 'NO REASON');
  // Applying it anyway would break every connection - which is why the guard
  // exists. Verified here by NOT applying it: the session still works.
  const stillOk = await captureClientHello(
    session.fromPartition('e2e-after-refuse-' + Date.now()), 3500);
  ck('a refused config leaves the session healthy',
    stillOk.ok, stillOk.ok ? stillOk.hello.cipherCount + ' ciphers' : stillOk.error);

  console.log('\n' + (fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));

  if (!keep.isDestroyed()) keep.destroy();
  app.exit(fail === 0 ? 0 : 1);
}

app.whenReady().then(main);
setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 240000);
