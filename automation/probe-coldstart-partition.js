'use strict';
// R8 (OQ-19 residual): cross-process cold-start survival of a `persist:auto-<id>` partition.
//
// Existing evidence (probe-automation-smoke.js test x) only proves the cookie survives a
// SAME-PROCESS relaunch (launcher.stop -> launcher.start). This probe proves the stronger
// claim: the partition's cookie survives a FULL app exit + a separate relaunch process.
//
// Two-phase marker: run phase1 (write cookie, flushStore, exit), then phase2 (read cookie).
// The expected value is written to a temp marker file so phase2 cannot pass spuriously.
//
// Run (built binary; stash resources/app first per AGENTS.md §2):
//   $env:RTK_DISABLED='1'; & "F:\code\src\out\Default\electron.exe" automation\probe-coldstart-partition.js phase1
//   $env:RTK_DISABLED='1'; & "F:\code\src\out\Default\electron.exe" automation\probe-coldstart-partition.js phase2
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

let pass = 0;
let fail = 0;
function ok(name) {
  pass++;
  console.log('PASS ' + name);
}
function bad(name, err) {
  fail++;
  console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : String(err)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = 'F:\\Temp\\coldstart-partition-marker.json';
const PARTITION = 'persist:auto-coldstart-probe';
const COOKIE_NAME = 'cold';
const COOKIE_URL = 'https://coldstart.probe/';

function phase() {
  return process.argv.includes('phase2') ? 2 : 1;
}

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch (_) {}
    }
  } catch (_) {}
}

async function main() {
  await app.whenReady();
  app.on('window-all-closed', () => {});

  const hardKill = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 60s budget exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 60000);
  if (hardKill.unref) hardKill.unref();

  const ph = phase();
  console.log('INFO phase=' + ph + ' partition=' + PARTITION + ' userData=' + app.getPath('userData'));

  let win = null;
  try {
    win = new BrowserWindow({
      width: 400,
      height: 300,
      show: false,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });
    const ses = win.webContents.session;

    if (ph === 1) {
      // clear any prior cookie so a later phase2 pass is genuinely this run's write
      try {
        await ses.cookies.remove(COOKIE_URL, COOKIE_NAME);
      } catch (_) {}
      const value = 'cold-' + Date.now();
      await ses.cookies.set({
        url: COOKIE_URL,
        name: COOKIE_NAME,
        value,
        expirationDate: Math.floor(Date.now() / 1000) + 86400, // persistent (not session-only)
      });
      const got = await ses.cookies.get({ name: COOKIE_NAME });
      if (got.some((c) => c.value === value)) ok('phase1: cookie set in partition session (' + value + ')');
      else bad('phase1: cookie set in partition session', new Error('got=' + JSON.stringify(got)));
      await ses.cookies.flushStore(); // force disk write before process exit
      ok('phase1: cookies.flushStore() completed');
      fs.writeFileSync(MARKER, JSON.stringify({ value, partition: PARTITION, at: Date.now() }));
      ok('phase1: marker written (expected value persisted for phase2)');
    } else {
      if (!fs.existsSync(MARKER)) throw new Error('phase2 requires the phase1 marker at ' + MARKER);
      const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
      const got = await ses.cookies.get({ name: COOKIE_NAME });
      const found = got.find((c) => c.value === marker.value);
      if (found) ok('phase2: cookie SURVIVED full process exit (value=' + found.value + ')');
      else bad('phase2: cookie survived full process exit', new Error('expected=' + marker.value + ' got=' + JSON.stringify(got)));
    }

    console.log('VERDICT cross-process-partition-survival=' + (fail === 0 ? 'PASS' : 'FAIL'));
    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await sleep(300); // let piped stdout flush before exit
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('VERDICT cross-process-partition-survival=FAIL');
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
  } finally {
    try {
      clearTimeout(hardKill);
    } catch (_) {}
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try {
      app.exit(process.exitCode);
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000);
  }
}

main();
