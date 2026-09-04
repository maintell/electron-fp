// Gate the compare() semantics that the full-profile run exposed.
//
// These four were all WRONG until a 58-key profile was applied and every row
// inspected. Each one reported a verdict the user would have trusted:
//
//   webgl_extensions  required exact equality, but the kernel APPENDS
//     (20-blink-modules.patch:167 only pushes names not already present). A
//     correctly applied config failed whenever the platform reported any other
//     extension - which is always.
//   speech_voices_count  required equality, but the kernel only TRUNCATES
//     (`if (fp_count > 0 && fp_count < voices.size()) resize(fp_count)`,
//     20-blink-modules.patch:319). A host with fewer voices than the config can
//     never honour it, so equality blamed the kernel for the host.
//   fonts_blocklist  probed document.fonts.check(), which stays TRUE when a
//     font is hidden because the family falls back. The panel read "true" for a
//     working key. Now probes the rendered WIDTH (219.92 -> 370.41 measured).
//   fonts_whitelist  same class of bug, fixed in the same pass - the probe
//     reports widths, and compare() must refuse to pass a fully collapsed set.
//
// Runs under Electron: these are real surfaces, not pure logic.

'use strict';

const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const { PROBE, compare } = require('./fp-probe');

let pass = 0, fail = 0, skip = 0;
function ck(name, cond, detail) {
  if (cond === null || cond === undefined) {
    skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return;
  }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const srv = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'text/html' });
  s.end('<!doctype html><html><body>probe</body></html>');
});

let keepAlive = null;
async function measure(cfg) {
  const sess = session.fromPartition('cm-' + Math.random().toString(36).slice(2));
  if (cfg) sess.setFingerprintConfig(cfg);
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  });
  await w.loadURL('http://127.0.0.1:' + srv.address().port + '/');
  await new Promise((r) => setTimeout(r, 700));
  let out;
  try {
    const p = w.webContents.executeJavaScript(PROBE, true);
    const t = new Promise((_, rj) => setTimeout(() => rj(new Error('probe timeout')), 40000));
    out = await Promise.race([p, t]);
  } finally { try { w.destroy(); } catch (_) { /* gone */ } }
  return out;
}

app.whenReady().then(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  keepAlive = new BrowserWindow({ show: false, width: 80, height: 80 });
  const base = await measure(null);

  // --- webgl_extensions: append, not replace -------------------------------
  const extGot = (await measure({ webgl_extensions: 'EXT_texture_filter_anisotropic' })).webgl_extensions;
  ck('webgl_extensions passes when the configured name is present among others',
    compare('webgl_extensions', 'EXT_texture_filter_anisotropic', extGot) === true,
    'platform reported ' + String(extGot).split(',').length + ' extensions');
  ck('webgl_extensions fails when the configured name is absent',
    compare('webgl_extensions', 'ZZZ_Not_An_Extension', extGot) === false,
    'absent name rejected');
  // The regression this guards: exact equality would fail the first check.
  ck('webgl_extensions does NOT require exact equality',
    String(extGot) !== 'EXT_texture_filter_anisotropic',
    'platform list is a superset, so equality would fail');

  // --- speech_voices_count: truncate-only ----------------------------------
  const voices = Number(base.speech_voices_count);
  ck('speech_voices_count passes when the host is already under the cap',
    compare('speech_voices_count', 7, String(Math.min(voices, 3))) === true,
    'host reports ' + voices + ' voices, cap 7');
  ck('speech_voices_count fails when the count exceeds the cap',
    compare('speech_voices_count', 2, '5') === false,
    '5 voices over a cap of 2');

  // --- fonts_blocklist: width, not check() ---------------------------------
  const fbBase = base.fonts_blocklist;
  const fbBlocked = (await measure({ fonts_blocklist: 'Consolas' })).fonts_blocklist;
  ck('fonts_blocklist width changes when the font is blocked',
    String(fbBase) !== String(fbBlocked),
    String(fbBase) + ' -> ' + String(fbBlocked));
  const fbUntouched = (await measure({ fonts_blocklist: 'ZzzNotAFont' })).fonts_blocklist;
  ck('fonts_blocklist width is unchanged when an unused font is blocked',
    String(fbBase) === String(fbUntouched),
    'still ' + String(fbUntouched));
  // compare() returns null (no baseline), so both must be consistent with that.
  ck('fonts_blocklist verdicts unknown (no baseline to judge a width against)',
    compare('fonts_blocklist', 'Consolas', fbBlocked) === null,
    'null, as designed');

  // --- fonts_whitelist: refuse to pass a collapsed set ----------------------
  const fwCollapsed = (await measure({ fonts_whitelist: 'ZzzNotAFont' })).fonts_whitelist;
  ck('fonts_whitelist reports one width for every font when all are hidden',
    new Set(String(fwCollapsed).split(',').map((s) => s.trim())).size === 1,
    String(fwCollapsed));
  ck('fonts_whitelist refuses to pass a fully collapsed set',
    compare('fonts_whitelist', 'ZzzNotAFont', fwCollapsed) === false,
    'collapsed -> false, not a vacuous pass');

  console.log('');
  ck('run reached the end (did not die partway)', pass + fail + skip >= 9,
    (pass + fail + skip) + ' checks executed');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks' + (skip ? ' (' + skip + ' skipped)' : '')
    : 'FAIL: ' + fail + ' of ' + (pass + fail + skip) + ' checks');

  srv.close();
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.log('FAIL  run threw: ' + (e && e.message));
  try { srv.close(); } catch (_) {}
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(1);
});

setTimeout(() => { console.error('timeout'); app.exit(2); }, 400000);
