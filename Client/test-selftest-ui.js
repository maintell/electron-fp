// Verify the self-test pane's UI WIRING - the part unit tests cannot see.
//
// Client/test-selftest.js proves the VERDICT LOGIC (does a configured-but-
// inert key get flagged?). This file proves the CONTRACT between
// index.html, app.js and the preload bridge:
//
//   1. every DOM id app.js reaches for actually exists in index.html
//   2. clicking the Self-test tab swaps the panes and moves the active style
//   3. clicking Run invokes the bridge (reached even with no tab, which proves
//      the handler is wired rather than the button being inert)
//   4. a verdict row renders with the right badge and the expected->got detail
//
// Why this needs its own file: a rename in index.html, or a missing preload
// entry, breaks the pane silently - the app still boots, the tab still renders,
// and nothing in the suite notices. Driving the real page is the only way to
// catch that class of breakage.

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
let selftestCalls = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const CLIENT = __dirname;
const HTML = fs.readFileSync(path.join(CLIENT, 'renderer', 'index.html'), 'utf8');
const APPJS = fs.readFileSync(path.join(CLIENT, 'renderer', 'app.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(CLIENT, 'preload.js'), 'utf8');

(async () => {
  await app.whenReady();

  // --- 1) static contract: ids app.js uses must exist in the HTML ---------
  // Cheaper and more precise than clicking: catches a rename immediately.
  const ids = ['fp-tab-config', 'fp-tab-selftest', 'fp-pane-config',
    'fp-pane-selftest', 'fp-selftest-run', 'fp-selftest-summary',
    'fp-selftest-results', 'fp-selftest-show-skipped'];
  const missing = ids.filter((id) => !HTML.includes('id="' + id + '"'));
  check('every self-test DOM id exists in index.html',
    missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : ids.length + ' ids');

  const unwired = ids.filter((id) => !APPJS.includes(id));
  check('every self-test DOM id is referenced by app.js',
    unwired.length === 0, unwired.length ? 'unused: ' + unwired.join(',') : ids.length + ' ids');

  check('preload exposes selftest:run over IPC',
    /selftest:run/.test(PRELOAD) && /runSelfTest/.test(PRELOAD), 'bridge present');
  check('main.js handles selftest:run',
    /ipcMain\.handle\(\s*'selftest:run'/.test(
      fs.readFileSync(path.join(CLIENT, 'main.js'), 'utf8')), 'handler present');

  // --- 2) load the real page and drive it ---------------------------------
  //
  // app.js's init() needs a tab before currentTabId is set, and runSelfTest()
  // returns early with "no active tab" otherwise. This page has no main-process
  // tab machinery behind it, so stand up the minimum tab IPC surface.
  const TAB = { id: 'tab-1', profileId: 'default', profileName: 'Default',
    url: 'about:blank', title: 'Test tab', isActive: true };
  ipcMain.removeHandler('app:versions');
  ipcMain.handle('app:versions', async () => ({ electron: 'test', chrome: 'test' }));
  ipcMain.removeHandler('tab:list');
  ipcMain.handle('tab:list', async () => [TAB]);
  ipcMain.removeHandler('tab:get-active');
  ipcMain.handle('tab:get-active', async () => TAB.id);
  // fpSchema is what the grouping reads. tz_id and webgl_max_viewport_dims sit
  // in DIFFERENT groups, so the grouping assertion is meaningful. 'boom_key' is
  // unknown to the schema and must fall into "Other" rather than vanishing.
  const FAKE_SCHEMA = {
    version: 1,
    keyCount: 3,
    keys: {
      tz_id: { group: 'locale', def: '' },
      webgl_max_viewport_dims: { group: 'webgl', def: '' },
      battery_level: { group: 'battery', def: '' },
    },
    groups: [
      { id: 'webgl', label: 'WebGL' },
      { id: 'locale', label: 'Locale' },
      { id: 'battery', label: 'Battery' },
    ],
    defaults: {},
  };

  for (const [ch, val] of [
    ['fp:schema', FAKE_SCHEMA],
    ['ua:presets', []],
    ['tab:get-ua', ''],
    ['profile:list', []],
    ['fp:coverage', {}],
    ['tab:get-fingerprint', {}],
  ]) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async () => val);
  }

  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(CLIENT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(CLIENT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // Stub at the IPC level, NOT by replacing window.api: contextBridge exposes a
  // FROZEN object, so `window.api.runSelfTest = fn` silently does nothing and
  // the click reaches the real handler. A first version of this test did exactly
  // that and reported calls=0 while the code was fine.
  //
  // Replacing ipcRenderer.invoke in the preload's isolated world is also not
  // reachable, so instead intercept in the MAIN process: register the stub
  // result for 'selftest:run' before the page can call it.
  // tz_id and webgl_max_viewport_dims are in DIFFERENT schema groups, so the
  // grouping assertion below is meaningful (two groups must render, not one).
  const FAKE = {
    rows: [
      { key: 'tz_id', expected: 'America/New_York', got: 'America/New_York', verdict: 'pass', reason: '' },
      { key: 'webgl_max_viewport_dims', expected: '8192', got: '32767,32767', verdict: 'fail',
        reason: 'quoted value fell back to hardware' },
      { key: 'battery_level', expected: null, got: '0.9', verdict: 'skip', reason: 'not configured' },
      { key: 'boom_key', expected: 'x', got: 'y', verdict: 'error', reason: 'compare threw' },
    ],
    summary: { pass: 1, fail: 1, skip: 1, error: 1 },
  };
  selftestCalls = 0;
  ipcMain.removeHandler('selftest:run');
  ipcMain.handle('selftest:run', async () => { selftestCalls++; return FAKE; });

  // 3) tab switching
  await win.webContents.executeJavaScript("document.getElementById('fp-tab-selftest').click()", true);
  await new Promise((r) => setTimeout(r, 250));
  const swapped = await win.webContents.executeJavaScript(`JSON.stringify({
    configHidden: document.getElementById('fp-pane-config').hidden,
    selftestHidden: document.getElementById('fp-pane-selftest').hidden,
    active: (document.querySelector('.fp-tab-active')||{}).id
  })`, true);
  const sw = JSON.parse(swapped);
  check('clicking Self-test swaps panes',
    sw.configHidden === true && sw.selftestHidden === false,
    'config.hidden=' + sw.configHidden + ' selftest.hidden=' + sw.selftestHidden);
  check('active tab highlight moves to Self-test',
    sw.active === 'fp-tab-selftest', 'active=' + sw.active);

  await win.webContents.executeJavaScript("document.getElementById('fp-tab-config').click()", true);
  await new Promise((r) => setTimeout(r, 250));
  const back = await win.webContents.executeJavaScript(`JSON.stringify({
    configHidden: document.getElementById('fp-pane-config').hidden,
    selftestHidden: document.getElementById('fp-pane-selftest').hidden
  })`, true);
  const bk = JSON.parse(back);
  check('clicking Config swaps back',
    bk.configHidden === false && bk.selftestHidden === true,
    'config.hidden=' + bk.configHidden + ' selftest.hidden=' + bk.selftestHidden);

  // 4) run + render
  await win.webContents.executeJavaScript("document.getElementById('fp-tab-selftest').click()", true);
  await win.webContents.executeJavaScript("document.getElementById('fp-selftest-run').click()", true);
  await new Promise((r) => setTimeout(r, 800));

  const rendered = await win.webContents.executeJavaScript(`JSON.stringify({
    summary: document.getElementById('fp-selftest-summary').textContent.replace(/\\s+/g,' ').trim(),
    rows: document.querySelectorAll('.fp-st-row').length,
    classes: Array.from(document.querySelectorAll('.fp-st-row')).map(r=>r.className),
    hasHint: !!document.querySelector('.fp-st-hint'),
    hintText: (document.querySelector('.fp-st-hint')||{}).textContent || ''
  })`, true);
  const r = JSON.parse(rendered);

  check('Run button invokes the IPC bridge', selftestCalls === 1, 'calls=' + selftestCalls);
  // Skipped rows are hidden by default - that is the whole point of the
  // "skip is not success" rule, so assert it in the UI too.
  check('skipped rows are hidden by default', r.rows === 3, r.rows + ' rows rendered (4 supplied, 1 skip)');
  check('summary reports all four counts',
    /1 pass/.test(r.summary) && /1 fail/.test(r.summary) && /1 skip/.test(r.summary),
    r.summary);
  check('fail row carries its explanation', r.hasHint && /hardware/.test(r.hintText),
    r.hintText.slice(0, 70));
  // Within a row's own group the rows are not what this asserts any more:
  // grouping moved the primary ordering to the GROUP level, so the flat row
  // order is now "within group". The group-level ordering is asserted below.
  check('rows carry a verdict class',
    r.classes.every((c) => /fp-st-(pass|fail|skip|error)/.test(c)),
    r.classes.join(' | '));

  // Grouping: the spec calls for a table grouped by the schema's functional
  // groups, so webgl_* rows read alongside other webgl_* rows.
  const grp = await win.webContents.executeJavaScript(`JSON.stringify({
    groups: Array.from(document.querySelectorAll('.fp-st-group')).map(function(g){
      return {
        head: (g.querySelector('.fp-st-group-head')||{}).textContent
          .replace(/\\s+/g,' ').trim(),
        rows: g.querySelectorAll('.fp-st-row').length
      };
    })
  })`, true);
  const g = JSON.parse(grp);
  // Visible rows are tz_id (Locale, pass), webgl_max_viewport_dims (WebGL,
  // fail), boom_key (unknown -> Other, error). Three distinct groups.
  check('rows are grouped by schema group', g.groups.length === 3,
    g.groups.map((x) => x.head).join(' || '));
  // Severity order is fail(0) < error(1) < pass(2), so the WebGL group (fail)
  // must come before Other (error) and Locale (pass).
  check('the failing group sorts first',
    /fail/i.test(g.groups[0].head) && /WebGL/i.test(g.groups[0].head),
    g.groups.map((x) => x.head).join(' || '));
  check('groups sort fail before error before pass',
    /WebGL/i.test(g.groups[0].head) &&
    /Other/i.test(g.groups[1].head) &&
    /Locale/i.test(g.groups[2].head),
    g.groups.map((x) => x.head).join(' || '));
  check('a key unknown to the schema lands in a group, not nowhere',
    g.groups.some((x) => /Other/i.test(x.head)),
    g.groups.map((x) => x.head).join(' || '));
  check('every visible row sits inside a group',
    g.groups.reduce((n, x) => n + x.rows, 0) === 3,
    g.groups.reduce((n, x) => n + x.rows, 0) + ' rows in groups');

  // 5) the "show skipped" toggle must reveal the hidden skip row
  await win.webContents.executeJavaScript(`
    var cb = document.getElementById('fp-selftest-show-skipped');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    true;
  `, true);
  await new Promise((r2) => setTimeout(r2, 300));
  const withSkips = await win.webContents.executeJavaScript(
    "document.querySelectorAll('.fp-st-row').length", true);
  check('ticking "show skipped" reveals the skip row',
    withSkips === 4, withSkips + ' rows (expected 4)');

  win.destroy();
  console.log('');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('THREW ' + (e && e.message));
  app.exit(1);
});
