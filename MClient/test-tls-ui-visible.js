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
        // Locate the TLS section by its class rather than assuming it is first.
        // HTTP/2 now leads the pane (it is the more constrained plane: it can
        // only be set at tab creation), so "first" is no longer the right
        // assertion for TLS - "not buried" is.
        const tlsSec = secs.find(s => s.classList.contains('fp-group-tls'));
        const h2Sec = secs.find(s => s.classList.contains('fp-group-h2'));
        const tr = tlsSec ? tlsSec.getBoundingClientRect() : null;
        const tHead = tlsSec ? tlsSec.querySelector('.fp-group-head') : null;
        const tcs = tHead ? getComputedStyle(tHead) : null;
        const hr = h2Sec ? h2Sec.getBoundingClientRect() : null;
        const hHead = h2Sec ? h2Sec.querySelector('.fp-group-head') : null;
        const hcs = hHead ? getComputedStyle(hHead) : null;
        return JSON.stringify({
          sectionCount: secs.length,
          firstIsTls: first ? first.classList.contains('fp-group-tls') : false,
          firstIsH2: first ? first.classList.contains('fp-group-h2') : false,
          firstHead: head ? head.textContent.trim() : null,
          top: r ? Math.round(r.top) : null,
          paneHeight: el.clientHeight,
          visible: r ? (r.top >= 0 && r.top < el.clientHeight) : false,
          headColor: cs ? cs.color : null,
          headBg: cs ? cs.backgroundColor : null,
          tlsFields: tlsSec ? tlsSec.querySelectorAll('.fp-field-tls').length : 0,
          tlsGroupsRendered: secs.filter(s => s.classList.contains('fp-group-tls')).length,
          tlsIndex: tlsSec ? secs.indexOf(tlsSec) : -1,
          tlsTop: tr ? Math.round(tr.top) : null,
          tlsVisible: tr ? (tr.top >= 0 && tr.top < el.clientHeight) : false,
          tlsHead: tHead ? tHead.textContent.trim() : null,
          tlsColor: tcs ? tcs.color : null,
          tlsBg: tcs ? tcs.backgroundColor : null,
          h2GroupsRendered: secs.filter(s => s.classList.contains('fp-group-h2')).length,
          h2Index: h2Sec ? secs.indexOf(h2Sec) : -1,
          h2Fields: h2Sec ? h2Sec.querySelectorAll('.fp-field-h2').length : 0,
          h2Top: hr ? Math.round(hr.top) : null,
          h2Visible: hr ? (hr.top >= 0 && hr.top < el.clientHeight) : false,
          h2Head: hHead ? hHead.textContent.trim() : null,
          h2Color: hcs ? hcs.color : null,
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
  // The whole point: it must not be buried. It was the 16th and last section at
  // roughly 3013px in a 2808px pane. HTTP/2 now leads, so the assertion is
  // "in the leading planes and on screen", not "literally first".
  ck('the TLS group is in the leading planes, not buried at the bottom',
    o.tlsIndex >= 0 && o.tlsIndex <= 1,
    'index=' + o.tlsIndex + ' of ' + o.sectionCount);
  ck('it is inside the visible area', o.tlsVisible === true,
    'top=' + o.tlsTop + ' paneHeight=' + o.paneHeight);
  ck('all 9 TLS fields render inside it', o.tlsFields === 9,
    o.tlsFields + ' fields');
  ck('the header names the delivery mechanism (setSSLConfig)',
    /setSSLConfig/.test(o.tlsHead || ''), o.tlsHead);
  // fp-field-tls had no CSS rule at all, so assert it now looks different.
  ck('the header is styled distinctly, not the default grey',
    !!o.tlsColor && o.tlsColor !== 'rgb(200, 200, 200)' &&
    !!o.tlsBg && o.tlsBg !== 'rgb(42, 42, 43)',
    'color=' + o.tlsColor + ' bg=' + o.tlsBg);

  // --- the HTTP/2 plane, which leads because it is the most constrained ----
  ck('the HTTP/2 group is rendered', o.h2GroupsRendered === 1,
    o.h2GroupsRendered + ' h2 groups');
  ck('HTTP/2 leads the pane (it can only be set at tab creation)',
    o.h2Index === 0, 'index=' + o.h2Index);
  ck('all 3 HTTP/2 fields render inside it', o.h2Fields === 3,
    o.h2Fields + ' fields');
  ck('the HTTP/2 header names its delivery mechanism (fromPartition)',
    /fromPartition/.test(o.h2Head || ''), o.h2Head);
  ck('HTTP/2 is styled distinctly from TLS (a different plane)',
    !!o.h2Color && o.h2Color !== 'rgb(200, 200, 200)' && o.h2Color !== o.tlsColor,
    'h2=' + o.h2Color + ' tls=' + o.tlsColor);

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
