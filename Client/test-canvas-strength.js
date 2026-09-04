// Close the last structural coverage gap: canvas_noise_strength.
//
// It was the suite's only remaining SKIP, and structurally so: EXPECTED asked
// for it, the shared probe never produced it, so smoke.js could only ever
// report "not probed". Nothing anywhere checked that the CONFIGURED strength
// is the strength that took effect.
//
// The surface is observable. Kernel (fp_config_helpers.h:210):
//   delta = (h & 0xFF) % (2*strength + 1) - strength;   // |delta| <= strength
//   pixel = clamp(pixel + delta)
// So with the same seed and same drawn content, a larger strength must
// perturb the export more. Measured: strength=1 -> 2722, strength=8 -> 17451.
//
// This is the same shape as test-audio-strength.js, which closed the previous
// lone gap and found a real defect doing it (the key was inert when passed as
// a JS number). Worth stating: that file's audit note says 62/63 with
// audio_data_strength the only gap. This file's claim is the successor - and
// unlike that one, no defect surfaced here; the key simply had no probe.
//
// Runs under Electron (see run-tests.js).

'use strict';

const { app, BrowserWindow, session } = require('electron');
const http = require('http');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) {
    skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return;
  }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

// Electron QUITS when the last BrowserWindow closes. Each measurement destroys
// its own window, so without this the second measurement dies with ERR_FAILED
// and the run exits 0 having checked almost nothing.
let keepAlive = null;
const liveWindows = new Set();
const track = (w) => { liveWindows.add(w); return w; };

const srv = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'text/html' });
  s.end('<!doctype html><html><body>canvas-noise</body></html>');
});
let URL_ = null;

// Draw fixed content, export, and return raw pixels so the perturbation can be
// measured rather than merely detected.
const PROBE_JS = `(async () => {
  const draw = () => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 64, 64);
    g.addColorStop(0, '#336699'); g.addColorStop(1, '#cc6633');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    // Flat interior so deltas are not swamped by the gradient itself.
    x.fillStyle = '#808080'; x.fillRect(16, 16, 32, 32);
    return c;
  };
  const px = async (c) => {
    const bmp = await createImageBitmap(c);
    const oc = new OffscreenCanvas(64, 64);
    const ox = oc.getContext('2d');
    ox.drawImage(bmp, 0, 0);
    return Array.from(ox.getImageData(0, 0, 64, 64).data);
  };
  const d = draw();
  return { pixels: await px(d), url: d.toDataURL() };
})()`;

async function measure(cfg) {
  const sess = session.fromPartition('cns-' + Math.random().toString(36).slice(2));
  if (cfg) sess.setFingerprintConfig(cfg);
  const w = track(new BrowserWindow({
    show: false,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  }));
  await w.loadURL(URL_);
  await new Promise((r) => setTimeout(r, 350));
  try {
    const p = w.webContents.executeJavaScript(PROBE_JS, true);
    const t = new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 20000));
    return await Promise.race([p, t]);
  } finally {
    await w.destroy();
  }
}

// Total absolute per-channel difference - the perturbation magnitude.
function totalDiff(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

app.whenReady().then(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  URL_ = 'http://127.0.0.1:' + srv.address().port + '/';
  keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

  try {
    // seed=0 disables noise in the kernel (it returns early), giving an
    // unnoised baseline to measure every perturbation against.
    const base = await measure({ canvas_noise_seed: 0 });
    const s1 = await measure({ canvas_noise_seed: 12345, canvas_noise_strength: 1 });
    const s8 = await measure({ canvas_noise_seed: 12345, canvas_noise_strength: 8 });

    const okPixels = !!(base && base.pixels && s1 && s1.pixels && s8 && s8.pixels);
    check('probe returned pixels in all three runs', okPixels,
      [base, s1, s8].map((r) => (r && r.pixels ? r.pixels.length : 'null')).join('/'));
    if (!okPixels) throw new Error('probe returned no pixels');

    const d1 = totalDiff(base.pixels, s1.pixels);
    const d8 = totalDiff(base.pixels, s8.pixels);
    console.log('  perturbation vs unnoised baseline:');
    console.log('    strength=1 : ' + d1);
    console.log('    strength=8 : ' + d8);

    check('strength=1 perturbs the canvas export', d1 > 0, 'delta=' + d1);
    check('strength=8 perturbs MORE than strength=1', d8 > d1, d8 + ' vs ' + d1);
    // Ratio is the real assertion: it proves the CONFIGURED value reached the
    // kernel, not merely that noise is on.
    check('the perturbation SCALES with the configured strength',
      d8 / d1 > 2, 'ratio=' + (d1 ? (d8 / d1).toFixed(2) : 'n/a') + 'x (expect ~6x)');

    // |delta| <= strength per channel, over 64*64*4 channels.
    const maxTotal = 8 * 64 * 64 * 4;
    check('strength=8 stays within the kernel bound (|delta| <= strength)',
      d8 <= maxTotal, d8 + ' <= ' + maxTotal);

    // Same seed + same strength must be byte-identical - the kernel documents
    // this as a stable fingerprint change, not random noise.
    const again = await measure({ canvas_noise_seed: 12345, canvas_noise_strength: 8 });
    check('same seed + strength is deterministic', again.url === s8.url,
      again.url === s8.url ? 'identical bytes' : 'DIFFERED');

    // Control: different seed must produce different bytes, else the
    // determinism check above could pass simply because noise never applies.
    const otherSeed = await measure({ canvas_noise_seed: 999, canvas_noise_strength: 8 });
    check('a different seed produces different bytes (control)',
      otherSeed.url !== s8.url,
      otherSeed.url !== s8.url ? 'differs' : 'IDENTICAL - noise may be inert');
  } catch (e) {
    check('run completed without throwing', false, String(e && e.message));
  }

  srv.close();
  for (const w of [...liveWindows]) {
    liveWindows.delete(w);
    try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 300));

  // A run that dies partway never reaches here and would otherwise exit 0.
  const executed = pass + fail + skip;
  console.log('');
  check('run reached the end (did not die partway)', executed >= 7,
    executed + ' checks executed, expected >= 7');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks' + (skip ? ' (' + skip + ' skipped)' : '')
    : 'FAIL: ' + fail + ' of ' + (pass + fail + skip) + ' checks');
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.log('FAIL  run threw: ' + (e && e.message));
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(1);
});

setTimeout(() => { console.error('timeout'); app.exit(2); }, 120000);
