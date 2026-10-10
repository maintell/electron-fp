#!/usr/bin/env node
// Verify the automation panel is embedded in the Client shell: panel.js mounts
// into the app DOM, the #ap-panel column shares the fingerprint panel's slot
// (mutual exclusion via the nav button / F9), and it is exactly PANEL_WIDTH so
// the BrowserView shrink (layout.js - the SAME module main.js uses) reveals it.
//
// Driven through the REAL renderer files (index.html + app.js + panel.js). No
// preload is attached, so app.js's window.api calls reject - but the listener
// registration and the class toggles in applyPanelLayout() happen BEFORE that
// call, which is what this test measures. panel.js falls back to its empty
// state when no bridge is present.
'use strict';

const { app, BrowserWindow, BrowserView } = require('electron');
const fs = require('fs');
const { PANEL_WIDTH, MIN_VIEW_WIDTH, viewBounds } = require('./layout');

const WIN_W = 1400, WIN_H = 900;
const SHOT = process.env.AP_SHOT || 'F:/Temp/opencode/ap-embedded.png';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: WIN_W, height: WIN_H, webPreferences: { sandbox: false } });
  await win.loadFile(__dirname + '/renderer/index.html');
  await new Promise(r => setTimeout(r, 500));

  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  // --- structure ---
  ck('#ap-panel exists', await js("!!document.getElementById('ap-panel')"));
  ck('#automation-panel mount target exists', await js("!!document.getElementById('automation-panel')"));
  ck('automation scripts precede app.js', await js(
    "(()=>{const s=[...document.scripts].map(x=>x.getAttribute('src'));const a=s.indexOf('automation-panel/panel.js');return a>-1 && a<s.indexOf('app.js');})()"));
  ck('#ap-panel collapsed by default', await js("document.getElementById('ap-panel').classList.contains('collapsed')"));
  ck('#fp-panel visible by default', await js("!document.getElementById('fp-panel').classList.contains('collapsed')"));

  // --- panel.js auto-mount into the app DOM ---
  const kids = await js("document.getElementById('automation-panel').childElementCount");
  ck('panel.js auto-mounted into #automation-panel', kids > 0, 'children=' + kids);

  // --- toggle through the real app.js wiring (nav button) ---
  await js("document.getElementById('btn-automation').click()");
  ck('btn-automation: ap visible', await js("!document.getElementById('ap-panel').classList.contains('collapsed')"));
  ck('btn-automation: fp collapsed (mutual exclusion)', await js("document.getElementById('fp-panel').classList.contains('collapsed')"));

  const colW = parseFloat(await js("getComputedStyle(document.getElementById('ap-panel')).width"));
  ck('ap column width == PANEL_WIDTH', Math.round(colW) === PANEL_WIDTH, colW + ' vs ' + PANEL_WIDTH);

  await js("document.getElementById('btn-profile').click()");
  ck('btn-profile: fp visible', await js("!document.getElementById('fp-panel').classList.contains('collapsed')"));
  ck('btn-profile: ap collapsed', await js("document.getElementById('ap-panel').classList.contains('collapsed')"));

  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'F9'}))");
  ck('F9 opens ap (and closes fp)', await js(
    "!document.getElementById('ap-panel').classList.contains('collapsed') && document.getElementById('fp-panel').classList.contains('collapsed')"));

  // --- embedded layout: the 420px column must not overflow. panel.css's
  //     .ap-main base is a 3-column grid (min ~490px) that clips the editor at
  //     420px; style.css overrides it to the 2-column breakpoint layout. ---
  const L = await js(`(()=>{
    const host=document.getElementById('automation-panel');
    const main=host.querySelector('.ap-main');
    if(!main) return {noMain:true};
    const cs=getComputedStyle(main);
    return {areas:cs.gridTemplateAreas, cols:cs.gridTemplateColumns.split(' ').filter(Boolean).length,
      overflowHost:host.scrollWidth-host.clientWidth, visible:main.clientWidth>0,
      kids:[...main.children].map(c=>({w:c.clientWidth,a:getComputedStyle(c).gridArea}))};
  })()`);
  ck('embedded Scripts view has .ap-main', !L.noMain, JSON.stringify(L));
  ck('embedded .ap-main uses the 2-col override', !L.noMain && /files editor/.test(L.areas || '') && L.cols === 2,
    'areas=' + L.areas + ' cols=' + L.cols);
  ck('#automation-panel has no horizontal overflow', !L.noMain && (L.overflowHost || 0) <= 1, 'overflow=' + L.overflowHost);
  ck('visible grid children have non-zero width', !L.noMain && (!L.visible || L.kids.every(k => k.w > 0)), JSON.stringify(L.kids));

  // --- geometry: the open column is revealed (view ends before it) ---
  const [cw, ch] = win.getContentSize();
  const openB = viewBounds(cw, ch, true), closedB = viewBounds(cw, ch, false);
  ck('viewBounds open == closed - PANEL_WIDTH', openB.width === closedB.width - PANEL_WIDTH, openB.width + ' / ' + closedB.width);
  ck('viewBounds open keeps MIN_VIEW_WIDTH', openB.width >= MIN_VIEW_WIDTH, openB.width + ' >= ' + MIN_VIEW_WIDTH);

  const view = new BrowserView({ webPreferences: { sandbox: false } });
  win.addBrowserView(view);
  view.setBounds(openB);
  const b = view.getBounds();
  ck('BrowserView stops before the open ap column', b.x + b.width <= cw - PANEL_WIDTH + 2, (b.x + b.width) + ' vs ' + (cw - PANEL_WIDTH));

  // --- screenshot the open state for the visual check (Scripts view at 420px) ---
  win.showInactive();
  await new Promise(r => setTimeout(r, 700));
  try {
    const img = await wc.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
    console.log('shot  ' + SHOT);
  } catch (e) { console.log('shot  FAILED: ' + (e && e.message)); }

  console.log(fail === 0
    ? '\nPASS: ' + pass + ' checks (automation panel embedded, slot-shared, revealed)'
    : '\nFAIL: ' + fail + ' of ' + (pass + fail));
  win.close();
  app.exit(fail === 0 ? 0 : 1);
});

setTimeout(() => { console.error('timeout'); app.exit(2); }, 15000);
