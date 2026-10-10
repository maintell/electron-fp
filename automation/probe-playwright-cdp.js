'use strict';
// ponytail: real-binary E2E — the REAL playwright-core connects to the published cdpUrl
// (connectOverCDP) and drives the launcher-started page; context.tracing produces a zip.
// playwright-core is deliberately NOT vendored (project stance): set PW_CORE to its module
// dir (e.g. .../node_modules/playwright-core) or install it so require('playwright-core')
// resolves; without it the probe SKIPs.
//
// Run (built binary; stash resources/app first per AGENTS.md):
//   $env:PW_CORE = 'F:\Temp\opencode\pw\node_modules\playwright-core'
//   electron.exe automation\probe-playwright-cdp.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { createElectronLauncher } = require('./electron/launcher');
const { createProfileManager } = require('./runtime/profile-manager');
const { createProfileCdpServer } = require('./electron/cdp-server');

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name) {
  pass++;
  console.log('PASS ' + name);
}
function bad(name, err) {
  fail++;
  console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : String(err)));
}
function sk(name, why) {
  skip++;
  console.log('SKIP ' + name + ' :: ' + why);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE_FILE = 'F:\\Temp\\pw-e2e.html';
const FIXTURE_URL = 'file:///F:/Temp/pw-e2e.html';
const TITLE = 'PW-CDP-42';
const TOKEN = 'tk';
const TRACE_PATH = 'F:\\Temp\\pw-trace.zip';

function loadPlaywright() {
  if (process.env.PW_CORE) return require(process.env.PW_CORE);
  try {
    return require('playwright-core');
  } catch (_) {
    return null;
  }
}

let PW_VERSION = '';
try {
  PW_VERSION = require((process.env.PW_CORE || 'playwright-core') + '/package.json').version;
} catch (_) {}

let lastWindow = null;
async function createWindow(partition) {
  // launcher.start loads about:blank + waits for the committed load itself
  lastWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  return lastWindow;
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
  }, 150000);
  if (hardKill.unref) hardKill.unref();

  const pw = loadPlaywright();
  if (!pw) {
    sk('playwright-core available', 'not installed (set PW_CORE to .../node_modules/playwright-core)');
    console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
    app.exit(0);
    return;
  }
  ok('playwright-core loaded');

  let launcher = null;
  let pm = null;
  let cdpSrv = null;
  let browser = null;
  let profileId = null;

  try {
    fs.writeFileSync(FIXTURE_FILE, '<html><head><title>' + TITLE + '</title></head><body><div id="d">hi</div></body></html>');
    try { fs.unlinkSync(TRACE_PATH); } catch (_) {}

    launcher = createElectronLauncher({ createWindow });
    pm = createProfileManager({ launcher });
    const p = pm.create({ name: 'pw-host' });
    profileId = p.id;
    await pm.start(profileId); // launcher.start -> hidden window, inProcess endpoint
    ok('profile started via launcher (inProcess endpoint)');

    cdpSrv = createProfileCdpServer({
      launcher,
      token: TOKEN,
      onUrl: (id, url) => pm.setEndpoint(id, { cdpUrl: url }),
    });
    await cdpSrv.start();
    cdpSrv.publish(profileId);

    const ep = pm.status(profileId).endpoint;
    assert(ep && ep.inProcess === true && typeof ep.cdpUrl === 'string', 'endpoint=' + JSON.stringify(ep));
    assert(ep.cdpUrl === cdpSrv.urlFor(profileId), 'published vs urlFor mismatch');
    console.log('INFO publishedCdpUrl=' + ep.cdpUrl);
    ok('published cdpUrl equals urlFor(profile)');

    // --- the real client: connectOverCDP (setAutoAttach -> attachedToTarget discovery) ---
    browser = await pw.chromium.connectOverCDP(ep.cdpUrl);
    ok('connectOverCDP succeeded (real playwright-core' + (PW_VERSION ? ' v' + PW_VERSION : '') + ')');

    const ctx = browser.contexts()[0];
    assert(ctx, 'no browser context discovered');
    // attachedToTarget is processed asynchronously by the client: poll, don't assert once
    let pages = [];
    const pt0 = Date.now();
    while (Date.now() - pt0 < 8000) {
      pages = ctx.pages();
      if (pages.length === 1) break;
      await sleep(200);
    }
    assert(pages.length === 1, 'pages=' + pages.length);
    ok('page discovered via setAutoAttach -> attachedToTarget (pages=' + pages.length + ')');
    const page = pages[0];
    page.setDefaultTimeout(15000);

    await page.goto(FIXTURE_URL);
    const t1 = await page.title();
    assert(t1 === TITLE, 'title=' + JSON.stringify(t1));
    ok('page.goto + page.title() = ' + t1);
    const ev = await page.evaluate('1+1');
    assert(ev === 2, 'eval=' + ev);
    ok('page.evaluate via real playwright = 2');

    // --- tracing (the observability boundary): client-side zip over the same bridge ---
    if (lastWindow) lastWindow.showInactive(); // screencast needs a visible surface
    await sleep(400);
    await ctx.tracing.start({ screenshots: true, snapshots: true });
    await page.goto(FIXTURE_URL + '?2');
    await page.evaluate('document.title');
    await ctx.tracing.stop({ path: TRACE_PATH });
    const st = fs.statSync(TRACE_PATH);
    const magic = fs.readFileSync(TRACE_PATH).subarray(0, 4).toString('latin1');
    assert(st.size > 1000 && magic === 'PK\x03\x04', 'trace size=' + st.size + ' magic=' + JSON.stringify(magic));
    ok('context.tracing zip written (' + st.size + ' bytes, PK magic)');

    // --- teardown ---
    try { await browser.close(); } catch (_) {}
    browser = null;
    await sleep(200);
    await cdpSrv.stop();
    await cdpSrv.stop(); // idempotent
    await pm.stop(profileId);
    destroyAll();
    assert(BrowserWindow.getAllWindows().length === 0, 'windows left: ' + BrowserWindow.getAllWindows().length);
    assert(launcher.list().length === 0, 'launcher handles left: ' + JSON.stringify(launcher.list()));
    ok('teardown clean (cdp stopped, profile stopped, 0 windows, 0 launcher handles)');

    console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
    await sleep(300);
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
    } catch (_) {}
  } finally {
    try {
      destroyAll();
    } catch (_) {}
    try {
      app.exit(fail === 0 ? 0 : 1);
    } catch (_) {
      process.exit(fail === 0 ? 0 : 1);
    }
  }
}

main();
