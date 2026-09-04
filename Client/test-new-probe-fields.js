// Gate the 11 probe fields added in the "human can verify every fingerprint"
// audit. Each must be OBSERVABLE: the probe reports a value, and configuring
// the key changes it.
//
// The failure mode this exists for: a PROBE_FIELDS entry that is listed and
// assigned but never changes is worse than no entry at all. The self-test pane
// would print a row with a value and a verdict, and the user would trust it.
// While writing these, four of the eleven were exactly that:
//
//   perf_now_precision_ms - sampled in a tight synchronous loop, so all 24
//     reads landed in the same millisecond and granularity read 1 regardless of
//     the config. The probe reported the key as failing while it worked.
//   audio_data_seed - an OscillatorNode renders a deterministic waveform, so
//     two different seeds produced an identical checksum (638 vs 638).
//   webrtc_ip - the address regex /(\d{1,3}\.){3}\d{1,3}/ matched SDP fields
//     that are not addresses ("1301675584 1").
//   fonts_whitelist - measured three fonts, then the test whitelisted all
//     three, so nothing was hidden. The key was working; the CASE was wrong.
//
// All four are now covered below with the shape that actually discriminates.
//
// Runs under Electron.

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

// Each case: config, and whether the surface MUST change.
// `mustChange: false` is a real assertion too - it catches a probe that reports
// a spurious difference when nothing was configured.
const CASES = [
  { key: 'webgl_max_renderbuffer_size', cfg: { webgl_max_renderbuffer_size: 4096 }, mustChange: true },
  { key: 'webgl_aliased_point_size_range', cfg: { webgl_aliased_point_size_range: '1,255' }, mustChange: true },
  { key: 'webgl_aliased_line_width_range', cfg: { webgl_aliased_line_width_range: '1,10' }, mustChange: true },
  { key: 'webgl_shader_precision_highp', cfg: { webgl_shader_precision_highp: '61,62,13' }, mustChange: true },
  { key: 'audio_max_channels', cfg: { audio_max_channels: 6 }, mustChange: true },
  { key: 'audio_output_latency_ms', cfg: { audio_output_latency_ms: 500 }, mustChange: true },
  { key: 'audio_data_seed', cfg: { audio_data_seed: 12345 }, mustChange: true, verdict: null },
  { key: 'perf_now_precision_ms', cfg: { perf_now_precision_ms: 100 }, mustChange: true },
  { key: 'media_codecs_denylist', cfg: { media_codecs_denylist: 'avc1' }, mustChange: true },
  // webrtc_ip needs a real ICE gather. On a host that gathers nothing the
  // honest answer is unknown, so this one is allowed to skip rather than fail.
  { key: 'webrtc_ip', cfg: { webrtc_ip: '1.2.3.4' }, mustChange: true, maySkip: true },
];

// fonts_whitelist is asserted separately: whether the surface changes depends
// on whether the whitelist excludes one of the measured fonts, so a single
// config cannot express "must change". See the block below.
const FONT_BASE = '219.92,352.34,308.41';   // Consolas, Georgia, Impact here
const FONT_CASES = [
  ['Consolas', true, 'hides the other two'],
  ['Georgia', true, 'hides the other two'],
  ['Consolas,Georgia,Impact', false, 'nothing is hidden, so nothing may change'],
  ['ZzzNotAFont', true, 'hides all three - the collapse hazard'],
];

let keepAlive = null;

async function measure(cfg) {
  const sess = session.fromPartition('nf-' + Math.random().toString(36).slice(2));
  if (cfg) sess.setFingerprintConfig(cfg);
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  });
  await w.loadURL('http://127.0.0.1:' + srv.address().port + '/');
  await new Promise((r) => setTimeout(r, 900));
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
  ck('the probe runs and reports the new fields', !!base && !base._probe_error,
    base ? Object.keys(base).length + ' fields' : 'no result');

  for (const c of CASES) {
    const got = await measure(c.cfg);
    const b = base[c.key], g = got[c.key];
    const changed = String(b) !== String(g);

    if (c.maySkip && (g === undefined || g === null || String(g).trim() === '')) {
      ck(c.key + ' is observable', null, 'no value on this host (ICE gathered nothing)');
      continue;
    }
    ck(c.key + ' changes when configured', changed === c.mustChange,
      'base=' + String(b).slice(0, 30) + ' configured=' + String(g).slice(0, 30));

    const want = (c.verdict === null) ? null : true;
    let v;
    try { v = compare(c.key, c.cfg[c.key], g); }
    catch (e) { v = 'threw: ' + e.message; }
    ck(c.key + ' verdicts as expected', v === want,
      'compare returned ' + String(v) + ', wanted ' + String(want));
  }

  // fonts_whitelist, asserted across configs rather than one.
  for (const [wl, expectChange, why] of FONT_CASES) {
    const g = (await measure({ fonts_whitelist: wl })).fonts_whitelist;
    const changed = String(base.fonts_whitelist) !== String(g);
    ck('fonts_whitelist=' + wl.slice(0, 24) + ' ' + (expectChange ? 'hides' : 'keeps') + ' fonts',
      changed === expectChange,
      'widths=' + String(g).slice(0, 34) + ' (' + why + ')');
  }

  // The collapse hazard: when a whitelist hides everything, all measured fonts
  // report one identical width. compare() must refuse to call that a pass.
  const collapsed = (await measure({ fonts_whitelist: 'ZzzNotAFont' })).fonts_whitelist;
  ck('compare() refuses to pass a fully collapsed font set',
    compare('fonts_whitelist', 'ZzzNotAFont', collapsed) === false,
    'widths=' + String(collapsed).slice(0, 34));

  console.log('');
  ck('run reached the end (did not die partway)', pass + fail + skip >= CASES.length,
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

setTimeout(() => { console.error('timeout'); app.exit(2); }, 500000);
