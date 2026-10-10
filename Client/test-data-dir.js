'use strict';
// Proves a configured data dir is applied to app.getPath('userData') at the very
// top of the main entry - before app.whenReady() and before any window is
// created (doc 17 Part D / OQ-19). Boots the REAL Client/main.js with FP_DATA_DIR
// pointing at a temp dir and asserts the path; also exercises the pure resolver
// (CLI > env > default) and the copy-only migration.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

// Configure BEFORE requiring the entry, exactly as a CLI/env launch would.
const TMP = path.join(os.tmpdir(), 'fp-data-dir-client-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });
process.env.FP_DATA_DIR = TMP;

const mod = require('./main.js');

// Synchronous checks: whenReady has NOT fired and no window exists yet, so a
// passing path proves the entry set it before any window could be created.
ck('app.getPath(userData) === configured FP_DATA_DIR',
  path.resolve(app.getPath('userData')) === path.resolve(TMP), app.getPath('userData'));
ck('no window exists yet (path set before window creation)',
  BrowserWindow.getAllWindows().length === 0, String(BrowserWindow.getAllWindows().length));

// Pure resolver: precedence CLI > env > default(null).
ck('CLI --user-data-dir= beats FP_DATA_DIR',
  mod.fpResolveDataDir(['--user-data-dir=C:\\cli'], { FP_DATA_DIR: 'env' }) === 'C:\\cli');
ck('CLI --user-data-dir <path> form is honoured',
  mod.fpResolveDataDir(['--user-data-dir', 'C:\\cli2'], {}) === 'C:\\cli2');
ck('FP_DATA_DIR used when no CLI arg',
  mod.fpResolveDataDir([], { FP_DATA_DIR: 'env' }) === 'env');
ck('no config resolves to null (default userData untouched)',
  mod.fpResolveDataDir([], {}) === null);

// Migration is a COPY: source preserved, marker written, non-empty refused.
const src = path.join(TMP, 'mig-src');
const dst = path.join(TMP, 'mig-dst');
fs.mkdirSync(path.join(src, 'Partitions', 'p1'), { recursive: true });
fs.writeFileSync(path.join(src, 'Partitions', 'p1', 'Cookies'), 'x');
fs.writeFileSync(path.join(src, 'profiles.json'), '{"profiles":[]}');
const mr = mod.fpMigrateDataDir(src, dst);
ck('migration copies the Partitions subtree',
  mr.migrated === true && fs.existsSync(path.join(dst, 'Partitions', 'p1', 'Cookies')));
ck('migration copies app-state files', fs.existsSync(path.join(dst, 'profiles.json')));
ck('migration never deletes the source',
  fs.existsSync(path.join(src, 'Partitions', 'p1', 'Cookies')));
ck('migration writes the marker',
  fs.existsSync(path.join(dst, '.fp-data-migrated-from')));
const again = mod.fpMigrateDataDir(src, dst);
ck('migration is idempotent (marker prevents re-run)',
  again.migrated === false && again.reason === 'already-migrated');
const nonEmpty = path.join(TMP, 'mig-ne');
fs.mkdirSync(nonEmpty, { recursive: true });
fs.writeFileSync(path.join(nonEmpty, 'keep'), 'y');
ck('migration refuses a non-empty target',
  mod.fpMigrateDataDir(src, nonEmpty).reason === 'target-not-empty');
ck('migration same-dir is a no-op', mod.fpMigrateDataDir(src, src).reason === 'same-dir');

const hardKill = setTimeout(() => {
  console.log('FAIL  harness-timeout :: 60s budget exceeded');
  try { app.exit(2); } catch (_) { process.exit(2); }
}, 60000);

app.whenReady().then(() => {
  ck('userData stays configured after ready',
    path.resolve(app.getPath('userData')) === path.resolve(TMP), app.getPath('userData'));
  for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (_) {} }
  clearTimeout(hardKill);
  console.log('');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail));
  const code = fail === 0 ? 0 : 1;
  try { app.exit(code); } catch (_) { process.exit(code); }
  setTimeout(() => process.exit(code), 2000);
}).catch((e) => {
  console.log('FAIL  whenReady threw :: ' + ((e && e.stack) || e));
  try { app.exit(1); } catch (_) { process.exit(1); }
});
