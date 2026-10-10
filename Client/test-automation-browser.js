'use strict';
// Client REAL-browser automation test. Boots Client, creates a tab (the live
// BrowserView), then runs an automation script whose profileContext.id is that
// tab id. The script drives the real tab through the executor → attach broker →
// page driver stack, so the proof is real DOM/cookie I/O on the live
// webContents — not a pure-script no-op. PASS/FAIL lines; exit 0 == green.
const { app, BrowserWindow } = require('electron');

// Boot Client: registers IPC, creates the main window, wires the real
// automation backend (per-tab launcher + executor + broker).
const mod = require('./main.js');

let pass = 0;
let fail = 0;
const ck = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (detail ? ': ' + detail : ''));
  } else {
    fail++;
    console.log('FAIL  ' + name + (detail ? ': ' + detail : ''));
  }
};

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.destroy(); } catch (_) {}
    }
  } catch (_) {}
}

function finish(code) {
  destroyAll();
  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  const c = code !== undefined ? code : fail === 0 ? 0 : 1;
  try { app.exit(c); } catch (_) { process.exit(c); }
  setTimeout(() => process.exit(c), 2000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWin(ms) {
  const t0 = Date.now();
  for (;;) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed() && !w.webContents.isLoading()) return w;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
}

// CDP attach needs a COMMITTED load (about:blank is enough) — see page.js header.
async function ensureCommitted(wc, ms = 10000) {
  if (wc.isLoading()) {
    await Promise.race([
      new Promise((r) => wc.once('did-finish-load', r)),
      sleep(ms),
    ]);
  }
  if (!wc.getURL()) {
    await Promise.race([wc.loadURL('about:blank').catch(() => {}), sleep(ms)]);
  }
}

const DATA_URL = 'data:text/html,<h1 id=t>hello</h1><input id=i>';
const CODE = [
  "step('drive real tab');",
  'await browser.goto(' + JSON.stringify(DATA_URL) + ');',
  "await page.fill('#i', 'x');",
  "const txt = await page.getText('#t');",
  "const val = await page.getValue('#i');",
  'const url = await page.getCurrentUrl();',
  "await cookies.set({ url: 'http://127.0.0.1/', name: 'fpck', value: 'fpval' });",
  "const jar = await cookies.get({ name: 'fpck' });",
  'const cookie = jar && jar.length ? jar[0].value : null;',
  'return { txt, val, url, cookie };',
].join('\n');

app.whenReady().then(async () => {
  const hardKill = setTimeout(() => {
    console.log('FAIL  harness-timeout :: 120s budget exceeded');
    finish(2);
  }, 120000);
  if (hardKill.unref) hardKill.unref();

  try {
    const win = await waitForWin(20000);
    ck('Client main window created', !!win);
    if (!win) return finish();

    const svc = mod.automationService;
    ck('automation service exported (real backend wired)', !!svc && !!svc.run && !!svc.scripts);
    if (!svc) return finish();

    // Create a tab (the live BrowserView the script will drive).
    const tabId = mod.addTab('default');
    const tab = mod.tabs.get(tabId);
    ck('tab created with a live view', !!tab && !!tab.view && !!tab.view.webContents, 'tabId=' + tabId);
    if (!tab || !tab.view || !tab.view.webContents) return finish();

    const wc = tab.view.webContents;
    await ensureCommitted(wc);
    ck('tab committed a load (attach precondition)', !!wc.getURL(), 'url=' + wc.getURL());

    // Default permissions have browser/cookies/storage/network ON.
    const created = svc.scripts.create({ name: 'client-browser', code: CODE });
    ck('script created (default browser perms)', created && created.ok === true && !!created.data && !!created.data.id,
      JSON.stringify(created).slice(0, 160));
    if (!created || created.ok !== true) return finish();
    const scriptId = created.data.id;
    ck('script permissions.browser is true', created.data.permissions && created.data.permissions.browser === true,
      JSON.stringify(created.data.permissions));

    const res = await svc.run.runScript(scriptId, { params: {}, profileContext: { id: tabId } });
    if (!res || res.ok !== true) {
      ck('run returned ok', false, JSON.stringify(res).slice(0, 300));
      return finish();
    }
    const rec = res.data;
    ck('run status SUCCESS', rec.status === 'SUCCESS',
      rec.status + (rec.error ? ' :: ' + JSON.stringify(rec.error).slice(0, 200) : ''));
    ck('record profileId is the tab id', rec.profileId === tabId, 'profileId=' + rec.profileId);

    const out = rec.result || {};
    ck('page.getText is real (txt === hello)', out.txt === 'hello', 'txt=' + JSON.stringify(out.txt));
    ck('page.fill is real (value === x)', out.val === 'x', 'val=' + JSON.stringify(out.val));
    ck('page.getCurrentUrl is real (data URL)', typeof out.url === 'string' && out.url.indexOf('hello') !== -1,
      'url=' + out.url);
    ck('cookies round-trip on the live session', out.cookie === 'fpval', 'cookie=' + JSON.stringify(out.cookie));

    // The script drove THIS tab: the real Client webContents navigated.
    const liveUrl = wc.getURL();
    ck('live Client tab navigated to the script URL', typeof liveUrl === 'string' && liveUrl.indexOf('hello') !== -1,
      'liveUrl=' + liveUrl);

    // Negative: unknown tab -> honest failure (not a silent fake run).
    const bad = await svc.run.runScript(scriptId, { params: {}, profileContext: { id: 'no-such-tab' } });
    ck('unknown tab fails honestly', !!bad && bad.ok === false && /no live session/i.test(String(bad.error && bad.error.message)),
      JSON.stringify(bad).slice(0, 200));

    clearTimeout(hardKill);
    finish();
  } catch (e) {
    fail++;
    console.log('FAIL  threw :: ' + ((e && e.stack) || e));
    finish();
  }
}).catch((e) => {
  fail++;
  console.log('FAIL  whenReady threw :: ' + ((e && e.stack) || e));
  finish();
});
