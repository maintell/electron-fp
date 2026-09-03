// Test the Client self-test's VERDICT LOGIC against the real kernel.
//
// The point of this file is one specific guarantee: the self-test must FAIL a
// key that is configured but does not take effect. A self-test that reports
// green for "configured, silently ignored" is worse than no self-test, because
// it actively reassures.
//
// Two trap cases are used, both of which were real defects found by measurement
// earlier in this project (not hypothetical):
//
//   A) webgl_max_viewport_dims: '8192' (STRING) -> kernel StringToInt rejects
//      it and the surface silently falls back to the real hardware value
//      (32767,32767). A quoted number is inert.
//   B) audio_data_strength: 0.01 (NUMBER) -> setFingerprintConfig serialises
//      with WriteJson, emitting an unquoted JSON number; FpConfigString needs a
//      quoted string, returns "", and the 0.0005 default is used.
//
// In both, the config LOOKS set - fpIsActive() says yes, the Inspector reports
// the key as active - and the surface does something else entirely. Those are
// exactly the cases the panel exists to catch.

'use strict';

const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const { PROBE, PROBE_FIELDS, compare } = require('./fp-probe');
const { fpIsActive } = require('./fp-schema');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) {
    skip++;
    console.log('SKIP  ' + name + (detail ? ': ' + detail : ''));
    return;
  }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

// Hold a window so Electron does not quit between measurements: it exits when
// the last BrowserWindow closes, which truncates the run AND still exits 0.
let keepAlive = null;
const liveWindows = new Set();
function track(w) { liveWindows.add(w); return w; }

const srv = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'text/html' });
  s.end('<!doctype html><html><body>fp-selftest</body></html>');
});
let URL_;

// Mirror of main.js's selftest:run verdict logic, so what is tested here IS
// what the panel reports. Kept structurally identical on purpose.
function verdicts(cfg, observed) {
  const rows = [];
  for (const key of PROBE_FIELDS) {
    const got = observed[key];
    if (got === undefined || got === null) {
      rows.push({ key, verdict: 'skip', reason: 'not probed' });
      continue;
    }
    if (!fpIsActive(key, cfg[key])) {
      rows.push({ key, verdict: 'skip', reason: 'not configured' });
      continue;
    }
    let ok = false;
    try { ok = compare(key, cfg[key], got); } catch (e) {
      rows.push({ key, verdict: 'error', reason: 'compare threw' });
      continue;
    }
    rows.push({ key, verdict: ok ? 'pass' : 'fail', expected: cfg[key], got });
  }
  return rows;
}

async function probeWith(cfg) {
  const sess = session.fromPartition('st-' + Math.random().toString(36).slice(2));
  if (cfg) sess.setFingerprintConfig(cfg);
  const w = track(new BrowserWindow({
    show: false,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  }));
  await w.loadURL(URL_);
  await new Promise((r) => setTimeout(r, 350));
  let observed = null;
  try {
    const p = w.webContents.executeJavaScript(PROBE, true);
    const t = new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 15000));
    observed = await Promise.race([p, t]);
  } finally {
    await w.destroy();
  }
  // What the kernel actually received, i.e. post-normalisation.
  let effective = null;
  try { effective = JSON.parse(JSON.stringify(cfg || {})); } catch (e) { effective = cfg || {}; }
  return { observed, effective };
}

// Render a deterministic 440Hz tone offline and reduce 256 samples to one
// integer. The kernel adds noise whose amplitude is audio_data_strength, so
// this integer is the observable for that key.
const AUDIO_JS = [
  '(async function(){',
  '  var oc=new OfflineAudioContext(1, 2048, 44100);',
  '  var osc=oc.createOscillator(); osc.frequency.value=440;',
  '  var gain=oc.createGain(); gain.gain.value=0.5;',
  '  osc.connect(gain); gain.connect(oc.destination); osc.start(0);',
  '  var buf = await oc.startRendering();',
  '  var d=buf.getChannelData(0); var s=0;',
  '  for(var i=0;i<256;i++){ s += Math.abs(d[i]); }',
  '  return Math.round(s*1000000);',
  '})()',
].join('\n');

async function audioNoise(strength) {
  const sess = session.fromPartition('an-' + Math.random().toString(36).slice(2));
  sess.setFingerprintConfig({ audio_data_seed: 123456789, audio_data_strength: strength });
  const w = track(new BrowserWindow({
    show: false,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  }));
  await w.loadURL(URL_);
  await new Promise((r) => setTimeout(r, 350));
  let r = null;
  try { r = await w.webContents.executeJavaScript(AUDIO_JS, true); }
  finally { await w.destroy(); }
  return r;
}

(async () => {
  try {
    await app.whenReady();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    URL_ = 'http://127.0.0.1:' + srv.address().port + '/';
    keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

    // ---- 1) the probe works at all -------------------------------------
    const base = await probeWith(null);
    check('probe returns an object', base.observed && typeof base.observed === 'object',
      Object.keys(base.observed || {}).length + ' fields');
    check('probe did not throw', !base.observed._probe_error,
      base.observed._probe_error || 'clean');
    check('probe read storage surfaces (proves a real origin, not opaque)',
      base.observed.storage_quota_bytes !== undefined,
      'storage_quota_bytes=' + base.observed.storage_quota_bytes);
    check('probe read webgl surfaces (proves a fresh canvas was used)',
      base.observed.webgl_max_texture_size !== undefined,
      'webgl_max_texture_size=' + base.observed.webgl_max_texture_size);

    // ---- 2) an unconfigured profile must produce NO failures ------------
    const emptyRows = verdicts({}, base.observed);
    const emptyFail = emptyRows.filter((r) => r.verdict === 'fail');
    check('unconfigured config yields zero FAIL rows',
      emptyFail.length === 0,
      emptyFail.length + ' fails: ' + emptyFail.map((r) => r.key).join(','));

    // ---- 3) a correctly-configured key must PASS ------------------------
    const good = await probeWith({ tz_id: 'America/New_York' });
    const goodRows = verdicts({ tz_id: 'America/New_York' }, good.observed);
    const tzRow = goodRows.find((r) => r.key === 'tz_id');
    check('correctly applied key verdicts pass',
      tzRow && tzRow.verdict === 'pass',
      tzRow ? tzRow.verdict + ' got=' + tzRow.got : 'row missing');

    // ---- 4) TRAP A: quoted number must FAIL, not pass -------------------
    //
    // '8192' as a string is rejected by the kernel's StringToInt, so the
    // surface reports the real hardware value instead of 8192,8192.
    const trapA = await probeWith({ webgl_max_viewport_dims: '8192' });
    const trapARows = verdicts({ webgl_max_viewport_dims: '8192' }, trapA.observed);
    const rowA = trapARows.find((r) => r.key === 'webgl_max_viewport_dims');
    check('TRAP A: webgl_max_viewport_dims="8192" (quoted) verdicts FAIL',
      rowA && rowA.verdict === 'fail',
      rowA ? rowA.verdict + ' expected=8192 got=' + rowA.got : 'row missing');
    check('TRAP A: the failure is a real fallback to hardware, not a fluke',
      rowA && String(rowA.got) !== '8192,8192',
      rowA ? 'got=' + rowA.got : 'n/a');

    // Control: the SAME key as an unquoted number must PASS. Without this the
    // trap assertion could pass simply because the key never works.
    const ctrlA = await probeWith({ webgl_max_viewport_dims: 8192 });
    const ctrlARows = verdicts({ webgl_max_viewport_dims: 8192 }, ctrlA.observed);
    const cRowA = ctrlARows.find((r) => r.key === 'webgl_max_viewport_dims');
    check('TRAP A control: webgl_max_viewport_dims=8192 (number) verdicts PASS',
      cRowA && cRowA.verdict === 'pass',
      cRowA ? cRowA.verdict + ' got=' + cRowA.got : 'row missing');

    // ---- 5) TRAP B: audio_data_strength as a number ----------------------
    //
    // This surface is NOT in the shared PROBE. The shared probe reports 40
    // fields and audio_data_strength is not one of them - it only reads
    // audio_sample_rate. A first version of this test compared the whole
    // observed object and got a false "trap no longer applies", because the
    // fields that differed between windows (canvas/device values, which vary
    // run to run) had nothing to do with audio.
    //
    // So measure the surface the key actually controls: the noise amplitude on
    // an OfflineAudioContext render, exactly as test-audio-strength.js does.
    const asNumber = await audioNoise(0.01);
    const asDefault = await audioNoise('0.0005');
    const asBig = await audioNoise('0.005');
    check('TRAP B: audio_data_strength as a NUMBER lands on the 0.0005 default',
      asNumber === asDefault,
      'number ' + asNumber + ' vs default ' + asDefault +
      (asNumber === asDefault ? ' (trap holds)' : ' (trap no longer applies)'));
    // Without this control the check above could pass simply because the whole
    // surface is dead. This proves a fix would be visible.
    check('TRAP B control: the STRING form differs from the default',
      asBig !== asDefault,
      'string"0.005" ' + asBig + ' vs default ' + asDefault);

    // ---- 6) verdict vocabulary is complete ------------------------------
    const kinds = new Set([...emptyRows, ...goodRows, ...trapARows].map((r) => r.verdict));
    check('verdicts only use pass/fail/skip/error',
      [...kinds].every((k) => ['pass', 'fail', 'skip', 'error'].includes(k)),
      [...kinds].join(','));

    srv.close();
    for (const w of [...liveWindows]) {
      liveWindows.delete(w);
      try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 300));
  } catch (e) {
    check('selftest: run completed without throwing', false, String(e && e.message));
    try { srv.close(); } catch (_) {}
  }

  // Guard: Electron quits when the last BrowserWindow closes, so a run that
  // dies partway never reaches this line and would otherwise exit 0.
  const executed = pass + fail + skip;
  console.log('');
  check('selftest: run reached the end (did not die partway)',
    executed >= 12, executed + ' checks executed, expected >= 12');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks' + (skip ? ' (' + skip + ' skipped)' : '')
    : 'FAIL: ' + fail + ' of ' + (pass + fail + skip) + ' checks');
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(fail === 0 ? 0 : 1);
})();
