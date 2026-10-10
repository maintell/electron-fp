'use strict';
// ponytail: one-shot Electron e2e — manager→runner→page.js driver→real file:// DOM.
// Proves acceptance #12-18 boundary: script code runs through the real browserApi
// (not a mock), backed by the Electron page driver over a live hidden window.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { createElectronSession } = require('./electron/glue');
const { createElectronExecutor } = require('./electron/executor');
const { createScriptStore } = require('./runtime/script-store');
const { createAutomationManager } = require('./runtime/automation-manager');

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

const PAGE_FILE = 'F:\\Temp\\e2e-script-page.html';
const PAGE_URL = 'file:///F:/Temp/e2e-script-page.html';
const PARTITION = 'persist:auto:e2e-script';
const PROFILE_ID = 'e2e-script';
const HTML = [
  '<html><body>',
  '<button id="go" onclick="document.getElementById(\'out\').textContent=\'clicked\'">go</button>',
  '<div id="out">idle</div>',
  '</body></html>',
].join('\n');
const CODE = [
  "step('run');",
  'await browser.goto(params.url);',
  "await page.waitForSelector('#go');",
  "await page.click('#go');",
  "const t = await page.getText('#out');",
  "console.log('OUT=' + t);",
  "if (!String(t).includes('clicked')) throw new ScriptError('bad text');",
  'return t;',
].join('\n');

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

  const hardKill = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 150s budget exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 140000);
  if (hardKill.unref) hardKill.unref();

  let win = null;
  let es = null;
  try {
    fs.writeFileSync(PAGE_FILE, HTML);
    win = new BrowserWindow({
      width: 800,
      height: 600,
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

    es = createElectronSession({ webContents: win.webContents, profileId: PROFILE_ID });
    await es.start();
    ok('glue session attached (window committed about:blank)');

    // CDP call counter: proves the run went through the real driver, not a mock.
    let cdpCalls = 0;
    const origSend = es.session.sendCommand.bind(es.session);
    es.session.sendCommand = (...args) => {
      cdpCalls++;
      return origSend(...args);
    };

    // Launcher-less direct path: hand the executor a live handle (window + attached glue session).
    const launcher = {
      acquire: (id) =>
        id === PROFILE_ID
          ? {
              window: win,
              webContents: win.webContents,
              electronSession: win.webContents.session,
              session: es.session,
              adapter: es.adapter,
              rng: es.rng,
            }
          : undefined,
    };
    const runnerFactory = createElectronExecutor({ launcher }).for({ id: PROFILE_ID });

    const store = createScriptStore({});
    const script = store.create({
      name: PROFILE_ID,
      code: CODE,
      parameters: [{ name: 'url', type: 'string', required: true }],
    });
    const manager = createAutomationManager({ store, runnerFactory });

    const rec = await manager.runScript(script.id, {
      params: { url: PAGE_URL },
      profileContext: { id: PROFILE_ID },
    });

    if (rec && rec.status === 'SUCCESS') ok('record status SUCCESS');
    else bad('record status SUCCESS', new Error('status=' + (rec && rec.status) + ' error=' + JSON.stringify(rec && rec.error)));
    if (rec && rec.profileId === PROFILE_ID) ok('record profileId propagated');
    else bad('record profileId propagated', new Error('profileId=' + (rec && rec.profileId)));
    if (rec && rec.result === 'clicked') ok('result is clicked');
    else bad('result is clicked', new Error('result=' + JSON.stringify(rec && rec.result)));

    const logs = (rec && rec.logs) || [];
    const outSeen = logs.some((l) => (l.args || []).some((a) => String(a).startsWith('OUT=')));
    if (outSeen) ok('logs contain OUT= (' + logs.length + ' lines)');
    else bad('logs contain OUT=', new Error('logs=' + JSON.stringify(logs)));
    if (cdpCalls > 0) ok('browserApi real (CDP calls=' + cdpCalls + ')');
    else bad('browserApi real', new Error('zero CDP calls'));

    // Direct CDP read after the run proves the real window DOM toggled.
    const res = await origSend('Runtime.evaluate', {
      expression: "document.querySelector('#out').textContent",
      returnByValue: true,
    });
    const dom = res && res.result && res.result.value;
    if (dom === 'clicked') ok('window DOM toggled via driver');
    else bad('window DOM toggled via driver', new Error('dom=' + JSON.stringify(dom)));

    // Executor error path: unknown profile -> ProfileError (synchronous from runnerFactory).
    try {
      createElectronExecutor({ launcher }).for({ id: 'no-such-profile' })();
      bad('missing live session throws ProfileError', new Error('expected throw, got runner'));
    } catch (e) {
      if (e && e.name === 'ProfileError') ok('missing live session throws ProfileError');
      else bad('missing live session throws ProfileError', e);
    }

    // Failure-forensics leg (§16): same real fixture, navigate then throw. Exercises the
    // runner's trace capture against the live driver ring/DOM/URL. The shipped facade delegates
    // page.evaluate/getCurrentUrl to the driver only when the driver exposes them, and page.js
    // currently does NOT, so those two are supplied here over the SAME real glue session to keep
    // the html/url capture path covered; the production-executor leg below covers the shipped facade.
    try {
      const { createScriptRunner } = require('./runtime/script-runner');
      const { createPageDriver } = require('./electron/page');
      const { createBrowserApi } = require('./electron/browser-api');

      const fdriver = createPageDriver({ webContents: win.webContents, session: es.session, adapter: es.adapter, rng: es.rng });
      await fdriver.enableNetwork(); // ring only fills after Network.enable
      const fapi = createBrowserApi({ page: fdriver, adapter: es.adapter, electronSession: win.webContents.session, profileContext: { id: PROFILE_ID } });
      fapi.page = Object.assign({}, fapi.page, {
        evaluate: (expr) =>
          es.session
            .sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true })
            .then((res2) => res2 && res2.result && res2.result.value),
        getCurrentUrl: () => win.webContents.getURL(),
      });
      const FAIL_CODE = ["step('nav');", 'await browser.goto(params.url);', "throw new ScriptError('boom');"].join('\n');
      const failScript = store.create({
        name: 'e2e-fail',
        code: FAIL_CODE,
        parameters: [{ name: 'url', type: 'string', required: true }],
      });
      const failManager = createAutomationManager({
        store,
        runnerFactory: () => createScriptRunner({ browserApi: fapi }),
      });
      const frec = await failManager.runScript(failScript.id, {
        params: { url: PAGE_URL },
        profileContext: { id: PROFILE_ID },
      });

      if (frec && frec.status === 'FAILED') ok('failure leg status FAILED');
      else bad('failure leg status FAILED', new Error('status=' + (frec && frec.status) + ' error=' + JSON.stringify(frec && frec.error)));

      const shots = (frec && frec.artifacts) || [];
      if (shots.some((a) => a.kind === 'screenshot')) ok('failure leg screenshot artifact');
      else bad('failure leg screenshot artifact', new Error('artifacts=' + JSON.stringify(shots)));

      const tr = frec && frec.trace;
      const diag = JSON.stringify(tr && { bytes: tr.htmlBytes, truncated: tr.htmlTruncated, sources: tr.sources, url: tr.url, n: (tr.network || []).length });
      if (tr && typeof tr.html === 'string' && tr.html.includes('id="out"')) ok('failure leg trace.html fixture marker (' + tr.htmlBytes + ' bytes)');
      else bad('failure leg trace.html fixture marker', new Error('diag=' + diag + ' head=' + (tr && tr.html ? tr.html.slice(0, 80) : null)));

      if (tr && tr.htmlBytes <= 262144 && tr.htmlTruncated === false) ok('failure leg trace.html within cap');
      else bad('failure leg trace.html within cap', new Error('diag=' + diag));

      if (tr && Array.isArray(tr.network) && tr.network.length >= 1) ok('failure leg trace.network (' + tr.network.length + ')');
      else bad('failure leg trace.network >=1', new Error('diag=' + diag));

      if (tr && tr.url === PAGE_URL) ok('failure leg trace.url fixture');
      else bad('failure leg trace.url fixture', new Error('diag=' + diag));
    } catch (e) {
      bad('failure leg harness', e);
    }

    // Production-path forensics (§16 gap closure): the SHIPPED facade built by the executor from
    // the live handle — no hand-built browserApi. network.enable() is the newly-wired primitive,
    // so the ring fills and trace.network is non-empty on the real production path. page.js still
    // exposes no evaluate/getCurrentUrl, so trace.html/trace.url sources stay false here (reported).
    try {
      const prodFactory = createElectronExecutor({ launcher }).for({ id: PROFILE_ID });
      const prodManager = createAutomationManager({ store, runnerFactory: prodFactory });
      const PROD_FAIL = [
        "step('nav');",
        'await network.enable();',
        'await browser.goto(params.url);',
        "throw new ScriptError('boom');",
      ].join('\n');
      const prodScript = store.create({
        name: 'e2e-fail-prod',
        code: PROD_FAIL,
        parameters: [{ name: 'url', type: 'string', required: true }],
      });
      const prec = await prodManager.runScript(prodScript.id, {
        params: { url: PAGE_URL },
        profileContext: { id: PROFILE_ID },
      });
      const ptr = prec && prec.trace;
      const pdiag = JSON.stringify(ptr && { sources: ptr.sources, n: (ptr.network || []).length, url: ptr.url });
      if (prec && prec.status === 'FAILED' && ptr && ptr.sources.network === true && Array.isArray(ptr.network) && ptr.network.length >= 1) {
        ok('production executor facade trace.network non-empty (' + ptr.network.length + ')');
      } else {
        bad('production executor facade trace.network non-empty', new Error('status=' + (prec && prec.status) + ' diag=' + pdiag));
      }
      if (ptr && ptr.sources.html === true && typeof ptr.html === 'string' && ptr.html.includes('id="out"')) {
        ok('production executor facade trace.html fixture marker (' + ptr.htmlBytes + ' bytes)');
      } else {
        bad('production executor facade trace.html fixture marker', new Error('diag=' + pdiag));
      }
      if (ptr && ptr.sources.url === true && ptr.url === PAGE_URL) {
        ok('production executor facade trace.url fixture');
      } else {
        bad('production executor facade trace.url fixture', new Error('diag=' + pdiag));
      }
    } catch (e) {
      bad('production executor path harness', e);
    }

    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await new Promise((r) => setTimeout(r, 300)); // let piped stdout flush before exit
    clearTimeout(hardKill);
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try {
      app.exit(process.exitCode);
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000);
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
    try {
      clearTimeout(hardKill);
    } catch (_) {}
    destroyAll();
    process.exitCode = 1;
    try {
      app.exit(1);
    } catch (_) {
      process.exit(1);
    }
  }
}

main();
