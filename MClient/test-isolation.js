#!/usr/bin/env node
// Verify Client's BrowserView fingerprint isolation via CDP
// Run: node Client/test-isolation.js
'use strict';

const { app, BrowserWindow, BrowserView } = require('electron');
const path = require('path');

const PROFILE_A = {
  hardware_concurrency: 4,
  device_memory: 8,
  screen_width: 1920,
  screen_height: 1080,
  tz_id: 'Asia/Tokyo',
  canvas_noise_seed: 11111,
  prefers_color_scheme: 'dark'
};

const PROFILE_B = {
  hardware_concurrency: 16,
  device_memory: 32,
  screen_width: 2560,
  screen_height: 1600,
  tz_id: 'Europe/Berlin',
  canvas_noise_seed: 99999,
  prefers_color_scheme: 'light'
};

const PROBE = `(async () => {
  const r = {};
  r.hardware_concurrency = navigator.hardwareConcurrency;
  r.screen_width = screen.width;
  r.screen_height = screen.height;
  r.tz_id = Intl.DateTimeFormat().resolvedOptions().timeZone;
  r.prefers_color_scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try {
      const c = document.createElement('canvas'); c.width = 100; c.height = 100;
      const x = c.getContext('2d');
      if (x) { x.font = '20px Arial'; r.measure_text = x.measureText('fp-test').width; }
      // Draw actual pixels before hashing the export. A blank canvas is fully
      // transparent, so noise over identical pixels yields a byte-identical
      // PNG and the two profiles compare equal even with different seeds.
      if (x) { x.fillStyle = '#3366cc'; x.fillRect(10, 10, 60, 60); }
      r.canvas_noise = c.toDataURL().length;
  } catch(e) {}
  return r;
})()`;

async function probe(view) {
  await view.webContents.loadURL('about:blank');
  await new Promise(r => setTimeout(r, 300));
  return view.webContents.executeJavaScript(PROBE, true);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });

  const viewA = new BrowserView({
    webPreferences: {
      partition: 'fp-client-test-a',
      fingerprint: PROFILE_A,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const viewB = new BrowserView({
    webPreferences: {
      partition: 'fp-client-test-b',
      fingerprint: PROFILE_B,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const [a, b] = await Promise.all([probe(viewA), probe(viewB)]);

  let pass = 0, fail = 0;
  const check = (key, expA, expB) => {
    const gotA = a[key], gotB = b[key];
    const okA = String(gotA) === String(expA);
    const okB = String(gotB) === String(expB);
    const diff = String(gotA) !== String(gotB);
    if (okA && okB && diff) {
      console.log(`PASS  ${key}: A=${gotA} B=${gotB}`);
      pass++;
    } else {
      console.log(`FAIL  ${key}: expected A=${expA} got ${gotA}, B=${expB} got ${gotB}`);
      fail++;
    }
  };

  check('hardware_concurrency', PROFILE_A.hardware_concurrency, PROFILE_B.hardware_concurrency);
  check('screen_width', PROFILE_A.screen_width, PROFILE_B.screen_width);
  check('screen_height', PROFILE_A.screen_height, PROFILE_B.screen_height);
  check('tz_id', PROFILE_A.tz_id, PROFILE_B.tz_id);
  check('prefers_color_scheme', PROFILE_A.prefers_color_scheme, PROFILE_B.prefers_color_scheme);

  // Canvas noise should differ (different seeds)
  if (a.canvas_noise !== b.canvas_noise) {
    console.log(`PASS  canvas_noise: A=${a.canvas_noise} B=${b.canvas_noise} (different seeds)`);
    pass++;
  } else {
    console.log(`FAIL  canvas_noise: same output with different seeds`);
    fail++;
  }

  console.log(`\nresult: ${pass} passed, ${fail} failed`);
  win.close();
  app.exit(fail > 0 ? 1 : 0);
});

setTimeout(() => { app.exit(2); }, 15000);
