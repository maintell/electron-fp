#!/usr/bin/env node
// End-to-end: the EMBEDDED automation panel actually talks to the REAL bridge.
//
// Boots the app renderer entry (renderer/index.html) with the REAL preload and
// the REAL IPC bridge (automation/electron/wire.js) over a seeded service, then
// drives the panel through its nav button and asserts the data round-trips:
// the seeded script renders from the real scripts channel, the templates
// fragment renders from its channel, and the geometry IPC (panel:set-open)
// fires through the real preload.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildLocalStack, attachAutomation } = require('../automation/electron/wire');

const SEED = 'bridge-e2e-script';
const SHOT = process.env.AP_SHOT2 || 'F:/Temp/opencode/ap-bridge.png';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
};

app.whenReady().then(async () => {
  // --- real service + real bridge on this process's ipcMain ---
  const { store, service } = buildLocalStack({ audit: () => {} });
  store.create({ name: SEED, code: 'return 1;', permissions: {}, parameters: [] });
  const { registered } = attachAutomation({
    ipcMain, service, audit: () => {}, allowedSenders: [{ urlPrefix: 'file://' }],
  });
  ck('bridge registered channels', Array.isArray(registered) && registered.length > 0,
    (registered || []).length + ' channels');

  // The Client's own geometry channel (main.js panel:set-open), captured here.
  const panelCalls = [];
  ipcMain.handle('panel:set-open', (e, isOpen) => { panelCalls.push(!!isOpen); return true; });

  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 700));

  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await js(expr)) return true; } catch (_) { }
      if (Date.now() - t0 > ms) return false;
      await new Promise(r => setTimeout(r, 150));
    }
  };

  // 1. real preload exposes the facade the panel reads
  ck('window.api.automationApi present (real preload)', await js("!!(window.api && window.api.automationApi)"));
  ck('facade has getScripts + templates.list', await js(
    "!!(window.api.automationApi.getScripts && window.api.automationApi.templates && window.api.automationApi.templates.list)"));

  // 2. open the column: app.js -> real preload -> panel:set-open (geometry)
  await js("document.getElementById('btn-automation').click()");
  await new Promise(r => setTimeout(r, 300));
  ck('panel:set-open captured true (geometry IPC via real preload)', panelCalls.includes(true), JSON.stringify(panelCalls));

  // 3. data plane: the panel's script list comes from the REAL service
  ck('seeded script rendered via real bridge (scripts channel)',
    await waitFor(`document.getElementById('automation-panel').textContent.includes(${JSON.stringify(SEED)})`, 5000));
  // 4. second channel path: templates fragment
  ck('templates fragment populated (templates channel)',
    await waitFor("document.getElementById('ap-templates') && document.getElementById('ap-templates').childElementCount > 0", 5000));

  // Visual record (not a pass/fail check): scroll the column body down to the
  // templates region and capture it.
  try {
    await js("document.getElementById('ap-panel-body').scrollTop = 99999");
    await new Promise(r => setTimeout(r, 400));
    win.showInactive();
    await new Promise(r => setTimeout(r, 500));
    const img = await wc.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
    console.log('shot  ' + SHOT);
  } catch (e) { console.log('shot  skipped: ' + (e && e.message)); }

  console.log(fail === 0
    ? '\nPASS: ' + pass + ' checks (embedded panel <-> real bridge round-trip)'
    : '\nFAIL: ' + fail + ' of ' + (pass + fail));
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.log('FAIL  threw: ' + ((e && e.stack) || e)); app.exit(1); });

setTimeout(() => { console.error('timeout'); app.exit(2); }, 25000);
