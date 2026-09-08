'use strict';
// The self-test probe must complete on a HIDDEN tab.
//
// The bug: perf_now_precision_ms is sampled in a loop that yielded with
// setTimeout(8). A BrowserView that is not the visible tab has
// document.visibilityState "hidden", and Chromium throttles timers there to
// roughly one tick per second - three nested 8ms timeouts measured 2999ms, so
// 24 of them needed ~24s and blew the self-test's 15s timeout. The user saw
// "probe timeout after 15s" for EVERY key, which reads as a broken fingerprint
// rather than a throttled timer. The self-test was therefore unusable on any
// tab except the visible one - and Self-test is precisely a thing you run on a
// tab you are looking at the panel of, not necessarily the front tab.
//
// The fix yields with a MessageChannel round-trip plus a 2ms busy-wait, which
// is immune to throttling. This file asserts the probe uses no timer for that
// loop, and that it actually completes while hidden.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { PROBE } = require('./fp-probe');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

// --- static: the sampling loop must not use a throttlable timer ----------
const probeSrc = fs.readFileSync(path.join(__dirname, 'fp-probe.js'), 'utf8');
// Anchor on the loop itself. "perf_now_precision_ms" also appears in the
// comment above the loop, so matching on that name alone grabs the comment and
// checks the wrong text.
const loopIdx = probeSrc.indexOf('for(let i=0;i<24;i++)');
ck('the perf-now sampling loop exists', loopIdx >= 0,
  loopIdx >= 0 ? 'found at offset ' + loopIdx : 'not found');
if (loopIdx >= 0) {
  // The loop is one statement; take it plus the two helpers declared just
  // above it (yieldToEventLoop / spinWait).
  const start = Math.max(0, loopIdx - 400);
  const b = probeSrc.slice(start, loopIdx + 300);
  const loopOnly = probeSrc.slice(loopIdx, loopIdx + 300);
  ck('the sampling loop does not use setTimeout', !/setTimeout/.test(loopOnly));
  ck('the sampling loop yields via MessageChannel',
    /MessageChannel/.test(b) && /yieldToEventLoop\(\)/.test(loopOnly));
  ck('the sampling loop busy-waits so the clock advances',
    /spinWait/.test(b) && /spinWait\(2\)/.test(loopOnly));
}

// The only setTimeout left inside PROBE should be the bounded ICE wait.
// Count in the PROBE template only: fp-probe.js itself has none outside it,
// but being explicit keeps this honest if that changes.
//
// Count EXECUTABLE setTimeout calls, not mentions. The comment explaining why
// setTimeout must not be used here naturally contains the word, and counting
// it would make this check report a violation for its own documentation.
const codeLines = PROBE.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l.trim()));
const timeouts = codeLines.filter((l) => /setTimeout\s*\(/.test(l));
ck('PROBE has exactly one executable setTimeout (the bounded ICE wait)',
  timeouts.length === 1,
  timeouts.length + ' found: ' + timeouts.map((l) => l.trim().slice(0, 40)).join(' | '));
// And it must be bounded, or a hidden tab could hang on it too.
ck('that setTimeout is bounded by a timeout value',
  timeouts.length === 1 && /setTimeout\(\s*\w+\s*,\s*\d+\s*\)/.test(timeouts[0]),
  timeouts.length ? timeouts[0].trim().slice(0, 60) : '-');

app.whenReady().then(async () => {
  const { net: enet } = require('electron');
  // Build a genuinely hidden page: a BrowserView attached to a window that is
  // never shown, which is the exact state a background tab is in.
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  const view = new (require('electron').BrowserView)({
    webPreferences: { partition: 'probe-hidden-' + Date.now() },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 400, height: 300 });

  const http = require('http');
  const srv = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end('<!doctype html><html><body>hidden</body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/';
  await view.webContents.loadURL(url);
  await new Promise((r) => setTimeout(r, 400));

  const vis = await view.webContents.executeJavaScript(
    'JSON.stringify({v:document.visibilityState})', true)
    .catch((e) => 'THREW ' + e.message);
  let visObj = null;
  try { visObj = JSON.parse(vis); } catch (e) { /* left null */ }
  ck('the test page really is hidden (otherwise this proves nothing)',
    !!visObj && visObj.v === 'hidden', vis);

  const t0 = Date.now();
  let res = null, err = null;
  try {
    res = await Promise.race([
      view.webContents.executeJavaScript(PROBE, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('15s timeout')), 15000)),
    ]);
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0;

  ck('the probe completes on a hidden page', !!res, err || (ms + 'ms'));
  ck('the probe completes well inside the 15s budget',
    !!res && ms < 10000, ms + 'ms');
  if (res) {
    ck('the probe still reads all 58 surfaces while hidden',
      Object.keys(res).filter((k) => !k.startsWith('_')).length >= 57,
      Object.keys(res).length + ' keys');
    ck('perf_now_precision_ms is still measured (not silently dropped)',
      res.perf_now_precision_ms !== undefined && res.perf_now_precision_ms > 0,
      String(res.perf_now_precision_ms));
  }

  srv.close();
  if (!win.isDestroyed()) win.destroy();
  console.log('\n' + (fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));
  app.exit(fail === 0 ? 0 : 1);
});
setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 120000);
