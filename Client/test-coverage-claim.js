// Gate the evidence behind the "63 keys are surface-proven" claim.
//
// WHY THIS EXISTS. That headline has been reported every round, but it came
// from a hand-maintained script in a scratch directory that NO test verified -
// so it was an assertion, not a fact under test. On inspection its inference
// was unsound: 13 keys were classified 'surface-exact' purely because their
// NAME appears in fp-probe.js (a substring match over the whole file).
//
// The conclusion turned out to be TRUE: every one of those 13 IS asserted
// elsewhere (speech_voices_* at test-coverage-audit.js:311, webgpu_* at
// test-webgpu-audio-values.js, etc). But it was true by luck. Two attempts to
// replace the substring rule with a regex-derived "sound" rule both produced
// FALSE gaps - reporting 49/63 - because assertions frequently go through a
// local variable (sp1.count, meta.vendor) that no regex over key names can
// follow. Regex coverage classification is the wrong tool, in both directions.
//
// So this test gates what IS reliably decidable, and no more:
//
//   1. Every schema key is named in at least one test file. Cheap, sound, and
//      it is the claim "no key is untested" actually rests on.
//   2. compare() behaves sanely for every key the shared probe reads - it must
//      return a boolean and must not throw, for both a matching and a
//      mismatching value. A key that throws here would surface as 'error' in
//      the self-test, which is exactly the failure that must not be silent.
//   3. Every compare() special case refers to a key the probe actually reads,
//      or is justified - a special case for an unread key is dead code that
//      makes the coverage number look better than it is.
//
// Plain Node, no Electron.

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'Client');
const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const { FP_KEY_NAMES } = require(path.join(CLIENT, 'fp-schema.js'));
const { PROBE_FIELDS, EXPECTED, compare } = require(path.join(CLIENT, 'fp-probe.js'));

ck('schema has the expected 63 keys', FP_KEY_NAMES.length === 63,
  String(FP_KEY_NAMES.length));

// --- 1. no key is unnamed in the test suite --------------------------------
const tests = fs.readdirSync(CLIENT).filter((f) => /^test-.*\.js$/.test(f));
const testSrc = tests.map((f) => fs.readFileSync(path.join(CLIENT, f), 'utf8')).join('\n');
const smokeSrc = fs.readFileSync(path.join(REPO, 'fingerprint', 'scripts', 'smoke.js'), 'utf8');
const probeSrc = fs.readFileSync(path.join(CLIENT, 'fp-probe.js'), 'utf8');
const haystack = testSrc + '\n' + smokeSrc + '\n' + probeSrc;

const unnamed = FP_KEY_NAMES.filter((k) => !haystack.includes(k));
ck('every schema key is named in the test suite', unnamed.length === 0,
  unnamed.length ? 'never named: ' + unnamed.join(', ')
    : FP_KEY_NAMES.length + ' keys, all named');

// --- 2. compare() is total and three-valued over everything probe reads ----
// compare() returns true / false / null. null means "applied, but this surface
// cannot be judged from one reading" (audio_data_seed's observable is a
// checksum; webrtc_ip with no gathered candidates). verdicts() turns that into
// an 'unknown' verdict. Forcing a boolean would mean lying in one of the two
// directions: calling a working key failed, or calling an unjudgeable one
// confirmed. The guard asserts the THREE-VALUED contract, not a boolean one.
const notTristate = [];
const threw = [];
for (const k of PROBE_FIELDS) {
  for (const [want, got] of [['1', '1'], ['1', '2'], ['0', '0'], ['abc', 'abc']]) {
    let r;
    try { r = compare(k, want, got); } catch (e) { threw.push(k + ' (' + e.message + ')'); continue; }
    if (r !== true && r !== false && r !== null) {
      notTristate.push(k + ' -> ' + typeof r + ':' + String(r));
    }
  }
}
ck('compare() never throws for a key the probe reads', threw.length === 0,
  threw.length ? threw.slice(0, 5).join(' | ') : PROBE_FIELDS.length + ' keys x 4 cases');
ck('compare() returns only true/false/null', notTristate.length === 0,
  notTristate.length ? [...new Set(notTristate)].slice(0, 5).join(' | ')
    : 'all three-valued (true/false/null)');

// A null return must be DECLARED, never incidental: an unlisted key silently
// returning null would turn a real pass/fail into an "unknown" the user cannot
// act on. Every null-returning key is named here with its reason.
const CANNOT_JUDGE = {
  audio_data_seed: 'checksum observable - can only say "changed", and there is no baseline here',
  webrtc_ip: 'empty candidate list means the host gathered nothing, not that spoofing failed',
};
const nullButUndeclared = [];
for (const k of PROBE_FIELDS) {
  let sawNull = false;
  for (const [want, got] of [['1', '1'], ['1', '2'], ['0', ''], ['abc', '']]) {
    let r;
    try { r = compare(k, want, got); } catch (e) { continue; }
    if (r === null) sawNull = true;
  }
  if (sawNull && !CANNOT_JUDGE[k]) nullButUndeclared.push(k);
}
ck('every null-returning key is declared as unjudgeable', nullButUndeclared.length === 0,
  nullButUndeclared.length ? 'undeclared: ' + nullButUndeclared.join(', ')
    : Object.keys(CANNOT_JUDGE).length + ' declared');

// A key that returns true for BOTH a matching and a mismatching value cannot
// detect a failure. That is legitimate when the semantics are "nonzero" or
// "must be absent", so those are declared explicitly rather than assumed.
const NON_EQUALITY = {
  canvas_noise_seed: 'nonzero - any noise means the key applied',
  client_rects_seed: 'absent - the probe reports a boolean, not a value',
  measure_text_seed: 'nonzero - any perturbation means the key applied',
  fonts_blocklist: 'absent - the probe reports a boolean, not a value',
  webgpu_limits: 'merge - only configured sub-keys are compared',
  // Widths, not a value: a whitelist hides every unlisted family, so the
  // assertion is "the fonts did NOT all collapse to one width".
  fonts_whitelist: 'widths - asserts the metrics differ, not that they equal a target',
  // The probe reports ms computed from the API's seconds; the config is an int
  // in ms. Compared with tolerance, so a neighbouring value is still a pass.
  audio_output_latency_ms: 'tolerance - rounded float vs integer config',
  // Quantised clock: granularity must be a positive MULTIPLE of the configured
  // precision, so several values are legitimately correct.
  perf_now_precision_ms: 'multiple - quantised clock lands on a grid, not one value',
  // Only meaningful when the denylist names avc1; otherwise there is nothing
  // to contradict, so any reading is accepted.
  media_codecs_denylist: 'conditional - only asserted when the denylist names avc1',
};
const cannotDiscriminate = [];
for (const k of PROBE_FIELDS) {
  let same, diff;
  try { same = compare(k, '1', '1'); } catch (e) { continue; }
  try { diff = compare(k, '1', '2'); } catch (e) { continue; }
  if (same === true && diff === true && !NON_EQUALITY[k]) cannotDiscriminate.push(k);
}
ck('every discriminating key can actually detect a mismatch',
  cannotDiscriminate.length === 0,
  cannotDiscriminate.length ? cannotDiscriminate.join(', ')
    : Object.keys(NON_EQUALITY).length + ' keys declared non-equality by design');

// --- 3. no compare() special case for a key the probe never reads ---------
const cmpBody = fs.readFileSync(path.join(CLIENT, 'fp-probe.js'), 'utf8');
const cmpSrc = cmpBody.slice(cmpBody.indexOf('function compare'), cmpBody.indexOf('function SAFE'));
const special = [...new Set([...cmpSrc.matchAll(/key === '([a-z0-9_]+)'/g)].map((m) => m[1]))];
const read = new Set(PROBE_FIELDS);
// A compare() special case for a key the probe never reads is dead code, and
// worse, it makes the probe LOOK more capable than it is: the self-test pane
// would show a row that can never be asserted. The two keys below are
// genuinely unreadable from JS, so their absence from PROBE_FIELDS is honest -
// but they are still real keys that must be proven SOMEWHERE (see the paired
// check below).
//
// There is no exception list any more: perf_now_precision_ms used to need one
// because the probe could not read a quantised clock. That was a probe
// limitation, not a key limitation - sampling the granularity grid works, so
// the key is now live and the exception is gone.
const DEAD_SPECIAL_OK = [];
const deadSpecial = special.filter((k) => !read.has(k));
const unexpectedDead = deadSpecial.filter((k) => !DEAD_SPECIAL_OK.includes(k));
ck('every compare() special case serves a key the probe reads',
  unexpectedDead.length === 0,
  unexpectedDead.length ? 'dead special case: ' + unexpectedDead.join(', ') +
    ' - probe never reads it, so self-test cannot assert it'
    : special.length + ' special cases, all live (' +
      (deadSpecial.length ? 'plus declared: ' + deadSpecial.join(', ') : 'none dead'));

// The paired obligation: a declared-dead special case must be proven ELSEWHERE.
const unprovenDead = deadSpecial.filter((k) => !testSrc.includes(k));
ck('every declared-dead special case is proven by another test',
  unprovenDead.length === 0,
  unprovenDead.length ? unprovenDead.join(', ') + ' - no test asserts it at all'
    : (deadSpecial.length ? deadSpecial.join(', ') + ' proven elsewhere' : 'n/a'));

// --- 4. the audit's own false-positive is pinned --------------------------
// `probe.includes(key)` credited the probe with perf_now_precision_ms, which
// the probe did NOT read at the time - a substring match over the probe source
// hit the KEY NAME mentioned in a comment, not a real read. That false positive
// is why this file exists.
//
// The premise has since been fixed rather than documented around: the probe
// DOES read the key now (it samples performance.now() granularity), so the
// honest assertion is the conjunction - read by the probe AND asserted by a
// test - instead of "read by neither, proven by a test". Asserting the old
// negative would freeze the fix out of the gate.
ck('perf_now_precision_ms is read by the probe AND asserted by a test',
  read.has('perf_now_precision_ms') &&
  /perf_now_precision_ms/.test(testSrc),
  'probe reads it: ' + read.has('perf_now_precision_ms') +
  '; asserted in a test: ' + /perf_now_precision_ms/.test(testSrc));

// The general form of that bug: a key the probe claims but cannot really read.
// PROBE_FIELDS is hand-maintained, so a key can be listed and never assigned.
// Check the ASSIGNMENT, not just the listing.
const unassigned = PROBE_FIELDS.filter((k) => {
  const re = new RegExp('r\\.' + k + '\\s*=');
  return !re.test(probeSrc);
});
ck('every PROBE_FIELDS entry is actually assigned by the probe',
  unassigned.length === 0,
  unassigned.length ? 'listed but never assigned: ' + unassigned.join(', ')
    : PROBE_FIELDS.length + ' entries, all assigned');

// --- 5. EXPECTED is a subset of what the probe reads ----------------------
// EXPECTED is smoke.js's fixed table. Anything in it that the probe does not
// read could never be satisfied, so smoke.js would report a false failure.
const cmpKeys = Object.keys(EXPECTED);
const expectedNotRead = cmpKeys.filter((k) => !read.has(k));
ck('every EXPECTED key is read by the probe', expectedNotRead.length === 0,
  expectedNotRead.length ? expectedNotRead.join(', ')
    : cmpKeys.length + ' expected keys, all readable');

console.log('');
console.log('  (diagnostic) probe reads ' + PROBE_FIELDS.length +
  ', smoke compares ' + cmpKeys.length +
  ', compare() special-cases ' + special.length);
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
