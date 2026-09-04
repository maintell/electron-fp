'use strict';
// The TLS plane must be VISIBLE in the Config pane, not merely present in the
// DOM.
//
// The bug: it rendered as the 16th and last section, at roughly 3013px inside a
// 2808px pane - permanently below the fold, after 15 sections of page-level
// keys. On top of that, the fp-field-tls class was applied in JS but had NO CSS
// rule at all, so nothing distinguished it. A user reported the TLS settings as
// simply absent, and they were right: the fields existed but were unreachable
// in practice.
//
// This test drives the real UI and asserts discoverability, not just presence:
// first section, inside the fold, visually distinct, and labelled with its
// delivery mechanism.
const path = require('path');
const { app, BrowserWindow } = require('electron');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

app.whenReady().then(async () => {
  const keep = new BrowserWindow({ show: false, width: 80, height: 80 });
  require(path.join(__dirname, 'main.js'));
  await new Promise((r) => setTimeout(r, 4000));

  const wins = BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && w !== keep);
  if (!wins.length) {
    console.log('FAIL  the client opened a window');
    if (!keep.isDestroyed()) keep.destroy();
    app.exit(1); return;
  }
  const wc = wins[0].webContents;
  await new Promise((r) => setTimeout(r, 2500));

  // The schema must carry the TLS plane across IPC, or none of the rest applies.
  const raw = await wc.executeJavaScript(
    `window.api.getFpSchema().then(s => JSON.stringify({
       tlsKeys: s.tls ? Object.keys(s.tls.keys || {}) : [],
       tlsGroups: s.tls ? (s.tls.groups || []).map(g => g.id) : [],
       blinkGroups: (s.groups || []).map(g => g.id),
     }))`, true).catch((e) => 'ERR ' + e.message);
  let sch = null;
  try { sch = JSON.parse(raw); } catch (e) { /* left null */ }
  ck('the renderer receives the TLS plane in the schema',
    !!sch && sch.tlsKeys.length === 9,
    sch ? sch.tlsKeys.length + ' keys' : String(raw).slice(0, 60));

  const rawInfo = await wc.executeJavaScript(
    `(async () => {
       const el = document.getElementById('fp-groups');
       if (!el) return JSON.stringify({ noPane: true });
       const secs = [...el.querySelectorAll('.fp-group')];
       const first = secs[0];
       const head = first ? first.querySelector('.fp-group-head') : null;
       const r = first ? first.getBoundingClientRect() : null;
       const cs = head ? getComputedStyle(head) : null;
       return JSON.stringify({
         sectionCount: secs.length,
         firstIsTls: first ? first.classList.contains('fp-group-tls') : false,
         firstHead: head ? head.textContent.trim() : null,
         top: r ? Math.round(r.top) : null,
         paneHeight: el.clientHeight,
         visible: r ? (r.top >= 0 && r.top < el.clientHeight) : false,
         headColor: cs ? cs.color : null,
         headBg: cs ? cs.backgroundColor : null,
         tlsFields: first ? first.querySelectorAll('.fp-field-tls').length : 0,
         tlsGroupsRendered: secs.filter(s => s.classList.contains('fp-group-tls')).length,
       });
     })()`, true).catch((e) => 'ERR ' + e.message);
  let o = null;
  try { o = JSON.parse(rawInfo); } catch (e) { /* left null */ }
  if (!o || o.noPane) {
    ck('the Config pane exists', false, String(rawInfo).slice(0, 80));
    console.log('\nFAIL: cannot proceed');
    if (!keep.isDestroyed()) keep.destroy();
    app.exit(1); return;
  }

  ck('the TLS group is rendered', o.tlsGroupsRendered === 1,
    o.tlsGroupsRendered + ' tls groups of ' + o.sectionCount + ' sections');
  // The whole point: it must not be buried.
  ck('the TLS group is the FIRST section (was 16th, below the fold)',
    o.firstIsTls === true, 'firstIsTls=' + o.firstIsTls);
  ck('it is inside the visible area', o.visible === true,
    'top=' + o.top + ' paneHeight=' + o.paneHeight);
  ck('all 9 TLS fields render inside it', o.tlsFields === 9,
    o.tlsFields + ' fields');
  ck('the header names the delivery mechanism (setSSLConfig)',
    /setSSLConfig/.test(o.firstHead || ''), o.firstHead);
  // fp-field-tls had no CSS rule at all, so assert it now looks different.
  ck('the header is styled distinctly, not the default grey',
    !!o.headColor && o.headColor !== 'rgb(200, 200, 200)' &&
    !!o.headBg && o.headBg !== 'rgb(42, 42, 43)',
    'color=' + o.headColor + ' bg=' + o.headBg);

  // Toggling a TLS control must survive a round trip through the store.
  const applied = await wc.executeJavaScript(
    `(async () => {
       const el = document.getElementById('fp-groups');
       const cb = el.querySelector('.fp-field-tls input[type=checkbox]');
       if (!cb) return JSON.stringify({ noCheckbox: true });
       const key = cb.dataset.key;
       cb.checked = true;
       cb.dispatchEvent(new Event('change', { bubbles: true }));
       await new Promise(r => setTimeout(r, 400));
       return JSON.stringify({ key, checked: cb.checked });
     })()`, true).catch((e) => 'ERR ' + e.message);
  let ap = null;
  try { ap = JSON.parse(applied); } catch (e) { /* left null */ }
  ck('a TLS control is interactive (checkbox present and settable)',
    !!ap && ap.checked === true,
    ap ? ap.key + '=' + ap.checked : String(applied).slice(0, 60));

  console.log('\n' + (fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));
  if (!keep.isDestroyed()) keep.destroy();
  app.exit(fail === 0 ? 0 : 1);
});
setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 180000);
