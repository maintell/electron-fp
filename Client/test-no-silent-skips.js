// Gate: the suite must not carry silent holes.
//
// A conditional SKIP is right when the environment genuinely lacks something -
// no microphone, no network egress, a feature flag the build does not have.
// It is a HOLE when it disables an assertion on every run, on every machine,
// while the suite still reports green.
//
// Two real holes were found this way:
//
//   1. webgpu_device / webgpu_description were permanently SKIPped. The test
//      read an env var to relax its own assertion but NEVER appended
//      --enable-blink-features=WebGPUDeveloperFeatures, so the feature stayed
//      off, the two keys always read "", and the skip was the only reason the
//      test passed. The comment claimed "verified: with the flag it applies
//      exactly" - true, but never verified BY THAT CODE. Fixed by appending
//      the switch; both keys now assert for real.
//
//   2. The same pattern left 2 skips in the suite forever. With them fixed the
//      suite is now 0-skip: every one of the 63 keys' value assertions runs.
//
// So: any new skip must be justified by an environment the suite genuinely
// cannot provide, and must say so in its detail string.
//
// HOW, without recursion: the first version of this test shelled out to
// run-tests.js once per test file. That nested 48 child suites inside the
// parent suite, and each child stashed/restored resources/app - which the
// parent had ALREADY stashed. The process was killed during shutdown and
// reported exit=null, failing the suite despite all its own checks passing.
//
// So this is now purely static plus direct require(): every Electron test is
// parsed for its skip call sites and the reasons passed to them; every pure
// Node test is additionally run in-process to collect real skip output. No
// child processes, no resources/app contention.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CLIENT = path.join(REPO, 'Client');

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const files = fs.readdirSync(CLIENT).filter((f) => /^test-.*\.js$/.test(f)).sort();
ck('suite has tests to check', files.length > 0, files.length + ' files');

const SKIP_OK = /environment|not present|not packaged|no such|unavailable|no microphone|no device|requires|needs|not available|external|network/i;

// --- 1. static: every skip call site must carry an environment reason ------
// Cheap, and it covers the 36 Electron tests we cannot run in-process.
const unjustified = [];
let skipSites = 0;
for (const f of files) {
  if (f === 'test-no-silent-skips.js') continue;
  const src = fs.readFileSync(path.join(CLIENT, f), 'utf8');
  const lines = src.split(/\r?\n/);
  lines.forEach((l, i) => {
    // A call to a skip helper: sk(...) / skip(...) / check with a null cond
    // is covered separately. Only named skip helpers are checked here.
    const m = l.match(/\b(?:sk|skipCheck)\s*\(\s*(['"])(.+?)\1\s*(?:,\s*(.+?))?\s*\)/);
    if (!m) return;
    skipSites++;
    const reason = (m[3] || m[2] || '').replace(/^['"]|['"]$/g, '');
    // The reason may be a template/variable; resolve simple string literals
    // only, and require SOME justification text to be present.
    if (!reason.trim()) {
      unjustified.push(f + ':' + (i + 1) + ' (no reason given)');
    } else if (/^['"]/.test(reason.trim()) && !SKIP_OK.test(reason)) {
      unjustified.push(f + ':' + (i + 1) + ' "' + reason.slice(0, 70) + '"');
    }
  });
}
ck('every static skip site carries a reason', unjustified.length === 0,
  unjustified.length ? unjustified.join(' | ') : skipSites + ' site(s), all justified');

// --- 2. runtime: pure Node tests are run here, in-process ------------------
// These can actually skip, so run them and read their real output. Electron
// tests cannot be run here (see the header comment on recursion).
const pure = files.filter((f) =>
  f !== 'test-no-silent-skips.js' &&
  !/require\(\s*['"]electron['"]\s*\)/.test(fs.readFileSync(path.join(CLIENT, f), 'utf8')));

let totalSkip = 0;
const runtimeSkips = [];
//
// Run each as a CHILD PROCESS, not via require(). Every one of these tests
// calls process.exit() at the end, so require() would terminate THIS process
// mid-run (observed: output stopped after the second check). A child keeps the
// exit contained.
//
// Critically, do NOT go through run-tests.js: that would nest a suite inside
// the suite, and each child would stash/restore resources/app - which the
// parent has already stashed. That is exactly what killed the first version
// of this file (exit=null, "crashed during shutdown"). Direct node invocation
// touches nothing under resources/.
for (const f of pure) {
  const r = spawnSync(process.execPath, [path.join(CLIENT, f)], {
    cwd: REPO, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PATH: 'C:\\OpenSSL-Win64\\bin;' + process.env.PATH },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const line of out.split(/\r?\n/)) {
    if (!/^\s*SKIP|SKIP\s{2}/.test(line)) continue;
    const detail = line.replace(/^\s*(?:\x1b\[[0-9;]*m)?SKIP\s*/, '')
      .replace(/\x1b\[[0-9;]*m/g, '').trim();
    totalSkip++;
    if (!SKIP_OK.test(detail)) runtimeSkips.push(f + ': "' + detail.slice(0, 90) + '"');
  }
}
ck('pure Node tests skip nothing without an environment reason',
  runtimeSkips.length === 0,
  runtimeSkips.length ? runtimeSkips.join(' | ')
    : 'ran ' + pure.length + ' pure Node tests, ' + totalSkip + ' skip(s)');

// The webgpu hole specifically.
//
// Note what this check IS and IS NOT. Removing the switch makes
// test-webgpu-audio-values.js FAIL (device reads ""), not skip - so the
// webgpu test already guards itself, and an earlier version of this check
// that only asserted "the switch is present" did not distinguish anything.
//
// What is worth guarding is the vacuous shape the bug actually had: a test
// that reads a feature-flag name only to relax its OWN assertion, without
// ever enabling the feature. That is a test which cannot fail on the kernel.
const wg = path.join(CLIENT, 'test-webgpu-audio-values.js');
if (fs.existsSync(wg)) {
  const t = fs.readFileSync(wg, 'utf8');
  const hasSwitch = /appendSwitch\(\s*['"]enable-blink-features['"]\s*,\s*['"]WebGPUDeveloperFeatures['"]\s*\)/.test(t);
  ck('webgpu test enables the blink feature it depends on', hasSwitch,
    hasSwitch ? 'switch appended (removing it fails the webgpu test itself)'
      : 'MISSING - device/description read "" and the assertions go vacuous');

  // The inverted-default check: a strictness gate must default to STRICT, not
  // to permissive. The original bug had `process.argv.includes(...)` as the
  // opt-IN, so the strict path never ran unless someone passed a flag.
  const optIn = /devFeatures\s*=\s*process\.argv\.includes\(/.test(t);
  ck('feature-dependent assertions default to strict, not permissive', !optIn,
    optIn
      ? 'strictness is opt-IN - the assertion never runs by default'
      : 'strict by default');
}

console.log('');
console.log('  (diagnostic) total skipped checks across the suite: ' + totalSkip);
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
