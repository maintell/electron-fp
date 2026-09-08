'use strict';
// Does the client's TLS table match what the kernel actually exposes, and does
// the splitter route each key to the right delivery plane?
//
// The bug this file exists to prevent: the 9 TLS keys were implemented in the
// kernel and exposed via session.setSSLConfig() while the client exposed none
// of them - no schema entry, no group, no UI, no self-test. Nothing failed.
// The gap was invisible because no test compared the two sides.
const fs = require('fs');
const path = require('path');
const schema = require('./fp-schema');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

let pass = 0, fail = 0, skip = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

// --- 1. The kernel's setSSLConfig option names, read from the patch. --------
// Not hardcoded: 50-electron-glue.patch is the source of truth. If a key is
// added there and not here, this fails.
const gluePath = path.join(__dirname, '..', 'fingerprint', 'patches', '50-electron-glue.patch');
let kernelOpts = [];
if (fs.existsSync(gluePath)) {
  const glue = fs.readFileSync(gluePath, 'utf8');
  const set = new Set();
  const re = /options\.Get\(\s*"(fp[A-Za-z0-9]+)"/g;
  let m;
  while ((m = re.exec(glue)) !== null) set.add(m[1]);
  kernelOpts = [...set].sort();
} else {
  console.log('SKIP  kernel option list (50-electron-glue.patch not present here)');
  skip++;
}

const clientOpts = schema.FP_TLS_KEY_NAMES.slice().sort();

ck('client TLS table is not empty', clientOpts.length > 0, clientOpts.length + ' keys');
if (kernelOpts.length) {
  ck('client TLS keys == kernel setSSLConfig options',
    JSON.stringify(clientOpts) === JSON.stringify(kernelOpts),
    'client=' + clientOpts.join(',') + '  kernel=' + kernelOpts.join(','));
}

// --- 2. Every TLS key carries the metadata the UI needs. -------------------
for (const k of clientOpts) {
  const e = schema.FP_TLS_KEYS[k];
  ck('TLS key ' + k + ' has kind/def/label/hint',
    !!e && typeof e.kind === 'string' && e.def !== undefined &&
      typeof e.label === 'string' && typeof e.hint === 'string' && e.hint.length > 20,
    e ? 'kind=' + e.kind : 'MISSING');
}

// --- 3. The two planes must stay SEPARATE. ---------------------------------
// This is the invariant that makes the whole design work. If a TLS key ever
// lands in FP_KEYS, fpNormalizeConfig() will happily "normalize" it into the
// --fingerprint-config blob, where the kernel ignores it silently.
const overlap = clientOpts.filter((k) => Object.prototype.hasOwnProperty.call(schema.FP_KEYS, k));
ck('no TLS key is also a Blink key', overlap.length === 0, overlap.join(', ') || 'none');
ck('FP_KEYS is still exactly 63',
  Object.keys(schema.FP_KEYS).length === 63, String(Object.keys(schema.FP_KEYS).length));

// --- 4. fpSplitConfig routes each key to the correct plane. ----------------
const all = {};
for (const k of clientOpts) all[k] = (schema.FP_TLS_KEYS[k].kind === 'bool') ? true : 'x';
all.hardware_concurrency = 8;
const split = schema.fpSplitConfig(all);

for (const k of clientOpts) {
  ck('split routes ' + k + ' to the TLS plane',
    Object.prototype.hasOwnProperty.call(split.tls, k) &&
    !Object.prototype.hasOwnProperty.call(split.fingerprint, k),
    'tls=' + JSON.stringify(split.tls[k]));
}
ck('split routes Blink keys to the fingerprint plane',
  split.fingerprint.hardware_concurrency === 8,
  'hardware_concurrency=' + split.fingerprint.hardware_concurrency);
ck('split reports unknown keys rather than dropping them silently',
  JSON.stringify(schema.fpSplitConfig({ nope_key: 1 }).unknown) === '["nope_key"]',
  JSON.stringify(schema.fpSplitConfig({ nope_key: 1 }).unknown));

// --- 5. THE trap: fpNormalizeConfig alone would destroy every TLS key. ------
// This is the assertion that would have caught the original gap.
const normalized = schema.fpNormalizeConfig(all);
const lost = clientOpts.filter((k) =>
  !Object.prototype.hasOwnProperty.call(normalized.config, k));
ck('fpNormalizeConfig() would drop all TLS keys (so it must not be used alone)',
  lost.length === clientOpts.length,
  'dropped ' + lost.length + '/' + clientOpts.length);
const splitKept = clientOpts.filter((k) =>
  Object.prototype.hasOwnProperty.call(split.tls, k));
ck('fpSplitConfig() preserves all TLS keys',
  splitKept.length === clientOpts.length,
  'kept ' + splitKept.length + '/' + clientOpts.length);

// --- 6. Coercion produces the types the gin converter demands. -------------
// The converter uses typed Get(), so a string where a bool is expected throws.
ck('bool coerces "false" -> false', schema.fpTlsCoerce('fpGreaseEnabled', 'false') === false);
ck('bool coerces "true" -> true', schema.fpTlsCoerce('fpGreaseEnabled', 'true') === true);
ck('bool coerces real true -> true', schema.fpTlsCoerce('fpGreaseEnabled', true) === true);
ck('int coerces "771" -> 771', schema.fpTlsCoerce('fpAdvertisedVersionMax', '771') === 771);
ck('u16list parses "1027,1283" -> [1027,1283]',
  JSON.stringify(schema.fpTlsCoerce('fpSignatureAlgorithms', '1027,1283')) === '[1027,1283]');
ck('u16list parses hex "0x0403,0x0503" -> [1027,1283]',
  JSON.stringify(schema.fpTlsCoerce('fpSignatureAlgorithms', '0x0403,0x0503')) === '[1027,1283]');
ck('u16list accepts a real array',
  JSON.stringify(schema.fpTlsCoerce('fpExtensionOrder', [0, 11, 10])) === '[11,10]',
  'note: 0 is dropped as a sentinel, not a real type');
ck('u16list clamps above 0xffff',
  JSON.stringify(schema.fpTlsCoerce('fpExtensionOrder', [70000, 5])) === '[65535,5]');

// --- 7. The TLS 1.3 cipher-name trap. ------------------------------------
// Measured: setSSLConfig accepts these, BoringSSL rejects the whole command,
// and every request on the session fails with net::ERR_UNEXPECTED.
for (const bad of ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256']) {
  const r = schema.fpTlsValidateCipherList(bad);
  ck('rejects the connection-killing name ' + bad, r.ok === false, r.error ? 'has a reason' : 'NO REASON');
}
ck('rejects a list containing one bad name',
  schema.fpTlsValidateCipherList('ECDHE-RSA-AES128-GCM-SHA256:TLS_AES_128_GCM_SHA256').ok === false);
ck('accepts TLS 1.2 names',
  schema.fpTlsValidateCipherList('ECDHE-RSA-AES128-GCM-SHA256').ok === true);
ck('accepts a colon-separated TLS 1.2 pair',
  schema.fpTlsValidateCipherList('ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384').ok === true);
ck('accepts empty (means "not configured")',
  schema.fpTlsValidateCipherList('').ok === true);
// Deliberately NOT rejecting unknown names: a whitelist would go stale and
// then reject working values. Only the measured foot-gun is caught.
ck('does not reject unknown-but-shaped names (whitelist would go stale)',
  schema.fpTlsValidateCipherList('NOT_A_CIPHER').ok === true);
ck('the rejection message names a working alternative',
  /ECDHE-RSA-AES128-GCM-SHA256/.test(schema.fpTlsValidateCipherList('TLS_AES_128_GCM_SHA256').error));

// --- 8. main.js actually calls setSSLConfig. ------------------------------
ck('main.js calls session.setSSLConfig', /setSSLConfig\s*\(/.test(main));
ck('main.js validates fpCipherList before applying it',
  /fpTlsValidateCipherList/.test(main));
ck('main.js uses fpSplitConfig (not fpNormalizeConfig alone) on apply',
  /fpSplitConfig\(config\)/.test(main));
ck('main.js requires tls-probe', /require\(['"]\.\/tls-probe['"]\)/.test(main));
ck('main.js applies TLS before the view is constructed',
  main.indexOf('applyTabTLSConfig(partition') < main.indexOf('new BrowserView'));

// --- 9. The UA-precedent callers must preserve the TLS config. ------------
// recreateTabView() resets whatever it is handed, so a caller that omits the
// TLS arg silently wipes the profile.
// The call spans two lines, so match across newlines.
// The HTTP/2 plane is now a sixth argument: it cannot actually change on a live
// tab, but passing tab.h2 is what lets recreateTabView() DETECT a mismatch and
// report it instead of silently ignoring the request.
ck('tab:set-ua passes the live TLS config through',
  /recreateTabView\(tid,[^;]*?tab\.tls \|\| null/s.test(main));
ck('tab:set-ua also passes the HTTP/2 config (so drift is reported)',
  /recreateTabView\(tid,[^;]*?tab\.tls \|\| null,\s*tab\.h2 \|\| null\)/s.test(main));

console.log('\n' + (fail === 0
  ? 'PASS: ' + pass + ' checks, ' + skip + ' skipped'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));
process.exit(fail === 0 ? 0 : 1);
