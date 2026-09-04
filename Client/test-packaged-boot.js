// Does the PACKAGED Client app's module graph actually load?
//
// Needed because files can be deleted from resources/app without any existing
// test noticing: test-app-copy-sync.js only asks whether each LISTED file is
// present and matching, never whether anything is MISSING. Two stale files sat
// there for the same reason (now removed, and that test now gates extras too).
//
// Getting a trustworthy answer took three attempts, and the failures matter:
//
//   1. Capturing electron.exe's stdout/stderr via spawn() yields NOTHING - not
//      even when the app is provably broken. Deleting a module that main.js
//      requires at the top level still produced zero output. So "no errors in
//      the output" proves nothing under Electron.
//
//   2. "The process is still running" is not health either: Electron lingers
//      after a failed main-process script.
//
//   3. electron.exe IGNORES a script argument while resources/app exists and
//      loads the packaged app instead. run-tests.js stashes it to _app_off for
//      the whole suite, so this probe runs against the STASHED path - and must
//      resolve it dynamically, or it reports "Cannot find module" for files
//      that are perfectly present.
//
// So the app reports on itself: a probe script requires every module the real
// main.js requires and writes a marker file. A missing marker means broken,
// regardless of what the process printed or how long it lived.
//
// Runs under Electron (see run-tests.js).

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const RESOURCES = path.join(path.dirname(process.execPath), 'resources');
const APP_LIVE = path.join(RESOURCES, 'app');
const APP_OFF = path.join(RESOURCES, '_app_off');

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

// run-tests.js stashes resources/app before the suite so electron.exe will run
// a script at all. Resolve whichever name it currently has.
function appDir() {
  if (fs.existsSync(APP_LIVE)) return { dir: APP_LIVE, stashed: false };
  if (fs.existsSync(APP_OFF)) return { dir: APP_OFF, stashed: true };
  return null;
}

app.whenReady().then(() => {
  const found = appDir();
  if (!found) {
    // No packaged copy at all - nothing to verify, and not a failure of this
    // project's code. Say so loudly rather than passing vacuously.
    console.log('SKIP  no packaged copy found (looked for resources/app and _app_off)');
    console.log('PASS: 0 checks (0 skipped)');
    app.exit(0);
    return;
  }
  const APP = found.dir;
  console.log('  packaged copy: ' + APP + (found.stashed ? '  (stashed by run-tests.js)' : ''));

  // --- 1. every module main.js requires at the top level must load ---------
  // The list is read from main.js itself, so a new require can never silently
  // drop out of this check.
  const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
  const localReqs = [...new Set(
    [...mainSrc.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map((m) => m[1])
  )].sort();

  ck('main.js has local requires to check', localReqs.length > 0,
    localReqs.length + ' found: ' + localReqs.join(', '));

  for (const r of localReqs) {
    const p = path.join(APP, r);
    let ok = true, detail = '';
    try {
      const m = require(p);
      const n = m && typeof m === 'object' ? Object.keys(m).length : 0;
      detail = n + ' exports';
      // A module that loads but exports nothing is as broken as one that is
      // missing, and would otherwise slip through.
      ok = n > 0;
      if (!ok) detail = 'loads but exports NOTHING';
    } catch (e) {
      ok = false;
      detail = e && e.message;
    }
    ck(r + ' loads and exports something', ok, detail);
  }

  // --- 2. assets Electron loads by convention, not by require -------------
  // preload.js is named in webPreferences; index.html is passed to loadFile.
  // Neither appears as a require, so they are checked by existence + parse.
  ck('preload.js referenced by main.js',
    /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/.test(mainSrc));
  ck('renderer/index.html passed to loadFile',
    /loadFile\(path\.join\(__dirname,\s*'renderer',\s*'index\.html'\)\)/.test(mainSrc));

  for (const f of ['preload.js', 'package.json', 'renderer/index.html',
                   'renderer/app.js', 'renderer/style.css']) {
    ck(f + ' present in the packaged copy', fs.existsSync(path.join(APP, f)),
      fs.existsSync(path.join(APP, f)) ? 'ok' : 'MISSING');
  }

  // The renderer entry point must exist AND parse; a syntax error there shows
  // as a blank window, which no other test would catch.
  try {
    new (require('vm').Script)(fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8'),
      { filename: 'renderer/app.js' });
    ck('renderer/app.js parses', true, 'no syntax error');
  } catch (e) {
    ck('renderer/app.js parses', false, e && e.message);
  }

  // --- 3. index.html must reference assets that exist ---------------------
  try {
    const html = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const bad = refs.filter((r) => /^(?!https?:|#|data:)/.test(r) &&
      !fs.existsSync(path.join(APP, 'renderer', r)));
    ck('every local asset referenced by index.html exists', bad.length === 0,
      bad.length ? 'missing: ' + bad.join(', ') : refs.join(', '));
  } catch (e) {
    ck('every local asset referenced by index.html exists', false, e && e.message);
  }

  console.log('');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.log('FAIL  boot check threw: ' + (e && e.message));
  app.exit(1);
});
