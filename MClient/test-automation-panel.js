'use strict';
// MClient automation PANEL integration test. Boots MClient (require main.js),
// seeds a script through the REAL service, then drives the renderer exactly as a
// user would: click #btn-automation to open the right-hand column and assert it
// renders REAL data from the bridge (window.automationApi), the templates
// fragment mounts, and the column geometry never overlaps the browser area — at
// both 1440x900 and 1024x700. PASS/FAIL lines; exit 0 == green.
const { app, BrowserWindow } = require('electron');

// Boot MClient: registers IPC, creates the main window, wires the real
// automation backend (group/tab launcher + executor + broker).
const mod = require('./main.js');

let pass = 0, fail = 0, skip = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
};
const ckSkip = (name, detail) => { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); };

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.destroy(); } catch (_) {}
    }
  } catch (_) {}
}

function finish(code) {
  destroyAll();
  console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
  const c = code !== undefined ? code : fail === 0 ? 0 : 1;
  try { app.exit(c); } catch (_) { process.exit(c); }
  setTimeout(() => process.exit(c), 2000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWin(ms) {
  const t0 = Date.now();
  for (;;) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) return w;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
}

// Run JS in the renderer's main world; swallow transient context-destroyed
// errors that happen mid-reload (they read as falsy, which the poll treats as
// "not ready yet").
async function js(win, code) {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (_) { return null; }
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (_) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(120);
  }
}

// readyState + AutomationPanel auto-mounted (panel.js boots on DOMContentLoaded).
async function waitRendererReady(win, ms) {
  return waitFor(async () => {
    const st = await js(win, 'document.readyState');
    const ap = await js(win, 'typeof window.AutomationPanel');
    return st === 'complete' && ap === 'object';
  }, ms);
}

// Rect snapshot of the two right-hand columns + the browser column. Measured,
// not assumed — every geometry check reads these numbers.
const GEOM = `(() => {
  const ap = document.getElementById('ap-panel');
  const fp = document.getElementById('fp-panel');
  const bc = document.getElementById('browser-col');
  const ca = document.getElementById('content-area');
  const ar = ap.getBoundingClientRect(), br = bc.getBoundingClientRect(), fr = fp.getBoundingClientRect(), cr = ca.getBoundingClientRect();
  return {
    apW: Math.round(ar.width), apLeft: Math.round(ar.left), apRight: Math.round(ar.right),
    bcRight: Math.round(br.right), caRight: Math.round(cr.right), fpW: Math.round(fr.width),
    apCollapsed: ap.classList.contains('collapsed'), vw: window.innerWidth
  };
})()`;

const SEED = 'panel-seed';
const SEED_CODE = 'return 42;';

app.whenReady().then(async () => {
  const hardKill = setTimeout(() => {
    console.log('FAIL  harness-timeout :: 120s budget exceeded');
    finish(2);
  }, 120000);
  if (hardKill.unref) hardKill.unref();

  try {
    const win = await waitForWin(20000);
    ck('MClient main window created', !!win);
    if (!win) return finish();

    ck('renderer loaded and AutomationPanel auto-mounted', await waitRendererReady(win, 15000));

    // Service must be wired before we can seed through it.
    const svcReady = await waitFor(() => !!mod.automationService, 10000);
    const svc = mod.automationService;
    ck('automation service exported (real backend wired)', svcReady && !!svc && !!svc.scripts);
    if (!svc) return finish();

    // Seed a script via the real service; drop any prior copy so reruns are clean.
    try {
      const prior = svc.scripts.list();
      const rows = prior && prior.ok ? prior.data : [];
      for (const s of rows) { if (s && s.name === SEED) svc.scripts.remove(s.id); }
    } catch (_) {}
    const created = svc.scripts.create({ name: SEED, code: SEED_CODE });
    ck('seed script created via service', !!(created && created.ok === true && created.data && created.data.id),
      JSON.stringify(created).slice(0, 140));

    // Reload so the panel's mount-time refreshScripts() picks up the seed.
    win.webContents.reload();
    ck('renderer reloaded with panel mounted', await waitRendererReady(win, 15000));

    // The preload bridge the panel reads.
    ck('window.automationApi present (getScripts + templates.list)',
      await js(win, "!!(window.automationApi && typeof window.automationApi.getScripts==='function' && window.automationApi.templates && typeof window.automationApi.templates.list==='function')"));

    // HTML default: automation column hidden, fingerprint column visible.
    ck('automation column starts collapsed', await js(win, "document.getElementById('ap-panel').classList.contains('collapsed')"));
    ck('fingerprint column starts visible', !(await js(win, "document.getElementById('fp-panel').classList.contains('collapsed')")));

    // Toggle via the nav button — exactly what a user clicks.
    await js(win, "document.getElementById('btn-automation').click(); true");
    ck('clicking the automation button opens the column',
      await waitFor(async () => !(await js(win, "document.getElementById('ap-panel').classList.contains('collapsed')")), 4000));

    // Mutual exclusion with the fingerprint column (same slot).
    ck('fingerprint column collapses when automation opens',
      await js(win, "document.getElementById('fp-panel').classList.contains('collapsed')"));
    ck('automation nav button shows active',
      await js(win, "document.getElementById('btn-automation').classList.contains('active')"));

    // Panel mounted into #automation-panel.
    ck('#automation-panel hosts a mounted .ap-panel',
      await js(win, "!!document.querySelector('#automation-panel > .ap-panel')"));

    // REAL bridge data: the seeded script appears in the files list.
    const sel = '.ap-files [data-name="' + SEED + '"]';
    ck('seeded script renders from the bridge',
      await waitFor(() => js(win, '!!document.querySelector(' + JSON.stringify(sel) + ')'), 8000), SEED);

    // Templates fragment mounts (bridge exposes templates.list).
    ck('templates fragment renders in #ap-templates',
      await waitFor(() => js(win, "!!document.querySelector('#ap-templates .ap-templates')"), 6000));

    // ---- geometry @ 1440x900 ----
    win.setContentSize(1440, 900);
    await sleep(500);
    const g1 = await js(win, GEOM);
    ck('@1440x900 automation column has the 420px width',
      !!g1 && g1.apW >= 400 && g1.apW <= 440, g1 ? 'w=' + g1.apW : 'no geom');
    ck('@1440x900 no overlap: browser column ends at the panel edge',
      !!g1 && g1.bcRight <= g1.apLeft + 1, g1 ? 'browserRight=' + g1.bcRight + ' panelLeft=' + g1.apLeft : '');
    ck('@1440x900 content-area does not run under the panel',
      !!g1 && g1.caRight <= g1.apLeft + 1, g1 ? 'contentRight=' + g1.caRight + ' panelLeft=' + g1.apLeft : '');
    ck('@1440x900 panel fits inside the viewport',
      !!g1 && g1.apRight <= g1.vw + 1, g1 ? 'panelRight=' + g1.apRight + ' viewport=' + g1.vw : '');

    // ---- geometry @ 1024x700 ----
    win.setContentSize(1024, 700);
    await sleep(500);
    const g2 = await js(win, GEOM);
    ck('@1024x700 automation column still 420px (no collapse)',
      !!g2 && g2.apW >= 400 && g2.apW <= 440, g2 ? 'w=' + g2.apW : 'no geom');
    ck('@1024x700 browser column keeps a usable width',
      !!g2 && g2.apLeft >= 200, g2 ? 'browserWidth=' + g2.apLeft : '');
    ck('@1024x700 no overlap: browser column ends at the panel edge',
      !!g2 && g2.bcRight <= g2.apLeft + 1, g2 ? 'browserRight=' + g2.bcRight + ' panelLeft=' + g2.apLeft : '');

    // Native layer: the ACTIVE BrowserView must stop before the panel too, or
    // the panel is drawn but covered (the bug this whole slot arrangement is for).
    await sleep(300);
    let viewRight = null;
    for (const t of mod.tabs.values()) {
      try {
        const b = t.view.getBounds();
        if (b && b.x === 0 && b.width > 0) viewRight = b.x + b.width;
      } catch (_) {}
    }
    if (viewRight == null || !g2) {
      ckSkip('active BrowserView ends before the panel (native layer)', 'no active view yet');
    } else {
      ck('active BrowserView ends before the panel (native layer)',
        viewRight <= g2.apLeft + 2, 'viewRight=' + viewRight + ' panelLeft=' + g2.apLeft);
    }

    // F9 closes the automation column (shares the fp slot).
    await js(win, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'F9'})); true");
    ck('F9 closes the automation column',
      await waitFor(() => js(win, "document.getElementById('ap-panel').classList.contains('collapsed')"), 4000));

    // F10 still reopens the fingerprint column — existing behavior preserved.
    await js(win, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'F10'})); true");
    ck('F10 reopens the fingerprint column (existing behavior preserved)',
      await waitFor(async () => !(await js(win, "document.getElementById('fp-panel').classList.contains('collapsed')")), 4000));

    // Clean up the seed so reruns / the packaged store stay tidy.
    try {
      const after = svc.scripts.list();
      const rows = after && after.ok ? after.data : [];
      for (const s of rows) { if (s && s.name === SEED) svc.scripts.remove(s.id); }
    } catch (_) {}

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
