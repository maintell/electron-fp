'use strict';
// A TLS value of the wrong JS type must be refused, not silently ignored.
//
// The kernel reads every TLS key with options.Get(key, &out). That returns
// FALSE on a type mismatch and then simply SKIPS THE KEY - no throw, no warning,
// no log. The value is dropped and the session keeps its native shape, so the
// UI shows a profile as applied while nothing changed. Measured:
//
//   fpGreaseEnabled: 1                 -> no error, GREASE still 3 (native)
//   fpAdvertisedVersionMax: "771"      -> no error, still offers TLS 1.3
//   ...while the correct types DO apply (grease=0, ciphers 16 -> 13).
//
// The two u16list keys are the loud case: they throw, but with "Error processing
// argument at index 0, conversion failure from ", naming neither the key nor
// the type it wanted. So the failure is either silent or undiagnosable.
//
// This is the same class as FpConfigString's silent truncation: a config that
// looks applied and is not. fpSplitConfig() already coerces, so configs coming
// through the app are safe; this guards the direct setSSLConfig() caller and
// makes a wrong type loud either way.
const fs = require('fs');
const path = require('path');
const schema = require('./fp-schema');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

// --- the validator itself ---------------------------------------------------
ck('fpTlsValidateTypes is exported',
  typeof schema.fpTlsValidateTypes === 'function');

const CASES = [
  ['u16list given a CSV string', { fpExtensionOrder: '0,23,65281' }, 'fpExtensionOrder'],
  ['u16list given a number', { fpSignatureAlgorithms: 1027 }, 'fpSignatureAlgorithms'],
  ['bool given a number', { fpGreaseEnabled: 1 }, 'fpGreaseEnabled'],
  ['bool given a string', { fpOmitAlpn: 'true' }, 'fpOmitAlpn'],
  ['int given a string', { fpAdvertisedVersionMax: '771' }, 'fpAdvertisedVersionMax'],
  ['cipherlist given an array', { fpCipherList: ['ECDHE-RSA-AES128-GCM-SHA256'] }, 'fpCipherList'],
  ['a name that is not a TLS key', { fpNonsense: 1 }, 'fpNonsense'],
];

for (const [name, cfg, key] of CASES) {
  const r = schema.fpTlsValidateTypes(cfg);
  ck('refused: ' + name, r.ok === false, r.ok ? 'ACCEPTED - would be silently ignored' : '');
  ck('  names the offending key (' + key + ')',
    !r.ok && r.error.includes(key) && r.bad.some((b) => b.key === key));
  ck('  says what type it wanted', !r.ok && /wants an? /.test(r.error));
}

// --- correct types must still pass ------------------------------------------
const GOOD = [
  { fpGreaseEnabled: true },
  { fpGreaseSigalgsEnabled: false },
  { fpPermuteExtensions: true },
  { fpOmitAlpn: true },
  { fpOmitSessionTicket: false },
  { fpAdvertisedVersionMax: 771 },
  { fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256' },
  { fpExtensionOrder: [23, 65281] },
  { fpSignatureAlgorithms: [1027, 1025] },
];
for (const g of GOOD) {
  const k = Object.keys(g)[0];
  const r = schema.fpTlsValidateTypes(g);
  ck('accepted: ' + k + ' = ' + JSON.stringify(g[k]), r.ok === true,
    r.ok ? '' : r.error.slice(0, 70));
}
ck('an empty TLS object is accepted', schema.fpTlsValidateTypes({}).ok === true);
ck('all 9 TLS keys with correct types are accepted together',
  schema.fpTlsValidateTypes(Object.assign({}, ...GOOD)).ok === true);

// --- the coerce path must produce accepted types ---------------------------
// fpTlsCoerce is what fpSplitConfig() runs, so anything it emits must pass.
const COERCE = [
  ['fpExtensionOrder', '0,23,65281'],
  ['fpExtensionOrder', '0x0017,0xff01'],
  ['fpSignatureAlgorithms', '1027,1025'],
  ['fpAdvertisedVersionMax', '771'],
  ['fpGreaseEnabled', 'true'],
  ['fpGreaseEnabled', true],
  ['fpCipherList', 'ECDHE-RSA-AES128-GCM-SHA256'],
];
for (const [k, v] of COERCE) {
  const out = schema.fpTlsCoerce(k, v);
  const r = schema.fpTlsValidateTypes({ [k]: out });
  ck('fpTlsCoerce(' + k + ', ' + JSON.stringify(v) + ') yields an accepted type',
    r.ok === true, r.ok ? JSON.stringify(out) : r.error.slice(0, 80));
}

// --- main.js must actually call it ------------------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
ck('main.js imports fpTlsValidateTypes', /fpTlsValidateTypes/.test(mainSrc));
ck('applyTabTLSConfig runs the type check BEFORE setSSLConfig',
  (() => {
    const i = mainSrc.indexOf('function applyTabTLSConfig');
    const body = mainSrc.slice(i, mainSrc.indexOf('\nfunction ', i + 10));
    const checkAt = body.indexOf('fpTlsValidateTypes');
    const setAt = body.indexOf('setSSLConfig');
    return checkAt > 0 && setAt > checkAt;
  })());

// --- the kernel really does skip a mismatched type --------------------------
// Assert the mechanism, not just our guard: options.Get() returns false.
const glue = path.join(__dirname, '..', 'fingerprint', 'patches', '50-electron-glue.patch');
if (fs.existsSync(glue)) {
  const g = fs.readFileSync(glue, 'utf8');
  const gets = (g.match(/options\.Get\("fp[A-Za-z]+"/g) || []).length;
  ck('the kernel reads all 9 TLS keys via options.Get (which skips on mismatch)',
    gets === 9, gets + ' found');
} else {
  console.log('SKIP  kernel patch not found');
}

console.log('\n' + (fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));
process.exit(fail === 0 ? 0 : 1);
