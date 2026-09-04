'use strict';
// Creating a tab FROM A PROFILE must apply that profile's TLS plane.
//
// The bug this locks down: createTabView() passed the raw profile object
// straight to BrowserView's `fingerprint` webPreference and never called
// setSSLConfig(). The Blink keys landed, but the 9 TLS keys went into
// --fingerprint-config where the kernel ignores unknown keys - so a tab created
// from the "macOS / Safari-like" preset spoke Chromium's native GREASEd
// ClientHello. Measured: grease=3, identical to no profile at all.
//
// It was invisible to every existing test because they all applied a config
// through the PANEL path (recreateTabView), which routes correctly. Only
// actually opening a tab from a preset, and measuring that tab's own session,
// exposed it. So this test does exactly that, through window.api - the same
// surface the renderer uses.
const { app, session, BrowserWindow } = require('electron');
const path = require('path');
const { captureClientHello } = require('./tls-probe');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

// What each preset claims, grounded in measurements on this kernel:
//   * Chromium GREASEs (RFC 8701); WebKit and NSS do not.
//   * fpAdvertisedVersionMax=771 is the only way to drop the TLS 1.3 suites.
const EXPECT = {
  'win10-chrome':   (h) => h.greaseCipherCount + h.greaseExtCount > 0,
  'mobile-android': (h) => h.greaseCipherCount + h.greaseExtCount > 0,
  'macos-safari':   (h) => h.greaseCipherCount + h.greaseExtCount === 0,
  'linux-firefox':  (h) => h.greaseCipherCount + h.greaseExtCount === 0 &&
    !h.ciphers.includes('1301'),
};

app.whenReady().then(async () => {
  const keep = new BrowserWindow({ show: false, width: 80, height: 80 });
  require(path.join(__dirname, 'main.js'));
  await new Promise((r) => setTimeout(r, 4000));

  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== keep);
  ck('the client opened a window', wins.length > 0,
    wins.length ? wins[0].getTitle() : 'none');
  if (!wins.length) {
    console.log('\nFAIL: no window to drive');
    if (!keep.isDestroyed()) keep.destroy();
    app.exit(1); return;
  }
  const wc = wins[0].webContents;
  await new Promise((r) => setTimeout(r, 2500));

  // listProfiles() returns a bare ARRAY, not {profiles:[...]}.
  const raw = await wc.executeJavaScript(
    `window.api.listProfiles().then(p => JSON.stringify(p))`, true).catch((e) => 'ERR ' + e.message);
  let list = null;
  try { list = JSON.parse(raw); } catch (e) { /* left null */ }
  ck('listProfiles() resolves through the UI', Array.isArray(list),
    Array.isArray(list) ? list.length + ' profiles' : String(raw).slice(0, 70));
  if (!Array.isArray(list)) {
    console.log('\nFAIL: cannot proceed');
    if (!keep.isDestroyed()) keep.destroy();
    app.exit(1); return;
  }

  const named = list.filter((p) => p.id !== 'default' && p.fingerprint);
  ck('named presets exist with fingerprints', named.length >= 3, named.length + ' found');

  for (const pr of named) {
    // createTab returns the tab id as a bare STRING.
    const created = await wc.executeJavaScript(
      `window.api.createTab(${JSON.stringify(pr.id)}).then(t => JSON.stringify(t))`, true)
      .catch((e) => 'ERR ' + e.message);
    let tabId = null;
    try { tabId = JSON.parse(created); } catch (e) { /* left null */ }
    if (typeof tabId !== 'string' || !tabId) {
      ck('preset ' + pr.id + ' opens a tab', false, String(created).slice(0, 70));
      continue;
    }
    // Measure THAT tab's own partition - main.js uses `fp-tab-${tabId}`.
    const sess = session.fromPartition('fp-tab-' + tabId);
    const cap = await captureClientHello(sess, 4000);
    if (!cap.ok) { ck('preset ' + pr.id + ' captured', false, cap.error); continue; }
    const h = cap.hello;
    const want = EXPECT[pr.id];
    ck('tab created from "' + pr.id + '" emits its claimed TLS shape',
      want ? want(h) : false,
      'grease=' + (h.greaseCipherCount + h.greaseExtCount) +
      ' ext=' + h.extCount +
      ' tls13=' + (h.ciphers.includes('1301') ? 'yes' : 'no'));
  }

  // The default profile must stay native: it is the baseline every comparison
  // is made against, and it is how a user gets an unspoofed tab.
  const def = await wc.executeJavaScript(
    `window.api.createTab("default").then(t => JSON.stringify(t))`, true)
    .catch((e) => 'ERR');
  let defId = null;
  try { defId = JSON.parse(def); } catch (e) { /* left null */ }
  if (typeof defId === 'string' && defId) {
    const cap = await captureClientHello(session.fromPartition('fp-tab-' + defId), 4000);
    ck('a "default" tab stays native passthrough',
      cap.ok && cap.hello.ciphers.includes('1301') &&
      cap.hello.greaseCipherCount + cap.hello.greaseExtCount > 0,
      cap.ok ? 'grease=' + (cap.hello.greaseCipherCount + cap.hello.greaseExtCount) : cap.error);
  } else {
    ck('a "default" tab can be created', false, String(def).slice(0, 60));
  }

  console.log('\n' + (fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));

  if (!keep.isDestroyed()) keep.destroy();
  app.exit(fail === 0 ? 0 : 1);
});
setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 240000);
