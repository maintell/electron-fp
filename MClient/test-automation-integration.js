'use strict';
// MClient automation integration test. Boots MClient (its main.js wires the
// automation bridge via wireAutomation()) and asserts the bridge is reachable
// from the renderer through the real preload facade — automation:status and
// automation:scripts:* channels. PASS/FAIL lines; exit 0 == MClient runs with a
// live automation bridge.
const { app, BrowserWindow } = require('electron');

// Boot MClient: registers its IPC, creates the main window, wires automation.
require('./main.js');

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

function finish() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch (_) {}
    }
  } catch (_) {}
  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  app.exit(fail === 0 ? 0 : 1);
}

app.whenReady().then(async () => {
  const waitForWin = async (ms) => {
    const t0 = Date.now();
    for (;;) {
      const w = BrowserWindow.getAllWindows()[0];
      if (w && !w.isDestroyed() && !w.webContents.isLoading()) return w;
      if (Date.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const win = await waitForWin(20000);
  ck('MClient main window created', !!win);
  if (!win) {
    finish();
    return;
  }

  await new Promise((r) => setTimeout(r, 1000)); // preload + renderer settle
  const js = (code) => win.webContents.executeJavaScript(code, true);

  ck('preload exposes window.automationApi', await js('!!(window.automationApi)'));
  ck('facade has status + getScripts', await js('!!(window.automationApi && window.automationApi.status && window.automationApi.getScripts)'));

  const st = await js("window.automationApi.status().then(r => JSON.stringify(r)).catch(e => 'ERR:' + (e && e.message))");
  ck('automation:status channel reachable', /"service"\s*:\s*"automation"/.test(String(st)), String(st).slice(0, 120));

  const list = await js("window.automationApi.getScripts().then(r => Array.isArray(r) ? ('array len=' + r.length) : JSON.stringify(r)).catch(e => 'ERR:' + (e && e.message))");
  ck('automation:scripts:list channel reachable', /array len=/.test(String(list)), String(list).slice(0, 120));

  const created = await js("window.automationApi.saveScript({ name: 'mclient-int', code: 'return 7;' }).then(r => JSON.stringify({ id: r && r.id })).catch(e => 'ERR:' + (e && e.message))");
  ck('automation:scripts:create reachable (write path)', /"id"\s*:\s*"/.test(String(created)), String(created).slice(0, 120));

  finish();
}).catch((e) => {
  fail++;
  console.log('FAIL  threw :: ' + ((e && e.stack) || e));
  finish();
});
