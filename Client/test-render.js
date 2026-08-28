#!/usr/bin/env node
// Verify BrowserView rendering + fingerprint in Client setup
'use strict';

const { app, BrowserWindow, BrowserView } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { sandbox: false }
  });

  await win.loadFile(process.argv[2] || __dirname + '/renderer/index.html');
  await new Promise(r => setTimeout(r, 500));

  // Create a BrowserView with fingerprint and load a real page
  const view = new BrowserView({
    webPreferences: {
      partition: 'fp-render-test',
      fingerprint: {
        hardware_concurrency: 12,
        device_memory: 16,
        screen_width: 1920,
        screen_height: 1080,
        tz_id: 'Australia/Sydney',
        canvas_noise_seed: 42424,
        prefers_color_scheme: 'light'
      },
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 72, width: 1200, height: 800 - 72 });
  view.setAutoResize({ width: true, height: true });

  // Load a real webpage (or about:blank with injected content)
  await view.webContents.loadURL('data:text/html,<h1>FP Render Test</h1><p id=hc></p><script>document.getElementById("hc").textContent="HW=" + navigator.hardwareConcurrency + " TZ=" + Intl.DateTimeFormat().resolvedOptions().timeZone</script>');
  await new Promise(r => setTimeout(r, 800));

  // Check fingerprint is applied in the rendered view
  const result = await view.webContents.executeJavaScript(`(async()=>({
    hw: navigator.hardwareConcurrency,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    h1: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
    bodyText: document.body.innerText
  }))()`, true);

  console.log('BrowserView rendered:');
  console.log('  h1:', result.h1);
  console.log('  bodyText:', result.bodyText);
  console.log('  fingerprint hw:', result.hw, '(expected 12)');
  console.log('  fingerprint tz:', result.tz, '(expected Australia/Sydney)');

  const ok = result.h1 === 'FP Render Test' && result.hw === 12 && result.tz === 'Australia/Sydney';
  console.log(ok ? '\nPASS: BrowserView renders + fingerprint applied' : '\nFAIL: rendering or fingerprint issue');

  win.close();
  app.exit(ok ? 0 : 1);
});

setTimeout(() => { console.error('timeout'); app.exit(2); }, 20000);
