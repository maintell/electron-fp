'use strict';
// ponytail: one-shot CDP-evasion probe; no harness reuse (single file per task ceiling).
const { app, BrowserWindow } = require('electron');

function out(kind, name, val) {
  console.log(`${kind} ${name} :: ${val}`);
}

async function cdpEval(dbg, expression) {
  const res = await dbg.sendCommand('Runtime.evaluate', { expression, returnByValue: true });
  // Electron resolves with the CDP result object: { result: { type, value }, exceptionDetails? }
  if (res && res.result && Object.prototype.hasOwnProperty.call(res.result, 'value')) {
    return res.result.value;
  }
  if (res && Object.prototype.hasOwnProperty.call(res, 'value')) return res.value;
  return res && res.result ? res.result : res;
}

function summarizeLog(log) {
  const arr = Array.isArray(log) ? log : [];
  const trusted = arr.length ? arr.every((e) => e && e.isTrusted === true) : false;
  const movement = arr.some((e) => e && (e.movementX !== 0 && e.movementX !== null && e.movementX !== undefined) ||
    (e && (e.movementY !== 0 && e.movementY !== null && e.movementY !== undefined)));
  return { n: arr.length, isTrusted: arr.length ? trusted : false, movement: !!movement, raw: arr };
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const wc = win.webContents;
  const dbg = wc.debugger;
  let failed = false;

  const hardKill = setTimeout(() => {
    try { out('FAIL', 'harness-timeout', 'global 60s exceeded'); } catch (_) {}
    try { for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (_) {} } } catch (_) {}
    try { app.exit(2); } catch (_) { process.exit(2); }
  }, 60000);
  if (hardKill.unref) hardKill.unref();

  try {
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });
    await new Promise((r) => setTimeout(r, 400));

    dbg.attach('1.3');

    // 1. navigator.webdriver via debugger
    let webdriver = null;
    try {
      webdriver = await cdpEval(dbg, 'navigator.webdriver');
      out('PASS', 'webdriver', String(webdriver));
    } catch (e) {
      failed = true;
      out('FAIL', 'webdriver', String((e && e.message) || e));
    }

    // 2. install listeners via debugger
    const installExpr = `(function(){ window.__probeLog = [];` +
      ` function rec(t, e){ window.__probeLog.push({t:t, isTrusted: !!e.isTrusted,` +
      ` movementX: (typeof e.movementX==='number'?e.movementX:null),` +
      ` movementY: (typeof e.movementY==='number'?e.movementY:null),` +
      ` clientX: (typeof e.clientX==='number'?e.clientX:null),` +
      ` clientY: (typeof e.clientY==='number'?e.clientY:null),` +
      ` key: (typeof e.key==='string'?e.key:null)}); }` +
      ` window.__probeRec = rec;` +
      ` window.removeEventListener('mousedown', window.__probeMd || (()=>{}));` +
      ` window.__probeMd = function(e){ rec('mousedown', e); };` +
      ` window.addEventListener('mousedown', window.__probeMd);` +
      ` window.addEventListener('mousemove', function(e){ rec('mousemove', e); });` +
      ` window.addEventListener('keydown', function(e){ rec('keydown', e); });` +
      ` window.addEventListener('mouseup', function(e){ rec('mouseup', e); });` +
      ` return 'ok'; })()`;
    await cdpEval(dbg, installExpr);

    // 2a. CDP Input path
    await cdpEval(dbg, 'window.__probeLog = []');
    let cdpLog = [];
    try {
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 300, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 150));
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 300, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 150));
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await new Promise((r) => setTimeout(r, 80));
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'a', unmodifiedText: 'a' });
      await new Promise((r) => setTimeout(r, 80));
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await new Promise((r) => setTimeout(r, 300));
      cdpLog = await cdpEval(dbg, 'window.__probeLog');
      out('PASS', 'cdp-log', JSON.stringify(cdpLog));
    } catch (e) {
      failed = true;
      out('FAIL', 'cdp-dispatch', String((e && e.message) || e));
    }
    const cdpSum = summarizeLog(cdpLog);

    // 2b. sendInputEvent path
    await cdpEval(dbg, 'window.__probeLog = []');
    let siLog = [];
    try {
      wc.sendInputEvent({ type: 'mouseDown', x: 400, y: 300, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 150));
      wc.sendInputEvent({ type: 'mouseUp', x: 400, y: 300, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 150));
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
      await new Promise((r) => setTimeout(r, 80));
      wc.sendInputEvent({ type: 'char', keyCode: 'a' });
      await new Promise((r) => setTimeout(r, 80));
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'a' });
      await new Promise((r) => setTimeout(r, 300));
      siLog = await cdpEval(dbg, 'window.__probeLog');
      out('PASS', 'sendinput-log', JSON.stringify(siLog));
    } catch (e) {
      failed = true;
      out('FAIL', 'sendinput-dispatch', String((e && e.message) || e));
    }
    const siSum = summarizeLog(siLog);

    // 3. eval artifact stack markers
    let stack = '';
    let evalMarkers = [];
    try {
      stack = await cdpEval(dbg, "(() => { try { null.x; } catch(e){ return e.stack || ''; } })()");
      if (typeof stack !== 'string') stack = String(stack);
      const cands = ['evaluate', 'debugger', 'VM[0-9]', 'injected', 'extensions::'];
      for (const c of cands) {
        try { if (new RegExp(c, 'i').test(stack)) evalMarkers.push(c); } catch (_) {}
      }
      out('PASS', 'eval-stack', JSON.stringify(stack.slice(0, 500)));
      out('PASS', 'eval-markers', JSON.stringify(evalMarkers));
    } catch (e) {
      failed = true;
      out('FAIL', 'eval-stack', String((e && e.message) || e));
    }

    const summary = {
      webdriver,
      cdpInput: { isTrusted: cdpSum.isTrusted, movement: cdpSum.movement },
      sendInput: { isTrusted: siSum.isTrusted, movement: siSum.movement },
      evalMarkers,
    };
    console.log('SUMMARY ' + JSON.stringify(summary));
    try { dbg.detach(); } catch (_) {}
    clearTimeout(hardKill);
    for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (_) {} }
    app.exit(failed ? 1 : 0);
  } catch (e) {
    try { out('FAIL', 'harness-crash', String((e && e.stack) || e)); } catch (_) {}
    try { clearTimeout(hardKill); } catch (_) {}
    try { for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (_) {} } } catch (_) {}
    try { app.exit(1); } catch (_) { process.exit(1); }
  }
}

main();
