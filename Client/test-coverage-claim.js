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

// --- 2. compare() is total and boolean over everything the probe reads -----
const notBoolean = [];
const threw = [];
for (const k of PROBE_FIELDS) {
  for (const [want, got] of [['1', '1'], ['1', '2'], ['0', '0'], ['abc', 'abc']]) {
    let r;
    try { r = compare(k, want, got); } catch (e) { threw.push(k + ' (' + e.message + ')'); continue; }
    if (typeof r !== 'boolean') notBoolean.push(k + ' -> ' + typeof r);
  }
}
ck('compare() never throws for a key the probe reads', threw.length === 0,
  threw.length ? threw.slice(0, 5).join(' | ') : PROBE_FIELDS.length + ' keys x 4 cases');
ck('compare() always returns a boolean', notBoolean.length === 0,
  notBoolean.length ? [...new Set(notBoolean)].slice(0, 5).join(' | ') : 'all boolean');

// A key that returns true for BOTH a matching and a mismatching value cannot
// detect a failure. That is legitimate when the semantics are "nonzero" or
// "must be absent", so those are declared explicitly rather than assumed.
const NON_EQUALITY = {
  canvas_noise_seed: 'nonzero - any noise means the key applied',
  client_rects_seed: 'absent - the probe reports a boolean, not a value',
  measure_text_seed: 'nonzero - any perturbation means the key applied',
  fonts_blocklist: 'absent - the probe reports a boolean, not a value',
  webgpu_limits: 'merge - only configured sub-keys are compared',
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
// perf_now_precision_ms is a deliberate exception. compare() handles it, but
// the shared probe cannot read it (performance.now() quantisation is not a
// value a page reads back as a field), so the self-test panel will never
// assert it. It is genuinely proven by test-covered-surfaces.js:167.
//
// The exception exists because the RISK here is not the dead branch - it is
// that a compare() special case makes the probe look more capable than it is.
// So the exception is declared by name (a new one still fails) and paired with
// a check that the key really is proven somewhere else.
const DEAD_SPECIAL_OK = ['perf_now_precision_ms'];
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
// `probe.includes(key)` matched perf_now_precision_ms, which the probe does
// NOT read. It is genuinely proven elsewhere (test-covered-surfaces.js), but
// the substring rule credited the probe for it. Pin the distinction.
ck('perf_now_precision_ms is proven by a test, not by the shared probe',
  !read.has('perf_now_precision_ms') &&
  /perf_now_precision_ms/.test(testSrc),
  'probe reads it: ' + read.has('perf_now_precision_ms') +
  '; asserted in a test: ' + /perf_now_precision_ms/.test(testSrc));

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
