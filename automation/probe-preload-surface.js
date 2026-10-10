'use strict';
// ponytail: one-shot preload surface probe — typeof-checks only (no IPC channel is invoked,
// no ipcMain handlers needed). Verifies the add-only exposures (automationApi.templates +
// onAutomationEvent) are present while the pre-existing surface is intact and the renderer
// gains no Node globals. Acceptance #34 boundary.
const { app, BrowserWindow } = require('electron');
const path = require('path');

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

  const guard = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 60s guard exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 60000);
  if (guard.unref) guard.unref();

  let win = null;
  try {
    win = new BrowserWindow({
      width: 400,
      height: 300,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'Client', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    const wc = win.webContents;
    const s = await wc.executeJavaScript(
      `(() => {
        const a = window.automationApi;
        const api = window.api;
        return {
          automationApiPresent: typeof a,
          onAutomationEvent: typeof (a && a.onAutomationEvent),
          templatesPresent: typeof (a && a.templates),
          templatesList: typeof (a && a.templates && a.templates.list),
          templatesInstall: typeof (a && a.templates && a.templates.install),
          facadeMethods: {
            getScripts: typeof (a && a.getScripts),
            saveScript: typeof (a && a.saveScript),
            runScript: typeof (a && a.runScript),
            stopScript: typeof (a && a.stopScript),
            getExecutions: typeof (a && a.getExecutions),
            getLogs: typeof (a && a.getLogs),
          },
          apiObj: typeof api,
          apiCreateTab: typeof (api && api.createTab),
          apiOnAutomationEvent: typeof (api && api.onAutomationEvent),
          apiAutomationApiIsObj: typeof (api && api.automationApi),
          leakRequire: typeof window.require,
          leakProcess: typeof window.process,
          leakModule: typeof window.module,
          sameRef: !!(api && a && api.automationApi === a),
        };
      })()`,
      true
    );

    // add-only surface
    if (s.automationApiPresent === 'object') ok('window.automationApi exposed (object)');
    else bad('window.automationApi exposed (object)', new Error('typeof=' + s.automationApiPresent));
    if (s.onAutomationEvent === 'function') ok('automationApi.onAutomationEvent is function');
    else bad('automationApi.onAutomationEvent is function', new Error('typeof=' + s.onAutomationEvent));
    if (s.templatesPresent === 'object') ok('automationApi.templates exposed (object)');
    else bad('automationApi.templates exposed (object)', new Error('typeof=' + s.templatesPresent));
    if (s.templatesList === 'function') ok('automationApi.templates.list is function');
    else bad('automationApi.templates.list is function', new Error('typeof=' + s.templatesList));
    if (s.templatesInstall === 'function') ok('automationApi.templates.install is function');
    else bad('automationApi.templates.install is function', new Error('typeof=' + s.templatesInstall));

    // pre-existing facade intact
    const missing = Object.keys(s.facadeMethods).filter((k) => s.facadeMethods[k] !== 'function');
    if (missing.length === 0) ok('facade methods intact (getScripts/saveScript/runScript/stopScript/getExecutions/getLogs)');
    else bad('facade methods intact', new Error('missing=' + JSON.stringify(missing)));

    // window.api surface
    if (s.apiObj === 'object') ok('window.api exposed (object)');
    else bad('window.api exposed (object)', new Error('typeof=' + s.apiObj));
    if (s.apiCreateTab === 'function') ok('window.api.createTab is function');
    else bad('window.api.createTab is function', new Error('typeof=' + s.apiCreateTab));
    if (s.apiOnAutomationEvent === 'function') ok('window.api.onAutomationEvent is function');
    else bad('window.api.onAutomationEvent is function', new Error('typeof=' + s.apiOnAutomationEvent));
    if (s.apiAutomationApiIsObj === 'object') ok('window.api.automationApi exposed (object)');
    else bad('window.api.automationApi exposed (object)', new Error('typeof=' + s.apiAutomationApiIsObj));

    // renderer must not gain Node
    if (s.leakRequire === 'undefined' && s.leakProcess === 'undefined' && s.leakModule === 'undefined') {
      ok('no Node leak (require/process/module undefined)');
    } else {
      bad(
        'no Node leak (require/process/module undefined)',
        new Error('require=' + s.leakRequire + ' process=' + s.leakProcess + ' module=' + s.leakModule)
      );
    }

    // informational only (contextBridge may proxy separately)
    console.log('INFO sameRef=' + s.sameRef);

    // listener registration: returns an unsubscribe that does not throw
    const l = await wc.executeJavaScript(
      `(() => {
        const un = window.automationApi.onAutomationEvent(() => {});
        let calledOk = true;
        try { un(); } catch (e) { calledOk = false; }
        return { unsubscribeType: typeof un, calledOk };
      })()`,
      true
    );
    if (l.unsubscribeType === 'function') ok('onAutomationEvent returns unsubscribe function');
    else bad('onAutomationEvent returns unsubscribe function', new Error('typeof=' + l.unsubscribeType));
    if (l.calledOk) ok('unsubscribe call does not throw');
    else bad('unsubscribe call does not throw', new Error('threw'));

    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await new Promise((r) => setTimeout(r, 300)); // let piped stdout flush before exit
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
  } finally {
    try {
      clearTimeout(guard);
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
