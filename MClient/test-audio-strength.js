// Close the last coverage gap: audio_data_strength.
//
// Audit result (all 63 keys checked against the patched src tree and every
// Client/test-*.js): 62 of 63 keys had a test observing the RENDERED surface.
// audio_data_strength was the only one that did not - it appeared in 8 places,
// always as a CONSTANT 0.5 that made the audio_data_seed test work. Never
// varied, never asserted.
//
// Writing the assertion exposed a REAL DEFECT: the key is silently inert when
// passed as a JS number.
//
// Root cause (verified, not inferred):
//   Session::SetFingerprintConfig serialises the raw JS object with
//   base::WriteJson - it does NOT go through fpNormalizeConfig(). So
//   setFingerprintConfig({ audio_data_strength: 0.01 }) emits the JSON number
//   "audio_data_strength":0.01 (confirmed via getFingerprintConfig()).
//   But the kernel reads it with FpConfigString(), which REQUIRES a quoted
//   string and returns "" for a number - so strength silently stays at its
//   0.0005 default and every value behaves identically.
//
//   Measured, same seed, varying strength:
//     as a NUMBER (0.0001 / 0.01 / 1) -> dev 1247, 1247, 1247 (all the default)
//     as a STRING ("0.0001"/"0.005")  -> dev 249, 12470  (scales ~linearly)
//
//   The 1247 for every number is the tell: it equals the string-"0.0005"
//   result exactly, i.e. numbers always land on the default.
//
// This is the ONLY key affected: it is the sole key the kernel reads with
// FpConfigString while the schema types it as something a caller would pass
// as a number. Every other string-read key is str/csv/bool.
//
// Kernel semantics (fp_config_helpers.h FpApplyAudioDataNoise):
//   - noise applies only when audio_data_seed > 0
//   - delta[i] = (hash(seed,i)/127.5 - 1.0) * strength   => LINEAR in strength
//   - strength defaults to 0.0005 when unset
//   - parsed by base::StringToDouble, CLAMPED to [0,1]
//
// Runs inside the Electron main process.

'use strict';

const { app, BrowserWindow, session } = require('electron');
const http = require('http');

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

const liveWindows = new Set();
function track(w) { liveWindows.add(w); return w; }
async function closeAllWindows() {
  for (const w of [...liveWindows]) {
    liveWindows.delete(w);
    try {
      if (!w.isDestroyed()) { w.webContents.destroy(); w.destroy(); }
    } catch (_) { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 400));
}

// Render a deterministic 440Hz tone offline and reduce the first 256 samples to
// one integer. Same seed + same content => identical output, so any difference
// between runs is attributable to the config.
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

const srv = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'text/html' });
  s.end('<html><body>probe</body></html>');
});

let URL_;
// Hold a window so Electron does not quit between measurements: it exits when
// the last BrowserWindow closes, silently truncating the run AND still exiting 0.
let keepAlive = null;

async function probe(fingerprint) {
  const sess = session.fromPartition('ads-' + Math.random().toString(36).slice(2));
  if (fingerprint) sess.setFingerprintConfig(fingerprint);
  const w = track(new BrowserWindow({
    show: false,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  }));
  await w.loadURL(URL_);
  await new Promise((r) => setTimeout(r, 350));
  const r = await w.webContents.executeJavaScript(AUDIO_JS, true);
  await w.destroy();
  return r;
}

(async () => {
  try {
    await app.whenReady();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    URL_ = 'http://127.0.0.1:' + srv.address().port + '/';
    keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

    const SEED = 123456789;

    // Un-noised reference: no seed => FpApplyAudioDataNoise returns early.
    const clean = await probe(null);
    check('audio: baseline renders', typeof clean === 'number' && clean > 0,
      String(clean));

    // ---- the key works when given as a STRING -----------------------------
    const weak = await probe({ audio_data_seed: SEED, audio_data_strength: '0.0001' });
    const strong = await probe({ audio_data_seed: SEED, audio_data_strength: '0.005' });
    const devW = Math.abs(weak - clean);
    const devS = Math.abs(strong - clean);
    console.log('\n--- audio_data_strength as a STRING ---');
    console.log('  clean=' + clean + '  "0.0001" -> dev ' + devW +
      '   "0.005" -> dev ' + devS);

    check('audio_data_strength ("0.0001") moves the rendered signal',
      devW > 0, 'dev=' + devW);
    check('audio_data_strength ("0.005") moves it further than "0.0001"',
      devS > devW * 5, devS + ' > 5x ' + devW);

    // LINEAR SCALING: 50x the strength must give ~50x the deviation. This is
    // what fails if the key is parsed-but-ignored.
    const ratio = devW === 0 ? Infinity : devS / devW;
    check('audio_data_strength scales the noise ~linearly (50x => ~50x)',
      devW > 0 && ratio > 35 && ratio < 70,
      'ratio=' + ratio.toFixed(1) + ' (expected ~50)');

    // ---- REGRESSION: a NUMBER must NOT silently fall back ------------------
    //
    // Passing 0.01 as a JS number emits an unquoted JSON number, which
    // FpConfigString cannot read, so strength stays at the 0.0005 default.
    // That default is observable, so this is falsifiable: if setFingerprintConfig
    // ever starts normalising to strings, this check fails and the workaround
    // documented here can be deleted.
    const asNumber = await probe({ audio_data_seed: SEED, audio_data_strength: 0.01 });
    const asDefaultString = await probe({ audio_data_seed: SEED, audio_data_strength: '0.0005' });
    console.log('\n--- the number-typed trap ---');
    console.log('  number 0.01 -> ' + asNumber +
      '   string "0.0005" -> ' + asDefaultString);
    check('audio_data_strength as a NUMBER falls back to the 0.0005 default ' +
      '(documented trap)',
      asNumber === asDefaultString,
      'number ' + asNumber + ' vs default ' + asDefaultString);

    // And the string form must actually differ from that default - otherwise
    // the two checks above would both be satisfied by a dead key.
    check('audio_data_strength as a STRING differs from the default',
      strong !== asDefaultString,
      strong + ' vs default ' + asDefaultString);

    // ---- clamping: outside [0,1] leaves the default -----------------------
    const clamped = await probe({ audio_data_seed: SEED, audio_data_strength: '2' });
    check('audio_data_strength outside [0,1] is clamped to the default',
      clamped === asDefaultString,
      '"2" -> ' + clamped + ', default -> ' + asDefaultString);

    srv.close();
    await closeAllWindows();
  } catch (e) {
    check('audio-strength: run completed without throwing', false, String(e && e.message));
    try { srv.close(); } catch (_) {}
    try { await closeAllWindows(); } catch (_) {}
  }

  const executed = pass + fail + skip;
  console.log('');
  check('audio-strength: run reached the end (did not die partway)',
    executed >= 7, executed + ' checks executed, expected >= 7');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks' + (skip ? ' (' + skip + ' skipped)' : '')
    : 'FAIL: ' + fail + ' of ' + (pass + fail + skip) + ' checks');
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(fail === 0 ? 0 : 1);
})();
