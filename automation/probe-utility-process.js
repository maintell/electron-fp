'use strict';
// R6 (OQ-16): utilityProcess feasibility for hosting the automation driver.
//
// Question: can a script hosted in an Electron `utilityProcess` drive a real BrowserWindow?
// The utilityProcess cannot touch webContents (no window, no debugger handle), so it must
// broker every CDP call through the main process:
//
//   utilityProcess child --postMessage({t:'cdp',method,params})--> main
//   main --webContents.debugger.sendCommand--> real window --result--> main
//   main --postMessage({t:'reply',...})--> child
//
// Verdict: PASS if the child can make the window navigate/evaluate and get real values back.
// Constraints observed (serialization/handles) are printed as INFO.
//
// Run (built binary; stash resources/app first per AGENTS.md §2):
//   $env:RTK_DISABLED='1'; & "F:\code\src\out\Default\electron.exe" automation\probe-utility-process.js
const { app, BrowserWindow, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('fs');
const { createElectronSession } = require('./electron/glue');

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

const FIXTURE_FILE = 'F:\\Temp\\up-e2e.html';
const FIXTURE_URL = 'file:///F:/Temp/up-e2e.html';
const TITLE = 'UTILITY-PROC-42';

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
  // Every window here is ours; keep the process alive until the explicit exit.
  app.on('window-all-closed', () => {});

  const hardKill = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 120s budget exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 120000);
  if (hardKill.unref) hardKill.unref();

  let win = null;
  let es = null;
  let child = null;
  try {
    fs.writeFileSync(FIXTURE_FILE, '<html><head><title>' + TITLE + '</title></head><body><div id="d">hi</div></body></html>');

    win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { partition: 'persist:auto-up-e2e', contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    es = createElectronSession({ webContents: win.webContents, profileId: 'up-e2e' });
    await es.start();
    ok('main attached webContents.debugger (automation session ready)');

    child = utilityProcess.fork(path.join(__dirname, 'probe-utility-child.js'), [], { serviceName: 'probe-up-driver' });
    ok('utilityProcess.fork returned a handle (pid=' + child.pid + ')');

    let childReady = false;
    let childDone = null;
    const brokered = [];

    child.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'ready') {
        childReady = true;
        console.log('INFO child ready (pid=' + msg.pid + ')');
        return;
      }
      if (msg.t === 'cdp') {
        brokered.push(msg.method);
        try {
          const result = await es.session.sendCommand(msg.method, msg.params || {});
          child.postMessage({ t: 'reply', id: msg.id, ok: true, result });
        } catch (e) {
          child.postMessage({ t: 'reply', id: msg.id, ok: false, error: String((e && e.message) || e) });
        }
        return;
      }
      if (msg.t === 'done') {
        childDone = msg;
      }
    });
    child.on('exit', (code) => {
      console.log('INFO utilityProcess exited code=' + code);
    });

    // handshake: messages queue until the child registers its handler, but wait for 'ready'
    // so the run order is explicit (and so a fork failure surfaces as a FAIL, not a hang).
    const tw = Date.now();
    while (!childReady && Date.now() - tw < 15000) await sleep(100);
    if (!childReady) throw new Error('utilityProcess never reported ready (fork/entrypoint failed)');
    ok('utilityProcess <-> main message channel established');

    child.postMessage({ t: 'go', url: FIXTURE_URL, title: TITLE, mathExpr: '6*7' });

    const t0 = Date.now();
    while (!childDone && Date.now() - t0 < 60000) await sleep(100);
    if (!childDone) throw new Error('child did not report done within 60s');
    if (childDone.error) throw new Error('child errored: ' + childDone.error);

    // verdict: the utilityProcess-hosted driver navigated + evaluated the real page.
    if (childDone.title === TITLE) ok('child round-trip: document.title via utilityProcess = ' + childDone.title);
    else bad('child round-trip: document.title', new Error('title=' + JSON.stringify(childDone.title)));
    if (childDone.math === 42) ok('child round-trip: Runtime.evaluate 6*7 = ' + childDone.math);
    else bad('child round-trip: Runtime.evaluate 6*7', new Error('math=' + JSON.stringify(childDone.math)));
    if (brokered.includes('Page.navigate') && brokered.includes('Runtime.evaluate'))
      ok('broker observed Page.navigate + Runtime.evaluate (' + brokered.length + ' brokered calls)');
    else bad('broker observed navigate+evaluate', new Error('seen=' + JSON.stringify(brokered)));

    console.log('INFO brokered methods=' + JSON.stringify(Array.from(new Set(brokered))));
    console.log('INFO constraint: messages are structured-clone JSON only (no webContents/debugger handle crosses the boundary)');
    console.log('VERDICT utilityProcess-can-drive-browser=' + (fail === 0 ? 'PASS' : 'FAIL'));
    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await sleep(300); // let piped stdout flush before exit
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('VERDICT utilityProcess-can-drive-browser=FAIL');
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
  } finally {
    try {
      clearTimeout(hardKill);
    } catch (_) {}
    try {
      if (child) child.kill();
    } catch (_) {}
    try {
      if (es) await es.stop();
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
