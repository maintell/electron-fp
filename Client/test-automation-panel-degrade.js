#!/usr/bin/env node
// Graceful degradation: the EMBEDDED panel in a preload-only host (facade
// present, IPC handlers absent) falls back to its absent-bridge state instead
// of rendering raw call errors.
//
// Mirrors the packaged copy: Client/main.js's attachAutomation(...) one-liner
// throws there (no ../automation), so preload's facade exists but every invoke
// rejects with "No handler registered for 'automation:...'". Here the REAL
// preload is attached and the automation bridge is deliberately NOT wired.
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 500));

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

  // 0. precondition: facade exists (real preload), no handler behind it
  ck('window.automationApi present (real preload)', await js('!!window.automationApi'));
  const rejMsg = await js(
    "window.automationApi.getScripts().then(() => 'RESOLVED', (e) => String((e && e.message) || e))");
  ck('getScripts rejects with no-handler error', /No handler registered/i.test(rejMsg), rejMsg);

  // 1. degraded: the absent-bridge banner + empty state appear without a click
  ck('#ap-bridge visible', await waitFor("!document.getElementById('ap-bridge').hidden", 4000));
  ck('#ap-empty visible', await waitFor("!document.getElementById('ap-empty').hidden", 4000));

  // 2. controls reflect the lost bridge (SHELL id: #ap-run), not a live one
  ck('Run disabled', await js("document.getElementById('ap-run').disabled === true"));

  console.log(fail === 0
    ? '\nPASS: ' + pass + ' checks (panel degrades on a preload-only host)'
    : '\nFAIL: ' + fail + ' of ' + (pass + fail));
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.log('FAIL  threw: ' + ((e && e.stack) || e)); app.exit(1); });

setTimeout(() => { console.error('timeout'); app.exit(2); }, 15000);
