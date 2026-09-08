'use strict';
// Drive the REAL Client GUI the way a human would: open the panel, apply a TLS
// config, click Self-test, and read the rendered verdicts back.
//
// This is the check the original question asked for. Every other TLS test
// exercises the schema, the splitter, the verdict table or a bare session -
// all of which can pass while the panel shows nothing. This one clicks the
// buttons a user clicks and reads what a user sees.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = 'F:/Temp/opencode/gui_tls.txt';
fs.writeFileSync(OUT, '');
// Write to stdout as well: run-tests.js reads stdout, and a test that reports
// only to a file looks like a test that produced nothing.
const log = (s) => { fs.appendFileSync(OUT, s + '\n'); console.log(s); };

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

const CLIENT = 'F:/code/electron-fp/Client';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try { require(path.join(CLIENT, 'main.js')); }
  catch (e) { log('FAIL  could not load main.js: ' + e.message); app.exit(1); return; }
  await sleep(3500);

  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  ck('the client opened a window', !!win, win ? win.getTitle() : 'none');
  if (!win) { app.exit(1); return; }
  const wc = win.webContents;
  await sleep(1500);

  // --- 1. Does the schema the renderer sees include the TLS plane? --------
  const schemaSeen = await wc.executeJavaScript(`(() => JSON.stringify({
    isNull: (typeof fpSchema === 'undefined' || fpSchema === null),
    groups: (typeof fpSchema !== 'undefined' && fpSchema && fpSchema.groups)
      ? fpSchema.groups.map(g => g.id) : null,
    tlsGroups: (typeof fpSchema !== 'undefined' && fpSchema && fpSchema.tls)
      ? fpSchema.tls.groups.map(g => g.id) : null,
    tlsKeys: (typeof fpSchema !== 'undefined' && fpSchema && fpSchema.tls)
      ? fpSchema.tls.keyCount : null,
    keyCount: (typeof fpSchema !== 'undefined' && fpSchema) ? fpSchema.keyCount : null,
  }))()`, true).catch((e) => 'THREW ' + e.message);
  log('  schema seen by renderer: ' + schemaSeen);
  let sObj = null;
  try { sObj = JSON.parse(schemaSeen); } catch (e) { /* left null */ }
  ck('renderer received the schema', !!sObj && !sObj.isNull,
    sObj ? 'keyCount=' + sObj.keyCount : schemaSeen.slice(0, 80));
  ck('schema exposes the tls group',
    !!sObj && Array.isArray(sObj.tlsGroups) && sObj.tlsGroups.includes('tls'),
    sObj ? JSON.stringify(sObj.tlsGroups) : '-');
  ck('schema exposes 9 TLS keys', !!sObj && sObj.tlsKeys === 9, String(sObj && sObj.tlsKeys));
  ck('Blink key count is still 63', !!sObj && sObj.keyCount === 63, String(sObj && sObj.keyCount));

  // --- 2. Open the panel and switch to the Self-test tab ------------------
  await wc.executeJavaScript(`(() => {
    window.api.setPanelOpen(true);
    document.getElementById('fp-tab-selftest').click();
    return 1;
  })()`, true).catch((e) => log('  panel open threw: ' + e.message));
  await sleep(600);

  // --- 3. Apply a TLS-only config through the real apply path ------------
  const applyRes = await wc.executeJavaScript(`(async () => {
    const r = await window.api.setFingerprint(null, {
      fpOmitSessionTicket: true,
      fpGreaseEnabled: false,
    });
    return JSON.stringify(r);
  })()`, true).catch((e) => 'THREW ' + e.message);
  log('  apply result: ' + applyRes);
  ck('applying a TLS-only config reported success',
    /true|"ok"\s*:\s*true/.test(applyRes) && !/tlsError/.test(applyRes),
    applyRes.slice(0, 110));
  await sleep(1500);

  // --- 4. Click the real Self-test button --------------------------------
  await wc.executeJavaScript(`(() => {
    document.getElementById('fp-tab-selftest').click();
    document.getElementById('fp-selftest-run').click();
    return 1;
  })()`, true).catch((e) => log('  click threw: ' + e.message));

  // Poll the DOM until the results render (the handler is async).
  let paneText = '';
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    paneText = await wc.executeJavaScript(`(() => {
      const el = document.getElementById('fp-selftest-results');
      const s = document.getElementById('fp-selftest-summary');
      return JSON.stringify({
        results: el ? el.innerText.slice(0, 900) : null,
        summary: s ? s.innerText.slice(0, 250) : null,
      });
    })()`, true).catch(() => 'THREW');
    if (/fpOmitSessionTicket|fpGreaseEnabled/.test(paneText)) break;
  }
  log('  pane text: ' + String(paneText).slice(0, 600));

  let dom = null;
  try { dom = JSON.parse(paneText); } catch (e) { /* left null */ }
  ck('the self-test pane rendered a TLS group heading',
    !!dom && /TLS/i.test(dom.results || ''),
    dom ? String(dom.results || '').slice(0, 110).replace(/\n/g, ' | ') : 'no results');
  ck('the pane shows the configured TLS key names',
    !!dom && /fpOmitSessionTicket/.test(dom.results || '') &&
      /fpGreaseEnabled/.test(dom.results || ''));
  ck('the pane reports those TLS keys as pass',
    !!dom && /pass/i.test(dom.results || ''));
  ck('the summary counts TLS rows too',
    !!dom && /[1-9]\d*\s*pass/i.test(dom.summary || ''),
    dom ? String(dom.summary || '').slice(0, 90).replace(/\n/g, ' ') : '-');

  // --- 5. The trap: a TLS 1.3 name must be refused, not applied ---------
  const badRes = await wc.executeJavaScript(`(async () => {
    const r = await window.api.setFingerprint(null, { fpCipherList: 'TLS_AES_128_GCM_SHA256' });
    return JSON.stringify(r);
  })()`, true).catch((e) => 'THREW ' + e.message);
  log('  trap apply result: ' + badRes);
  ck('a TLS 1.3 cipher name is refused with a reason, not silently applied',
    /tlsError/.test(badRes) && /TLS 1\.3/.test(badRes) && /ECDHE/.test(badRes),
    badRes.slice(0, 130));

  log('');
  log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail));
  app.exit(fail === 0 ? 0 : 1);
});
setTimeout(() => { log('TIMEOUT'); app.exit(2); }, 280000);
