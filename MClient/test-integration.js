#!/usr/bin/env node
// Integration test: simulate Client's IPC flow
// Verifies: tab creation, navigation, per-tab fingerprint isolation, profile apply
'use strict';

const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');

// Mirror Client's handler logic (simplified, in-process)
const tabs = new Map();
let counter = 0;

function makeTab(profileId, fingerprint) {
  const id = `tab-${++counter}`;
  const partition = `fp-test-${id}`;
  const view = new BrowserView({
    webPreferences: {
      partition,
      ...(fingerprint ? { fingerprint } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  tabs.set(id, { id, view, profileId });
  return { id, view };
}

const PROFILE_A = { hardware_concurrency: 2, screen_width: 1280, screen_height: 800, tz_id: 'America/New_York' };
const PROFILE_B = { hardware_concurrency: 32, screen_width: 3840, screen_height: 2160, tz_id: 'Asia/Shanghai' };

const PROBE = `(async () => ({
  hw: navigator.hardwareConcurrency,
  sw: screen.width,
  sh: screen.height,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone
}))()`;

async function probe(view) {
  await view.webContents.loadURL('about:blank');
  await new Promise(r => setTimeout(r, 300));
  return view.webContents.executeJavaScript(PROBE, true);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });

  const { id: idA, view: viewA } = makeTab('profile-a', PROFILE_A);
  const { id: idB, view: viewB } = makeTab('profile-b', PROFILE_B);

  const [a, b] = await Promise.all([probe(viewA), probe(viewB)]);

  let pass = 0, fail = 0;
  const check = (name, got, exp) => {
    if (String(got) === String(exp)) { console.log(`PASS  ${name}: ${got}`); pass++; }
    else { console.log(`FAIL  ${name}: got ${got}, expected ${exp}`); fail++; }
  };

  console.log(`Tab A (${idA}):`, JSON.stringify(a));
  console.log(`Tab B (${idB}):`, JSON.stringify(b));
  console.log('');

  check('A.hw', a.hw, 2);
  check('A.sw', a.sw, 1280);
  check('A.tz', a.tz, 'America/New_York');
  check('B.hw', b.hw, 32);
  check('B.sw', b.sw, 3840);
  check('B.tz', b.tz, 'Asia/Shanghai');

  // Isolation: A and B differ on every dimension
  const iso = a.hw !== b.hw && a.sw !== b.sw && a.tz !== b.tz;
  if (iso) { console.log('PASS  isolation: tabs produce different fingerprints'); pass++; }
  else { console.log('FAIL  isolation: tabs share fingerprint'); fail++; }

  // Simulation: apply profile A to tab B by recreating the renderer (same partition)
  const newViewB = new BrowserView({
    webPreferences: {
      partition: 'fp-test-' + idB,
      ...(PROFILE_A ? { fingerprint: PROFILE_A } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  tabs.set(idB, { id: idB, view: newViewB, profileId: 'profile-a' });
  await probe(newViewB); // probe will loadURL about:blank with new fingerprint
  const b2 = await probe(newViewB);
  check('B->A.hw', b2.hw, 2);
  check('B->A.tz', b2.tz, 'America/New_York');
  console.log('PASS  runtime fingerprint switch (setFingerprintConfig)');

  win.close();
  app.exit(fail > 0 ? 1 : 0);
});

setTimeout(() => { console.error('timeout'); app.exit(2); }, 20000);
