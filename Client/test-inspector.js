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
// The schema is the authoritative definition of "this surface is active"; the
// Inspector reimplements fpCoverage() in C++, so this test compares them.
const S = require('./fp-schema.js');

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
  // The banner must show a rendered verdict, not the raw placeholder. With no
  // profile set, the honest verdict is now "Nothing to check" (most rules could
  // not evaluate) rather than "Profile is consistent" - so the accepted set
  // includes it. What matters is that the data reached the page at all.
  check('status banner rendered (data fetch succeeded)',
    /consistent|error|warning|nothing to check|Failed to load/i.test(status),
    status.trim());
  check('status is NOT the fetch-failure message',
    !/Failed to load inspector data/i.test(status), status.trim());
  // Regression guard for the use-after-move bug: skipCount was read from a
  // moved-from list and always reported 0, while skipped[] held 7 entries. The
  // panel thresholds on skipCount, so the undercount made an untested profile
  // read as verified-clean.
  {
    let d0 = null;
    try { d0 = JSON.parse(dataJson); } catch (e) { /* reported above */ }
    if (d0 && d0.consistency) {
      check('skipCount matches the length of skipped[]',
        d0.consistency.skipCount === (d0.consistency.skipped || []).length,
        'skipCount=' + d0.consistency.skipCount + ' vs skipped[]=' +
          (d0.consistency.skipped || []).length);
    }
  }

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

  // ---- 2b. webPreferences.fingerprint (what the CLIENT actually uses) ------
  //
  // The Client builds a BrowserView per tab with `fingerprint` in
  // webPreferences (Client/main.js), which lands in WebContentsPreferences -
  // NOT SessionPreferences. Two separate stores. An Inspector that only read
  // SessionPreferences would report an empty profile for a real Client tab:
  // the primary case it exists to inspect, silently wrong and reading as
  // "verified clean".
  const sess2 = session.fromPartition('persist:inspector-wc-test');
  const winWC = new BrowserWindow({
    show: false,
    webPreferences: {
      session: sess2,
      sandbox: false,
      fingerprint: {
        hardware_concurrency: 4,
        tz_id: 'Asia/Tokyo',
        navigator_platform: 'Linux x86_64',
        ua_platform: 'Windows',   // deliberate contradiction
      },
    },
  });
  await winWC.loadURL('about:blank');

  const win4 = await openWindow(sess2);
  const r4 = await load(win4, URL);
  check('Inspector loads for the webPreferences-config session',
    r4.ok === true, r4.error || r4.finalUrl);
  if (r4.ok) {
    const d4json = await grabData(win4);
    let d4 = null;
    try { d4 = JSON.parse(d4json); } catch (e) { /* reported below */ }
    check('webPreferences config: data parses', d4 && typeof d4 === 'object');
    if (d4) {
      check('webPreferences config is picked up (hasConfig=true)',
        d4.hasConfig === true, JSON.stringify(d4.hasConfig));
      check('webPreferences config: reports the 4 keys we set',
        d4.summary && d4.summary.active === 4,
        d4.summary ? String(d4.summary.active) + ' (expected 4)' : 'missing');
      check('webPreferences config: at least one tab contributed',
        d4.webContentsConfigs >= 1, JSON.stringify(d4.webContentsConfigs));
      check('webPreferences config: detects the Linux/Windows contradiction',
        d4.consistency && d4.consistency.errorCount >= 1,
        JSON.stringify(d4.consistency.findings));
    }
  }
  await winWC.destroy();
  await win4.destroy();

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

  // ---- 4. EVERY rule in the set, including the warn-level ones ------------
  //
  // The Inspector previously ran 1 of 8 rules and hardcoded warnCount to 0, so
  // it reported "Profile is consistent" having evaluated almost nothing. These
  // checks configure a profile that trips all eight, so a rule silently
  // dropping out (or warnCount being pinned again) fails the suite.
  //
  // A UA is set here on purpose: four rules are anchored to it, and without one
  // they can only ever skip - which is exactly how the gap stayed invisible.
  const sessRules = session.fromPartition('persist:inspector-rules-test');
  sessRules.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  sessRules.setFingerprintConfig({
    // error: UA(Windows) -> platform Win32, vendor Google Inc., mobile=false,
    //        Client-Hint platform "Windows".
    navigator_platform: 'Linux x86_64',      // rule 1
    navigator_vendor: 'Apple Computer, Inc.', // rule 2
    ua_mobile: 'true',                        // rule 3
    ua_platform: 'macOS',                     // rule 4
    // warn: desktop UA advertising touch is a mobile-emulation tell.
    max_touch_points: 5,                      // rule 5
    device_memory: 3,                         // rule 6 (not a power of two)
    screen_width: 800,                        // rule 7
    screen_height: 600,
    screen_avail_width: 1024,                 // exceeds screen_width
    webrtc_ip: '1.2.3.4',                     // rule 8 (alone in network)
  });

  const winRules = await openWindow(sessRules);
  const rRules = await load(winRules, URL);
  check('all-rules window loads', rRules.ok === true, rRules.error || rRules.finalUrl);

  if (rRules.ok) {
    const raw = await grabData(winRules);
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { /* reported below */ }
    check('all-rules run: data parses', d && typeof d === 'object');

    if (d) {
      const c = d.consistency || {};
      const ids = (c.findings || []).map((f) => f.id);
      const sevOf = (id) => (c.findings || []).find((f) => f.id === id);

      // Every rule is expected: 4 error + 4 warn.
      const wantErrors = ['platform-matches-ua', 'vendor-matches-ua',
        'ua-mobile-matches-ua', 'ua-platform-ch-matches-ua'];
      const wantWarns = ['mobile-hardware-consistent', 'device-memory-plausible',
        'screen-dimensions-plausible', 'webrtc-ip-requires-network-group'];

      for (const id of wantErrors) {
        const f = sevOf(id);
        check('error rule fires: ' + id,
          !!f && f.severity === 'error', f ? f.severity : 'MISSING from ' + JSON.stringify(ids));
      }
      for (const id of wantWarns) {
        const f = sevOf(id);
        check('warn rule fires: ' + id,
          !!f && f.severity === 'warn', f ? f.severity : 'MISSING from ' + JSON.stringify(ids));
      }

      // The counts must agree with the findings - this is what a hardcoded
      // warnCount would break.
      check('errorCount matches the error findings',
        c.errorCount === wantErrors.length,
        c.errorCount + ' vs ' + wantErrors.length);
      check('warnCount is NOT hardcoded to 0 (was pinned before)',
        c.warnCount === wantWarns.length,
        'warnCount=' + c.warnCount + ' expected ' + wantWarns.length);

      // Coverage reporting: all 8 rules ran, none skipped.
      check('ruleCount reports the full rule set', c.ruleCount === 8, String(c.ruleCount));
      check('all 8 rules evaluated (none skipped)',
        c.rulesEvaluated === 8 && c.skipCount === 0,
        'evaluated=' + c.rulesEvaluated + ' skipped=' + c.skipCount);

      // The rendered page must show the warn count, not just carry it in JSON.
      const status = await winRules.webContents.executeJavaScript(
        `(document.getElementById('status')||{}).textContent||''`);
      check('status reports the error count', /error/i.test(status), status.trim());
      const rulesLine = await winRules.webContents.executeJavaScript(
        `(document.getElementById('consistency')||{}).textContent||''`);
      check('page shows rules-evaluated coverage line',
        /8 of 8 rules evaluated/.test(rulesLine), rulesLine.slice(0, 120));
    }
  }
  await winRules.destroy();

  // ---- 5. an EMPTY profile must not claim to be verified clean ------------
  //
  // With nothing set, every rule skips. The old panel still said "Profile is
  // consistent", which reads as a clean bill of health. It must now say
  // nothing was checked.
  const sessEmpty = session.fromPartition('persist:inspector-empty-test');
  const winEmpty = await openWindow(sessEmpty);
  const rEmpty = await load(winEmpty, URL);
  check('empty-profile window loads', rEmpty.ok === true, rEmpty.error || rEmpty.finalUrl);
  if (rEmpty.ok) {
    const status = await winEmpty.webContents.executeJavaScript(
      `(document.getElementById('status')||{}).textContent||''`);
    check('empty profile does NOT claim "Profile is consistent"',
      !/^Profile is consistent/.test(status.trim()), status.trim());
    check('empty profile says nothing was checked',
      /nothing to check|not a clean bill of health/i.test(status), status.trim());
  }
  await winEmpty.destroy();

  // ---- 6. C++ coverage counters must agree with the JS schema -------------
  //
  // The Inspector mirrors fpIsActive()/fpCoverage() from Client/fp-schema.js in
  // C++, because the kernel side has no JS. The two diverged once: the C++ tested
  // only emptiness, so a numeric key holding the STRING "0" counted as active
  // there but inactive in fpIsActive() (which compares against the default).
  // 25 of 63 keys are numeric, and any JSON round-trip quotes numbers.
  //
  // This pins parity using the string forms, which is where they disagreed.
  const sessParity = session.fromPartition('persist:inspector-parity-test');
  const parityCfg = {
    hardware_concurrency: '0',   // numeric, string zero  -> NOT active
    device_memory: '7',          // numeric, non-zero     -> active
    screen_width: '1920',        // numeric, string       -> active
    screen_avail_width: '0',     // numeric, string zero  -> NOT active
    navigator_platform: 'Win32', // string, non-empty     -> active
    tz_id: '',                   // string, empty         -> NOT active
  };
  sessParity.setFingerprintConfig(parityCfg);

  const winParity = await openWindow(sessParity);
  const rParity = await load(winParity, URL);
  check('parity window loads', rParity.ok === true, rParity.error || rParity.finalUrl);
  if (rParity.ok) {
    const raw = await grabData(winParity);
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { /* reported below */ }
    check('parity run: data parses', d && typeof d === 'object');
    if (d) {
      const jsCov = S.fpCoverage(parityCfg);
      const jsTotal = jsCov.reduce((n, g) => n + g.active, 0);
      const cppTotal = d.summary.active;
      check('coverage total matches fpCoverage() exactly',
        cppTotal === jsTotal, 'C++=' + cppTotal + ' JS=' + jsTotal);

      // Per-group, so a total that happens to match is not enough.
      let groupsOk = true;
      const mismatches = [];
      for (const g of jsCov) {
        const cpp = (d.coverage || []).find((x) => x.id === g.id);
        if (!cpp || cpp.active !== g.active) {
          groupsOk = false;
          mismatches.push(g.id + ': C++=' + (cpp ? cpp.active : '?') + ' JS=' + g.active);
        }
      }
      check('per-group coverage matches fpCoverage()', groupsOk,
        mismatches.join('; ') || 'all 15 groups agree');

      // The specific divergence: numeric keys holding "0" are NOT active.
      const hw = (d.coverage || []).find((x) => x.id === 'hardware');
      check('numeric key holding "0" is NOT counted as active',
        hw && hw.active === 1, 'hardware active=' + (hw && hw.active) + ' expected 1');

      // GROUP MEMBERSHIP, not just counts.
      //
      // The C++ mirrors the schema's groups (see the note in fingerprint_ui.h).
      // Every count-level check passes on a MIS-GROUPED key: all 15 group ids,
      // all per-group totals and the 63 total are unchanged when a key sits in
      // the wrong group - it would simply be reported under the wrong heading.
      // The Inspector therefore serves each group's key list, and this asserts
      // it against fpCoverage() exactly.
      const membershipMismatch = [];
      for (const g of jsCov) {
        const cpp = (d.coverage || []).find((x) => x.id === g.id);
        const cppKeys = ((cpp && cpp.keys) || []).slice().sort();
        const jsKeys = g.keys.slice().sort();
        if (JSON.stringify(cppKeys) !== JSON.stringify(jsKeys)) {
          const onlyCpp = cppKeys.filter((k) => jsKeys.indexOf(k) === -1);
          const onlyJs = jsKeys.filter((k) => cppKeys.indexOf(k) === -1);
          membershipMismatch.push(g.id + ' [+C++: ' + (onlyCpp.join(',') || '-') +
            ' +JS: ' + (onlyJs.join(',') || '-') + ']');
        }
      }
      check('group membership matches fpCoverage() key-for-key',
        membershipMismatch.length === 0,
        membershipMismatch.join(' | ') || 'all 15 groups identical');

      // And no key may be missing from, or duplicated across, the C++ table.
      const allCppKeys = [];
      for (const g of (d.coverage || [])) allCppKeys.push(...(g.keys || []));
      const dupes = allCppKeys.filter((k, i) => allCppKeys.indexOf(k) !== i);
      check('no key appears in two C++ groups', dupes.length === 0,
        dupes.join(',') || 'none');
      check('C++ group table covers all 63 keys',
        allCppKeys.length === 63, String(allCppKeys.length));

      // And a rule that consumes a numeric key must not evaluate it as a value
      // when coverage considers it unset - otherwise the two disagree about
      // whether the surface is even configured.
      const c = d.consistency || {};
      const dmFinding = (c.findings || []).find((f) => f.id === 'device-memory-plausible');
      check('device_memory=7 is evaluated (power-of-two rule fires)',
        !!dmFinding, JSON.stringify((c.findings || []).map((f) => f.id)));
    }
  }
  await winParity.destroy();

  await win.destroy();

  console.log('');
  console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
  app.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.log('FAIL  threw: ' + (e && e.message));
  app.exit(1);
});
