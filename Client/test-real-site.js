// Gate: the shared probe must work on a REAL detection site, not just localhost.
//
// Every other test probes 127.0.0.1. That is necessary (mediaDevices/storage/
// getBattery are secure-origin gated) but it is not sufficient: the client
// exists to be checked against browserleaks.com and creepjs, and a probe that
// only works on localhost cannot answer "what does the site actually see?".
//
// This runs the real PROBE on a real https origin and verifies that configured
// values are reported there. It is the closest automated equivalent of a human
// opening the client, applying a profile, and reading the site.
//
// Two deliberate limits:
//   * Network-dependent. If the site is unreachable the test fails rather than
//     skipping - a silent skip is exactly the failure mode this suite has been
//     removing - but the message says so, so an offline run is diagnosable.
//   * Asserts a small, robust subset rather than all 47 fields. Surfaces like
//     mediaDevices depend on the host's hardware and are already covered
//     elsewhere; asserting them here would make this test flap on a machine
//     with no microphone, which is how a network test gets muted.
//
// Runs under Electron (see run-tests.js).

'use strict';

const { app, BrowserWindow, session } = require('electron');
const { PROBE, PROBE_FIELDS, compare } = require('./fp-probe');

let pass = 0, fail = 0, skip = 0;
function ck(name, cond, detail) {
  if (cond === null || cond === undefined) {
    skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return;
  }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const TARGET = 'https://abrahamjuliot.github.io/creepjs/';

// Chosen to be unambiguous against this host's real values, so a failure means
// "did not apply", never "coincidentally equal".
const CFG = {
  hardware_concurrency: 12,
  device_memory: 16,
  navigator_platform: 'MacIntel',
  navigator_vendor: 'Apple Computer, Inc.',
  navigator_languages: 'en-US,en',
  tz_id: 'America/New_York',
  screen_width: 1920,
  webgl_vendor: 'Apple Inc.',
  webgl_renderer: 'Apple GPU',
};
const KEYS = Object.keys(CFG);

// Electron QUITS when the last BrowserWindow closes; each measurement destroys
// its own, so without this the second one never runs.
let keepAlive = null;

async function measure(cfg) {
  const sess = session.fromPartition('rsite-' + Math.random().toString(36).slice(2));
  if (cfg) sess.setFingerprintConfig(cfg);
  const w = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  });
  let navErr = null;
  w.webContents.on('did-fail-load', (e, c, d) => { navErr = c + ' ' + d; });
  await w.loadURL(TARGET);
  // The site runs its own detection scripts on load; give it time so the page
  // is in the state a human would be looking at.
  await new Promise((r) => setTimeout(r, 8000));
  let out;
  try {
    const p = w.webContents.executeJavaScript(PROBE, true);
    const t = new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 30000));
    out = await Promise.race([p, t]);
  } finally { try { w.destroy(); } catch (_) { /* gone */ } }
  return { out, navErr };
}

app.whenReady().then(async () => {
  keepAlive = new BrowserWindow({ show: false, width: 80, height: 80 });
  let got = null, navErr = null;

  try {
    const r = await measure(CFG);
    got = r.out;
    navErr = r.navErr;
  } catch (e) {
    ck('the detection site is reachable', false,
      TARGET + ' - ' + String(e && e.message).slice(0, 120));
  }

  if (got) {
    ck('the detection site loaded without a navigation error', !navErr, navErr || 'clean');

    const returned = Object.keys(got).filter((k) => k !== '_probe_error');
    ck('the probe returns every field it can read on a real site',
      returned.length >= PROBE_FIELDS.length - 5,
      returned.length + ' of ' + PROBE_FIELDS.length);
    ck('the probe did not throw on a real site', !got._probe_error,
      String(got._probe_error));

    for (const k of KEYS) {
      ck(k + ' applies on a real site', compare(k, CFG[k], got[k]),
        'got ' + JSON.stringify(String(got[k])).slice(0, 40) +
        ', want ' + JSON.stringify(String(CFG[k])).slice(0, 40));
    }
  }

  console.log('');
  ck('run reached the end (did not die partway)', pass + fail + skip >= KEYS.length + 2,
    (pass + fail + skip) + ' checks executed');
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

setTimeout(() => { console.error('timeout'); app.exit(2); }, 240000);
