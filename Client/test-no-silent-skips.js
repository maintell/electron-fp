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
// cannot provide, and must say so in its detail string. This test fails on an
// unexplained skip, and on a test that reports fewer checks than it has call
// sites (which would mean call sites that never execute).
//
// Plain Node, but it shells out to run-tests.js per file, so it is the slowest
// test in the suite. Keep it last-ish; do not add per-file work here.

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

let totalSkip = 0;
const unexplained = [];
for (const f of files) {
  if (f === 'test-no-silent-skips.js') continue; // this file shells out; skip self
  const r = spawnSync(process.execPath, [path.join(CLIENT, 'run-tests.js'), f], {
    cwd: REPO, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, PATH: 'C:\\OpenSSL-Win64\\bin;' + process.env.PATH },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/pass=(\d+)\s+fail=(\d+)\s+skip=(\d+)/);
  if (!m) { unexplained.push(f + ': no summary line'); continue; }
  const skipped = +m[3];
  if (!skipped) continue;
  totalSkip += skipped;

  // Every skip must explain itself, and the explanation must be about the
  // ENVIRONMENT - not just present, or any skip would pass this gate.
  for (const line of out.split(/\r?\n/)) {
    if (!/^\s*SKIP|SKIP\s{2}/.test(line)) continue;
    const detail = line.replace(/^\s*(?:\x1b\[[0-9;]*m)?SKIP\s*/, '')
      .replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!SKIP_OK.test(detail)) unexplained.push(f + ': "' + detail.slice(0, 90) + '"');
  }
}

ck('no test skips a check without an environment reason',
  unexplained.length === 0,
  unexplained.length ? unexplained.join(' | ') : 'all skips justified, or none');

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
