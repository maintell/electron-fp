// Gate against duplicated logic - the defect class that let two things drift.
//
// Two real drifts were found by the scan this test automates:
//
//   1. The self-test's verdict table existed in main.js AND test-selftest.js.
//      The copies diverged: the handler produced expected/got strings and
//      explainMismatch() hints, the test's copy produced neither. The test
//      asserted against a re-implementation, so it could stay green while the
//      panel behaved differently. -> now Client/fp-probe.js verdicts()
//
//   2. The BrowserView geometry existed in main.js (twice) AND test-panel.js.
//      The test's copy renamed TOP_HEIGHT and dropped the STATUS_HEIGHT
//      subtraction. -> now Client/layout.js viewBounds()
//
// Both were invisible because each duplicate was tested only where it agreed
// with the original. This test fails if a shared module is bypassed or a
// formula reappears inline. Plain Node, no Electron.

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'Client');
const SCRIPTS = path.join(__dirname, '..', 'fingerprint', 'scripts');

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

function jsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
}

const main = fs.readFileSync(path.join(CLIENT, 'main.js'), 'utf8');
const probe = fs.readFileSync(path.join(CLIENT, 'fp-probe.js'), 'utf8');
const layout = fs.readFileSync(path.join(CLIENT, 'layout.js'), 'utf8');

// --- 1. the two shared modules exist and export what callers need ----------
ck('fp-probe.js exports verdicts (shared decision table)',
  /function verdicts\s*\(/.test(probe) && /module\.exports[\s\S]*verdicts/.test(probe));
ck('layout.js exports viewBounds (shared geometry)',
  /function viewBounds\s*\(/.test(layout) && /module\.exports[\s\S]*viewBounds/.test(layout));

// --- 2. main.js uses both, and re-implements neither -----------------------
const hIdx = main.indexOf("ipcMain.handle('selftest:run'");
const hNext = main.indexOf('ipcMain.handle(', hIdx + 10);
const handler = main.slice(hIdx, hNext < 0 ? main.length : hNext);

ck('main.js requires layout.js', /require\('\.\/layout'\)/.test(main));
ck('main.js requires fp-probe', /require\('\.\/fp-probe'\)/.test(main));
ck('main.js selftest handler delegates to verdicts()', /verdicts\(/.test(handler));
ck('main.js does not re-implement the verdict loop',
  !/for\s*\(\s*const\s+key\s+of\s+PROBE_FIELDS\s*\)\s*\{/.test(handler));
ck('main.js does not re-implement the geometry',
  !/setBounds\(\{\s*x:\s*0,\s*y:\s*TOP_HEIGHT/.test(main));
ck('main.js owns no local chrome constants',
  !/const\s+PANEL_WIDTH\s*=/.test(main) && !/const\s+TOP_HEIGHT\s*=/.test(main) &&
  !/const\s+STATUS_HEIGHT\s*=/.test(main));

// --- 3. no test re-implements either ---------------------------------------
// This file names the patterns only inside its own regexes, so it excludes
// itself - otherwise it would flag itself on every run.
// These two guards legitimately NAME the pattern inside their own regexes, so
// they must exclude themselves or they would flag themselves every run.
const SELF = 'test-no-duplicated-logic.js';
const GUARD = 'test-verdict-single-source.js';
for (const f of jsIn(CLIENT)
  .filter((x) => /^test-.*\.js$/.test(x) && x !== SELF && x !== GUARD)) {
  const t = fs.readFileSync(path.join(CLIENT, f), 'utf8');
  ck(f + ' has no local verdicts()', !/function\s+verdicts\s*\(/.test(t));
}

// --- 4. no function is defined in two non-test files -----------------------
// Per-test local helpers are fine; duplication between PRODUCT files (or a
// product file and its test) is what drifts.
const files = [
  ...jsIn(CLIENT).filter((f) => !/^test-/.test(f) && f !== 'run-tests.js')
    .map((f) => path.join(CLIENT, f)),
  ...jsIn(SCRIPTS).filter((f) => f !== 'smoke.js').map((f) => path.join(SCRIPTS, f)),
];
const defs = {};
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    (defs[m[1]] = defs[m[1]] || []).push(path.basename(f));
  }
}
const dupes = Object.entries(defs).filter(([, locs]) => [...new Set(locs)].length > 1);
// `locate` is a 6-line search helper duplicated in two standalone one-off
// scripts (revert_webrtc.js / split_patch.js). They run directly and share no
// state; a shared module there would add coupling under check.py review for no
// behavioural risk. Allowed explicitly so any NEW duplicate still fails.
const ALLOWED = ['locate'];
const unexpected = dupes.filter(([n]) => !ALLOWED.includes(n));
ck('no unexpected duplicate function names across product files',
  unexpected.length === 0,
  unexpected.length
    ? unexpected.map(([n, l]) => n + ' (' + [...new Set(l)].join(', ') + ')').join('; ')
    : (dupes.length ? 'only allowed: ' + dupes.map(([n]) => n).join(', ') : 'none'));

// --- 5. no constant name carries conflicting values ------------------------
const byName = {};
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/\bconst\s+([A-Z_][A-Z0-9_]{3,})\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g)) {
    (byName[m[1]] = byName[m[1]] || new Map()).set(path.basename(f), m[2]);
  }
}
const conflicts = Object.entries(byName).filter(([, m]) => [...new Set(m.values())].length > 1);
ck('no constant name has conflicting values across product files',
  conflicts.length === 0,
  conflicts.length
    ? conflicts.map(([n, m]) => n + ': ' + [...m.values()].join(' vs ')).join('; ')
    : 'none');

console.log('');
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
