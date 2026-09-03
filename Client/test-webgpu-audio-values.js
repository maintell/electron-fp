// Value-level assertions for the webgpu_* and audio_* keys.
//
// These were previously reported as "host-dependent, not assertable" - that
// turned out to be WRONG. Two separate claims had to be checked:
//
//   1. "webgpu_* is not implemented in the kernel." False. All six keys are
//      consumed in third_party/blink/renderer/modules/webgpu/gpu_adapter.cc
//      (FpConfigString("webgpu_vendor") etc.). An earlier grep reported zero
//      hits because of how the search was invoked, not because the code was
//      missing. Discipline: a negative grep must be confirmed by a second
//      method before it is believed.
//
//   2. "navigator.gpu / AudioContext are not probeable." False. Both work on a
//      real http://127.0.0.1 origin; navigator.gpu exists and requestAdapter()
//      returns vendor/architecture/device/description plus a feature list.
//
// So all 12 keys ARE assertable, and this file pins their applied VALUES.
//
// Two semantics are pinned because they differ, and guessing wrong silently
// produces a passing-looking test:
//   - webgpu_features: REPLACE. The configured list fully replaces the real
//     set; unknown names are DROPPED rather than exposed.
//   - webgpu_limits:   MERGE. Only configured keys override; the rest keep
//     adapter values. (Over-reporting would make Dawn reject device creation.)
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

// Minimum number of checks a COMPLETE run must execute. Guards against the
// run dying partway through and still exiting 0.
const MIN_CHECKS = 10;

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

// Read both surfaces. WebGPU adapter info is behind requestAdapter(), which is
// async, so the whole probe is an async IIFE awaited via executeJavaScript.
const PROBE = `(async () => {
  const out = {};
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    out.sampleRate = ac.sampleRate;
    out.maxChannels = ac.destination ? ac.destination.maxChannelCount : null;
    out.baseLatency = ac.baseLatency;
    // outputLatency is the surface audio_output_latency_ms actually patches
    // (AudioContext::outputLatency() in the blink patch). baseLatency is a
    // different value and never moves under this key - measured 0.01 both with
    // and without it.
    out.outputLatency = ac.outputLatency;
  } catch (e) { out.audioErr = String(e); }

  out.hasGpu = !!navigator.gpu;
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) { out.adapterNull = true; }
      else {
        out.vendor = a.info ? a.info.vendor : null;
        out.architecture = a.info ? a.info.architecture : null;
        out.device = a.info ? a.info.device : null;
        out.description = a.info ? a.info.description : null;
        out.features = a.features ? Array.from(a.features).sort() : null;
        out.limits = a.limits ? {
          maxTextureDimension2D: a.limits.maxTextureDimension2D,
          maxBindGroups: a.limits.maxBindGroups,
          maxBufferSize: a.limits.maxBufferSize,
        } : null;
      }
    } catch (e) { out.gpuErr = String(e); }
  }
  return out;
})()`;

const srv = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'text/html' });
  s.end('<html><body>probe</body></html>');
});

// KEEPALIVE WINDOW - without this the whole test silently dies partway through.
// Electron QUITS when the last BrowserWindow is destroyed. This test destroys
// its probe window after every measurement, so as soon as the first probe
// completed, the only window was gone, the process exited, and the run stopped
// right after "--- baseline ---" with an ERR_FAILED on the next load.
//
// The dangerous part is how it presents: the process still exited with code 0,
// so the failure looked like a flaky network error rather than a dead process.
// Measured: 4/4 loads succeed with a keepAlive window, 1/4 without.
let keepAlive = null;

async function probeWith(fingerprint) {
  const sess = session.fromPartition('wgpu-' + Math.random().toString(36).slice(2));
  if (fingerprint) sess.setFingerprintConfig(fingerprint);
  const w = track(new BrowserWindow({
    show: false,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  }));
  await w.loadURL(URL_);
  await new Promise((r) => setTimeout(r, 500));
  const r = await w.webContents.executeJavaScript(PROBE, true);
  await w.destroy();
  return r;
}

let URL_;

(async () => {
  try {
    await app.whenReady();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    URL_ = 'http://127.0.0.1:' + srv.address().port + '/';
    keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

    const base = await probeWith(null);
    if (!base || base.gpuErr || base.audioErr) {
      check('webgpu-audio: probe reached both surfaces', false,
        JSON.stringify(base && (base.gpuErr || base.audioErr)));
      srv.close();
      await closeAllWindows();
      if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
      app.exit(1);
      return;
    }
    check('webgpu-audio: probe reached both surfaces', true,
      'gpu=' + base.hasGpu + ' sampleRate=' + base.sampleRate);

    if (!base.hasGpu || base.adapterNull) {
      // No adapter in this environment: the webgpu assertions cannot run, but
      // that is an environment fact, not a pass. Report and stop.
      check('webgpu-audio: adapter available', null,
        'no WebGPU adapter here - webgpu_* values untested');
    } else {
      console.log('\n--- baseline ---');
      console.log('  vendor=' + base.vendor + ' arch=' + base.architecture +
        ' device=' + base.device + ' desc=' + base.description);
      console.log('  features(' + (base.features || []).length + '): ' +
        (base.features || []).join(' '));
      console.log('  limits: ' + JSON.stringify(base.limits));

      // ---------- vendor / architecture / device / description -------------
      // webgpu_device / webgpu_description are only EXPOSED when the
      // WebGPUDeveloperFeatures runtime-enabled feature is on: upstream Blink
      // builds GPUAdapterInfo with vendor/architecture only otherwise
      // (gpu_adapter.cc CreateAdapterInfoForAdapter). The keys still apply, they
      // are just not readable - so without the flag these two are reported as
      // SKIP rather than FAIL. Verified: with
      // --enable-blink-features=WebGPUDeveloperFeatures, webgpu_device applies
      // exactly; without it, a.info.device is always "".
      const devFeatures = process.argv.includes('--webgpu-dev-features') ||
        /^1|true$/i.test(process.env.FP_WEBGPU_DEV_FEATURES || '');
      const meta = await probeWith({
        webgpu_vendor: 'AcmeVendor',
        webgpu_architecture: 'acme-arch',
        webgpu_device: 'AcmeDevice',
        webgpu_description: 'Acme GPU Driver',
      });
      console.log('\n--- webgpu_{vendor,architecture,device,description} ---');
      console.log('  got vendor=' + meta.vendor + ' arch=' + meta.architecture +
        ' device=' + meta.device + ' desc=' + meta.description);

      check('webgpu_vendor applies the exact value',
        meta.vendor === 'AcmeVendor', JSON.stringify(meta.vendor));
      check('webgpu_architecture applies the exact value',
        meta.architecture === 'acme-arch', JSON.stringify(meta.architecture));
      if (!devFeatures) {
        check('webgpu_device applies the exact value', null,
          'needs --enable-blink-features=WebGPUDeveloperFeatures; upstream Blink ' +
            'hides a.info.device without it');
        check('webgpu_description applies the exact value', null,
          'needs --enable-blink-features=WebGPUDeveloperFeatures; upstream Blink ' +
            'hides a.info.description without it');
      } else {
        check('webgpu_device applies the exact value',
          meta.device === 'AcmeDevice', JSON.stringify(meta.device));
        check('webgpu_description applies the exact value',
          meta.description === 'Acme GPU Driver', JSON.stringify(meta.description));
      }

      // ---------- webgpu_features: REPLACE semantics ------------------------
      // Two real feature names must fully replace the (longer) real list.
      const feat = await probeWith({
        webgpu_features: 'depth-clip-control, timestamp-query',
      });
      console.log('\n--- webgpu_features (REPLACE) ---');
      console.log('  got: ' + JSON.stringify(feat.features));
      check('webgpu_features REPLACES the real list',
        Array.isArray(feat.features) && feat.features.length === 2 &&
          feat.features.includes('depth-clip-control') &&
          feat.features.includes('timestamp-query'),
        (feat.features || []).length + ' features (baseline had ' +
          (base.features || []).length + ')');

      // An invented name must be DROPPED, not exposed: exposing it would be a
      // detection signal of its own.
      const bogus = await probeWith({
        webgpu_features: 'depth-clip-control, not-a-real-feature',
      });
      check('webgpu_features DROPS unknown names (does not expose them)',
        Array.isArray(bogus.features) &&
          bogus.features.includes('depth-clip-control') &&
          !bogus.features.includes('not-a-real-feature'),
        JSON.stringify(bogus.features));

      // ---------- webgpu_limits: MERGE semantics ----------------------------
      // Deliberately UNDER-report (below the real value). Over-reporting makes
      // Dawn reject device creation, so it would test nothing.
      const maxTex = base.limits && base.limits.maxTextureDimension2D;
      if (!maxTex) {
        check('webgpu_limits: baseline limit readable', null, 'no maxTextureDimension2D');
      } else {
        const want = Math.max(1, Math.min(256, Math.floor(maxTex / 2)));

        // FORMAT TRAP - the value must be QUOTE-FREE. FpConfigString() ends the
        // value at the FIRST quote after the opening one
        // (fp_config_helpers.h: content.find('"', i + 1)), so the natural JSON
        // form '{"maxTextureDimension2D":256}' is truncated to '{'. That is
        // non-empty, so the override block runs, but with no closing brace the
        // parser breaks immediately and applies NOTHING - silently.
        //
        // Measured, same key, same value, four formats:
        //   {"maxTextureDimension2D":256}  -> 16384  (unchanged - the trap)
        //   {maxTextureDimension2D:256}    -> 256    (correct)
        //   maxTextureDimension2D:256      -> 16384  (needs braces)
        //
        // The quoted form is pinned below as a NEGATIVE check so the trap is
        // documented by a failing example rather than only by this comment.
        const lim = await probeWith({
          webgpu_limits: '{maxTextureDimension2D:' + want + ',maxBindGroups:2}',
        });
        console.log('\n--- webgpu_limits (MERGE) ---');
        console.log('  maxTextureDimension2D: ' + maxTex + ' -> ' +
          (lim.limits && lim.limits.maxTextureDimension2D));
        check('webgpu_limits overrides the configured key',
          lim.limits && lim.limits.maxTextureDimension2D === want,
          'want ' + want + ', got ' +
            (lim.limits && lim.limits.maxTextureDimension2D));
        check('webgpu_limits applies a second key in the same value',
          lim.limits && lim.limits.maxBindGroups === 2,
          'maxBindGroups want 2, got ' + (lim.limits && lim.limits.maxBindGroups));

        // NEGATIVE CHECK: the quoted JSON form must be observably inert. If a
        // future change makes FpConfigString() quote-aware, this fails and the
        // comment above is due for an update - which is the intended signal.
        const quoted = await probeWith({
          webgpu_limits: '{"maxTextureDimension2D":' + want + '}',
        });
        check('webgpu_limits: quoted-JSON form is INERT (documents the trap)',
          quoted.limits && quoted.limits.maxTextureDimension2D === maxTex,
          'quoted form gave ' +
            (quoted.limits && quoted.limits.maxTextureDimension2D) +
            ' vs native ' + maxTex + ' (expected unchanged)');

        // MERGE: an unrelated limit must KEEP its adapter value.
        check('webgpu_limits MERGEs (unconfigured limits keep adapter value)',
          lim.limits && base.limits &&
            lim.limits.maxBufferSize === base.limits.maxBufferSize,
          'maxBufferSize ' + (lim.limits && lim.limits.maxBufferSize) +
            ' vs baseline ' + (base.limits && base.limits.maxBufferSize));
      }
    }

    // ---------- audio_* ------------------------------------------------------
    // audio_sample_rate / audio_max_channels / audio_output_latency_ms
    console.log('\n--- audio_* ---');
    // audio_output_latency_ms is in MILLISECONDS and is read with FpConfigInt.
    // The old value of 0.05 truncated to the integer 0, so the kernel's
    // `if (fp_lat > 0)` guard fell through to the native latency and the key
    // did nothing - the test had been asserting a no-op.
    //
    // It also controls AudioContext::outputLatency(), NOT baseLatency(). The
    // old assertion watched baseLatency, which never moves (measured: 0.01
    // with and without the key). Asserting the wrong surface made a working
    // key look broken.
    const aud = await probeWith({
      audio_sample_rate: 44100,
      audio_max_channels: 6,
      audio_output_latency_ms: 50,
    });
    console.log('  got sampleRate=' + aud.sampleRate +
      ' maxChannels=' + aud.maxChannels + ' outputLatency=' + aud.outputLatency +
      ' baseLatency=' + aud.baseLatency);
    check('audio_sample_rate applies the exact value',
      aud.sampleRate === 44100, String(aud.sampleRate));
    check('audio_max_channels applies the exact value',
      aud.maxChannels === 6, String(aud.maxChannels));
    // 50 ms -> 0.05 s. Exact, because the kernel does fp_lat / 1000.0.
    check('audio_output_latency_ms is applied as seconds on outputLatency',
      typeof aud.outputLatency === 'number' &&
        Math.abs(aud.outputLatency - 0.05) < 1e-9,
      String(aud.outputLatency));
    // A fractional millisecond cannot be honoured: FpConfigInt truncates it to
    // 0 and the key is skipped, leaving the native latency. Pinned so the
    // documented int-milliseconds contract is not silently broken later.
    const frac = await probeWith({ audio_output_latency_ms: 0.05 });
    check('audio_output_latency_ms: fractional ms is ignored (int key)',
      frac.outputLatency === base.outputLatency,
      String(frac.outputLatency) + ' vs baseline ' + String(base.outputLatency));

    srv.close();
    await closeAllWindows();
  } catch (e) {
    check('webgpu-audio: run completed without throwing', false, String(e && e.message));
    try { srv.close(); } catch (_) {}
    try { await closeAllWindows(); } catch (_) {}
  }

  // A completed run must have actually reached the end. Note: process exit code
  // alone is NOT trustworthy here - when Electron auto-quit mid-run (see the
  // keepAlive note above) the process still exited 0 while most checks never
  // ran. Asserting a minimum number of executed checks is what catches that.
  const executed = pass + fail + skip;
  console.log('');
  check('webgpu-audio: run reached the end (did not die partway)',
    executed >= MIN_CHECKS,
    executed + ' checks executed, expected >= ' + MIN_CHECKS);
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks' + (skip ? ' (' + skip + ' skipped)' : '')
    : 'FAIL: ' + fail + ' of ' + (pass + fail + skip) + ' checks');
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(fail === 0 ? 0 : 1);
})();
