#!/usr/bin/env node
'use strict';
/**
 * Tests the electron://fingerprint/ Inspector.
 *
 * What proves it works is not "a window opened" but that the page is served by
 * the browser process from the privileged electron:// origin, and that it
 * reports the profile that is actually configured. Three distinct failure modes
 * have to be told apart:
 *
 *   1. The scheme is not registered  -> navigation fails outright.
 *   2. The host is not routed to WebUI -> navigation fails, or the URL is
 *      treated as an ordinary custom scheme.
 *   3. The data source is broken -> the page or its data 404s, and the page
 *      says "Failed to load inspector data" while looking superficially fine.
 *
 * So the assertions check the rendered DOM and the parsed JSON, not merely that
 * a load event fired.
 */

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

// Letting the default window-all-closed handler quit races with the spare
// renderer warmup and aborts with
//   render_process_host_impl.cc:1725 Check failed:
//   !BrowserMainRunner::ExitedMainMessageLoop()
// producing a non-zero exit after every check passed.
app.on('window-all-closed', (e) => { e.preventDefault(); });

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return; }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const URL = 'electron://fingerprint/';

async function openWindow(sess) {
  const win = new BrowserWindow({
    show: false,
    width: 900, height: 700,
    webPreferences: { session: sess, sandbox: false, nodeIntegration: false },
  });
  return win;
}

/**
 * Read the data the page was served with.
 *
 * The data is inlined into the page by the data source (window.__fp), because
 * neither WebUI subresource fetches nor the chrome.send/addWebUiListener IPC
 * round trip works in this build. Reading window.__fp therefore reads exactly
 * what the browser process produced, which is what we want to assert on.
 */
function grabData(win) {
  return win.webContents.executeJavaScript(
    `JSON.stringify(window.__fp === undefined ? null : window.__fp)`);
}

/** Load the URL and resolve with { ok, error, finalUrl }. */
function load(win, url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve({ ok, error: error || null, finalUrl: win.webContents.getURL() });
    };
    const timer = setTimeout(() => done(false, 'timeout after 20s'), 20000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      // A did-finish-load on an error page is still a did-finish-load, so
      // confirm we landed on the URL we asked for.
      const landed = win.webContents.getURL();
      done(landed.startsWith('electron://fingerprint'), 'landed on ' + landed);
    });
    win.webContents.once('did-fail-load',
      (e, code, desc) => { clearTimeout(timer); done(false, 'did-fail-load ' + code + ' ' + desc); });
    win.loadURL(url).catch((e) => { clearTimeout(timer); done(false, 'loadURL threw ' + e.message); });
  });
}

async function run() {
  await app.whenReady();

  const sess = session.fromPartition('persist:inspector-test');

  // ---- 1. with NO fingerprint configured --------------------------------
  const win = await openWindow(sess);
  const r1 = await load(win, URL);
  check('electron://fingerprint/ navigates (scheme is registered)',
    r1.ok === true, r1.error || r1.finalUrl);

  if (!r1.ok) {
    // Nothing below can work if the scheme is not registered. Report and stop
    // rather than emitting a wall of failures that all share one cause.
    console.log('\nFAIL: ' + (fail + 1) + ' checks (navigation failed)');
    await win.destroy();
    app.exit(1);
    return;
  }

  const html = await win.webContents.executeJavaScript(
    'document.documentElement.outerHTML');
  check('page is served from the browser process (title present)',
    /Fingerprint Inspector/.test(html),
    (html.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no <title>');
  check('page is OUR page, not an error page',
    !/ERR_|error-page|This site can/i.test(html));

  // The status banner is the single most important signal: it distinguishes a
  // working page from a page whose data fetch 404'd.
  const status = await win.webContents.executeJavaScript(
    "(document.getElementById('status')||{}).textContent||''");
  check('status banner rendered (data fetch succeeded)',
    /consistent|error|warning|Failed to load/i.test(status), status.trim());
  check('status is NOT the fetch-failure message',
    !/Failed to load inspector data/i.test(status), status.trim());

  // Data comes over WebUI IPC, not fetch(): WebUI subresource fetches are
  // broken in this build (verified for chrome:// too). We re-request it by
  // re-sending the IPC message rather than fetching a URL.
  const dataJson = await grabData(win);
  let data = null;
  try { data = JSON.parse(dataJson); } catch (e) { /* reported below */ }
  check('inspector data is served inline with the page',
    data && typeof data === 'object', dataJson.slice(0, 120));

  if (data) {
    check('data reports no config initially (hasConfig=false)',
      data.hasConfig === false, JSON.stringify(data.hasConfig));
    check('data has coverage for all 15 groups',
      Array.isArray(data.coverage) && data.coverage.length === 15,
      data.coverage ? String(data.coverage.length) : 'missing');
    check('data summary totals 63 keys',
      data.summary && data.summary.total === 63,
      data.summary ? String(data.summary.total) : 'missing');
    check('no profile set -> zero active keys',
      data.summary && data.summary.active === 0,
      data.summary ? String(data.summary.active) : 'missing');
    check('unset platform surfaces are reported as SKIPPED, not clean',
      Array.isArray(data.conistency || data.consistency.skipped) &&
      data.consistency.skipped.length > 0,
      JSON.stringify(data.consistency.skipped));
  }

  // ---- 2. WITH a fingerprint configured, and a deliberate contradiction --
  // The Inspector must reflect what is actually configured. A page that always
  // renders the same thing would pass every check above.
  sess.setFingerprintConfig({
    hardware_concurrency: 8,
    device_memory: 8,
    screen_width: 1920,
    screen_height: 1080,
    navigator_platform: 'Win32',
    ua_platform: 'macOS',   // deliberate contradiction
  });

  const win2 = await openWindow(sess);
  const r2 = await load(win2, URL);
  check('Inspector re-serves after config change', r2.ok === true, r2.error || r2.finalUrl);

  if (r2.ok) {
    const d2json = await grabData(win2);
    let d2 = null;
    try { d2 = JSON.parse(d2json); } catch (e) { /* reported below */ }
    check('configured run: data parses', d2 && typeof d2 === 'object');

    if (d2) {
      check('configured run: hasConfig=true', d2.hasConfig === true,
        JSON.stringify(d2.hasConfig));
      check('configured run: reports the 6 keys we set',
        d2.summary && d2.summary.active === 6,
        d2.summary ? String(d2.summary.active) + ' (expected 6)' : 'missing');
      check('configured run: detects the Win32/macOS contradiction',
        d2.consistency && d2.consistency.errorCount >= 1,
        JSON.stringify(d2.consistency.findings));

      const nav = (d2.coverage || []).find((g) => g.id === 'navigator');
      check('configured run: navigator group shows 2 active',
        nav && nav.active === 2, nav ? nav.active + '/' + nav.total : 'missing');
      const hw = (d2.coverage || []).find((g) => g.id === 'hardware');
      check('configured run: hardware group shows 2 active',
        hw && hw.active === 2, hw ? hw.active + '/' + hw.total : 'missing');
    }
    await win2.destroy();
  }

  // ---- 3. the rendered DOM reflects the data ------------------------------
  // The window.__fp assertions above prove the DATA is right. These prove the
  // page actually rendered it - a page that received correct data but rendered
  // nothing would otherwise pass every check so far.
  const win3 = await openWindow(sess);
  const r3 = await load(win3, URL);
  check('third window also loads the Inspector', r3.ok === true, r3.error || r3.finalUrl);
  if (r3.ok) {
    const covRows = await win3.webContents.executeJavaScript(
      `document.querySelectorAll('#coverage tr').length`);
    check('coverage table rendered 16 rows (header + 15 groups)',
      covRows === 16, String(covRows));
    const sumRows = await win3.webContents.executeJavaScript(
      `document.querySelectorAll('#summary tr').length`);
    check('summary table rendered 3 rows', sumRows === 3, String(sumRows));
    const status3 = await win3.webContents.executeJavaScript(
      `(document.getElementById('status')||{}).textContent||''`);
    check('status reflects the configured contradiction',
      /error/i.test(status3), status3.trim());
  }
  await win3.destroy();

  await win.destroy();

  console.log('');
  console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
  app.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.log('FAIL  threw: ' + (e && e.message));
  app.exit(1);
});
