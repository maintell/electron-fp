'use strict';

// sdk-mini-browser: the smallest app that drives all three fingerprint planes.
// Order below mirrors MClient/main.js (createGroupView); do not reorder, each
// step carries the measured reason it must come where it does.

const { app, BrowserWindow, BrowserView, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fpSplitConfig, fpNormalizeUserAgent } = require('../../sdk/fp-schema.js');

// One partition = one identity. All planes below attach to this name, so a
// second, differently-profiled window would need a second partition name.
const PARTITION = 'persist:sdk-mini';

let mainWindow = null;
let view = null;

function loadProfile() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'profile.json'), 'utf-8'));
  // fpSplitConfig() is the ONLY thing allowed to separate the planes:
  // fpNormalizeConfig() would silently drop every TLS/H2 key (they are not in
  // FP_KEYS), losing the network planes while the config looks complete.
  const split = fpSplitConfig(raw.fingerprint || {});
  if (split.h2Error) console.error('[sdk] refused HTTP/2 config: ' + split.h2Error);
  if (split.unknown.length) console.warn('[sdk] dropped unknown keys: ' + split.unknown.join(', '));
  return {
    blink: split.fingerprint,
    tls: split.tls,
    h2: split.h2Error ? null : split.h2,
    // UA lives BESIDE the fingerprint object, never inside it: the kernel
    // does not know the key and fpNormalizeConfig() would drop it silently.
    // '' reverts to the native UA.
    userAgent: fpNormalizeUserAgent(raw.userAgent || ''),
  };
}

function createView(profile) {
  // 1. HTTP/2 rides on the FIRST fromPartition() for this name, and only there.
  // HttpNetworkSessionParams are read once at NetworkContext construction,
  // inside fromPartition(), before any Session method runs. Measured:
  //   fromPartition(p, {http2Profile}) -> GREASE=1
  //   fromPartition(p) then setHttp2Profile() -> GREASE=0 (silently ignored)
  const sess = Object.keys(profile.h2 || {}).length
    ? session.fromPartition(PARTITION, { http2Profile: profile.h2 })
    : session.fromPartition(PARTITION);

  // 2. UA BEFORE the view is constructed. Measured: setUserAgent() on an
  // already-open session does NOT reach existing views even after reload,
  // but a NEW view created afterwards on the same partition picks it up.
  sess.setUserAgent(profile.userAgent);

  // 3. TLS BEFORE the first request that would open a socket, or the first
  // handshake goes out with the native shape. Empty/null resets to native.
  if (profile.tls && Object.keys(profile.tls).length) sess.setSSLConfig(profile.tls);

  // 4. Blink keys travel as the `fingerprint` webPreference, injected via
  // --fingerprint-config at renderer startup. Changing them later requires
  // respawning the view (same partition, new BrowserView); setFingerprintConfig
  // alone does NOT take effect on a live renderer.
  view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION,
      ...(profile.blink ? { fingerprint: profile.blink } : {}),
    },
  });
  mainWindow.addBrowserView(view);
  layout();
  view.webContents.loadURL('https://example.com/');
}

function layout() {
  if (!mainWindow || mainWindow.isDestroyed() || !view) return;
  const [w, h] = mainWindow.getContentSize();
  view.setBounds({ x: 0, y: 60, width: w, height: h - 60 });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('resize', layout);
  mainWindow.on('closed', () => { mainWindow = null; view = null; });
  createView(loadProfile());
}

ipcMain.on('nav', (e, url) => {
  if (!view || typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  view.webContents.loadURL(url);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
