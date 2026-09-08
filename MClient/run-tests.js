#!/usr/bin/env node
// Run every Client test against the built electron binary.
//
//   node Client/run-tests.js            # all tests
//   node Client/run-tests.js test-ua.js # one test
//
// Why this exists rather than just running the files:
//
// 1. resources/app. If out/Default/resources/app exists, electron.exe launches
//    the PACKAGED APP instead of the script and prints nothing. Every test
//    then reports 0 passes and looks catastrophically broken. The runner moves
//    it aside for the run and restores it afterwards (even on failure/ctrl-c).
//
// 2. One process per test. Tests create BrowserViews with random partitions;
//    running them in one process lets a crashed GPU/network service take out
//    every check after it. Sequential child processes keep failures contained.
//
// 3. Honest exit code and a per-file summary, so a regression is obvious.
//
// 4. Writing a new test? Hold a keepAlive window if you destroy every window
//    between measurements. Electron QUITS when the last BrowserWindow closes,
//    so a test that destroys its probe window after each measurement dies
//    partway through the run - and the process still exits 0, because it never
//    reaches the app.exit(fail === 0 ? 0 : 1) line. The symptom is an
//    ERR_FAILED on the load after the first measurement, plus far fewer checks
//    than expected. Measured: 4/4 loads succeed with a keepAlive window,
//    1/4 without. Client/test-webgpu-audio-values.js carries the pattern.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIENT = __dirname;
const REPO = path.dirname(CLIENT);

// Allow overriding the binary, e.g. ELECTRON_BIN=/path/to/electron.
const ELECTRON = process.env.ELECTRON_BIN ||
  path.join(REPO, '..', 'src', 'out', 'Default', 'electron.exe');

const RESOURCES = path.join(path.dirname(ELECTRON), 'resources');
const APP_DIR = path.join(RESOURCES, 'app');
const APP_OFF = path.join(RESOURCES, '_app_off');

const only = process.argv[2];
let files = fs.readdirSync(CLIENT)
  .filter(f => /^test-.*\.js$/.test(f))
  .sort();

if (only) {
  if (!files.includes(only)) {
    console.error('No such test: ' + only);
    console.error('Available:\n  ' + files.join('\n  '));
    process.exit(2);
  }
  files = [only];
}

if (!fs.existsSync(ELECTRON)) {
  console.error('electron binary not found: ' + ELECTRON);
  console.error('Build it (ninja -C out/Default electron) or set ELECTRON_BIN.');
  process.exit(2);
}

// --- move the packaged app aside, restore on any exit path --------------
let movedApp = false;
function stashApp() {
  if (fs.existsSync(APP_DIR) && !fs.existsSync(APP_OFF)) {
    fs.renameSync(APP_DIR, APP_OFF);
    movedApp = true;
    console.log('note: resources/app moved aside (it would shadow the tests)\n');
  }
}
function restoreApp() {
  if (movedApp && fs.existsSync(APP_OFF) && !fs.existsSync(APP_DIR)) {
    fs.renameSync(APP_OFF, APP_DIR);
    console.log('\nnote: resources/app restored');
  }
}
process.on('exit', restoreApp);
process.on('SIGINT', () => { restoreApp(); process.exit(130); });
process.on('uncaughtException', e => { restoreApp(); console.error(e); process.exit(1); });

stashApp();

let totalPass = 0, totalFail = 0, totalSkip = 0;
const failed = [];

for (const f of files) {
  const r = spawnSync(ELECTRON, [path.join(CLIENT, f)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n');
  const pass = lines.filter(l => /^PASS/.test(l)).length;
  const fail = lines.filter(l => /^(FAIL|THREW)/.test(l)).length;
  const skip = lines.filter(l => /^SKIP/.test(l)).length;

  totalPass += pass; totalFail += fail; totalSkip += skip;

  // 'ok' must mean "this file checked something and it all passed". A file that
  // passed nothing has not passed - so decide the tag on the same condition the
  // verdict uses, rather than on `fail` alone, which lets pass=0 look fine.
  const assertedSomething = pass > 0 || fail > 0;
  if (fail > 0) failed.push(f);

  const tag = !assertedSomething || fail > 0 ? 'FAIL' : 'ok  ';
  console.log(`${tag}  ${f.padEnd(26)} pass=${String(pass).padEnd(3)} fail=${String(fail).padEnd(3)} skip=${skip}`);

  if (fail > 0) {
    lines.filter(l => /^(FAIL|THREW)/.test(l))
      .forEach(l => console.log('        ' + l.trim()));
  }
  // A test that asserted NOTHING is not a pass - it is a hole.
  //
  // Two distinct shapes, both previously reported as clean:
  //
  //   pass=0 fail=0 skip=0  the process died before printing (the
  //                         resources/app failure mode)
  //   pass=0 fail=0 skip=N  the test skipped everything
  //
  // The second is the more dangerous of the two: a skip is legitimate when the
  // environment genuinely lacks something, but a test whose EVERY check skips
  // contributes nothing on this machine while making the suite look larger.
  //
  // This used to `return` instead of `continue`, which ABORTED the whole run at
  // the first offending file: every test after it silently never ran, and the
  // TOTAL line was never printed. That is how test-no-silent-skips.js failed
  // earlier - it exited null, and the runner then skipped the remaining files.
  if (pass === 0 && fail === 0) {
    if (skip === 0) {
      console.log(`        (no output - exit=${r.status}${r.error ? ' ' + r.error.code : ''})`);
    } else {
      console.log(`        (CHECKED NOTHING: ${skip} skipped, 0 passed, 0 failed)`);
    }
    failed.push(f);
    continue;
  }

  // A test that skips MORE than it checks is worth surfacing even when some
  // checks did run - it usually means an environment precondition quietly
  // stopped being satisfied on this machine.
  if (skip > 0 && skip > pass) {
    console.log(`        (mostly skipped: ${skip} skipped vs ${pass} passed)`);
    failed.push(f);
  }

  // Also gate on the exit code, not just the printed lines.
  //
  // Several tests already exited non-zero while printing only PASS lines - the
  // Chromium FATAL "Check failed: !BrowserMainRunner::ExitedMainMessageLoop()"
  // fires during shutdown and aborts with a code like 4294930435, after all
  // output was written. Judging only the printed lines let a process that
  // crashed on the way out be reported as a clean pass, which is precisely
  // the kind of silent failure this runner exists to catch.
  if (r.status !== 0) {
    console.log(`        (exit=${r.status} - crashed during shutdown despite passing checks)`);
    failed.push(f);
  }
}

console.log('');
console.log(`TOTAL: pass=${totalPass} fail=${totalFail} skip=${totalSkip}  (${files.length} files)`);
if (failed.length) {
  console.log('failing: ' + failed.join(', '));
  process.exit(1);
}
console.log('ALL TESTS PASSED');
