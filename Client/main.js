'use strict';

const { app, BrowserWindow, BrowserView, ipcMain, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
// Shared probe: the SAME PROBE / compare() that fingerprint/scripts/smoke.js
// uses. One probe, two callers - see Client/fp-probe.js.
const { PROBE, compare, verdicts } = require('./fp-probe');
const { captureClientHello, tlsVerdicts } = require('./tls-probe');
// TLS plane (session.setSSLConfig, not a kernel key). No comment inside the
// braces: test-app-copy-sync.js parses this destructure by splitting on commas
// and a commented line would be read as an export name that does not exist.
const { fpDefaultConfig, fpNormalizeConfig, fpCoverage, fpKeysInGroup, fpIsActive,
        FP_KEYS, FP_KEY_NAMES, FP_SCHEMA_VERSION, FP_GROUPS, FP_GROUP_IDS,
        FP_UA_PRESETS, fpRandomUserAgent, fpNormalizeUserAgent,
        FP_TLS_KEYS, FP_TLS_KEY_NAMES, FP_TLS_GROUPS,
        fpTlsIsActive, fpTlsCoerce, fpSplitConfig, fpTlsValidateCipherList,
        fpTlsValidateTypes,
        fpPlatformForUserAgent,
        fpVendorForUserAgent, fpPixelRatioForUserAgent,
        fpLanguagesForUserAgent } = require('./fp-schema');

// --- Profile Store ---
const PROFILES_PATH = path.join(__dirname, 'profiles.json');

function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8'));
  } catch {
    return { profiles: [{ id: 'default', name: 'Default', fingerprint: null, createdAt: new Date().toISOString() }] };
  }
}

function saveProfiles(data) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Tab Manager ---
/** @type {Map<string, {id: string, view: BrowserView, profileId: string, url: string, title: string}>} */
const tabs = new Map();
let activeTabId = null;
let mainWindow = null;
let tabIdCounter = 0;
let panelOpen = true; // fingerprint panel is a permanent sidebar — open by default
// Chrome heights and the panel width are defined in layout.js, shared with
// Client/test-panel.js. They must match the renderer's CSS - see the comments
// in renderer/style.css for the corresponding rules.
const { PANEL_WIDTH, TOP_HEIGHT, STATUS_HEIGHT, viewBounds } = require('./layout');

// Sites opened automatically at startup. These two are the references the
// fingerprint leak audit was validated against, and they are what an operator
// wants to see the moment the client starts.
const FP_AUDIT_SITES = [
  'https://browserleaks.com/',
  'https://abrahamjuliot.github.io/creepjs/'
];

function createTabId() {
  return `tab-${++tabIdCounter}`;
}

/**
 * Resize the active BrowserView to fill the content area (left column) which is
 * bounded by the top bar (72px), status bar (22px) and — when open — the
 * fingerprint panel (right 420px column). The panel is a normal DOM flex child;
 * the BrowserView is a native layer that must be explicitly sized to avoid
 * overlapping it, otherwise the panel would be hidden / uncatchable.
 */
function resizeActiveView() {
  if (activeTabId && mainWindow && !mainWindow.isDestroyed()) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      // Geometry lives in layout.js, shared with Client/test-panel.js. That
      // test used to carry its own copy and it had already drifted - it
      // dropped the STATUS_HEIGHT subtraction and renamed TOP_HEIGHT.
      const [width, height] = mainWindow.getContentSize();
      tab.view.setBounds(viewBounds(width, height, panelOpen));
    }
  }
}

/**
 * Apply a tab's User-Agent.
 *
 * IMPORTANT — this MUST be called before the tab's BrowserView is created.
 * Measured on Electron: session.setUserAgent() on an already-open session does
 * NOT reach existing views, even after a reload. A NEW view created on the same
 * partition afterwards does pick it up. Since both createTabView() and
 * recreateTabView() construct a fresh view, calling this first is what makes
 * the UA take effect.
 *
 * Passing '' reverts to the native UA (measured: setUserAgent('') falls back
 * to Chromium's own UA rather than sending a blank one).
 *
 * UA is per-partition, and every tab already owns a unique partition, so
 * per-tab UA isolation comes for free.
 */
function applyTabUserAgent(partition, userAgent) {
  try {
    session.fromPartition(partition).setUserAgent(
      typeof userAgent === 'string' ? userAgent.trim() : '');
  } catch (e) {
    console.warn('[fp] failed to set user agent: ' + e.message);
  }
}

/**
 * Apply the TLS/HTTP2 plane of a profile: session.setSSLConfig().
 *
 * This is a DIFFERENT delivery path from the 63 Blink keys. Those travel as a
 * `fingerprint` webPreference and are injected via --fingerprint-config at
 * renderer startup; these are read by the network service out of
 * net::SSLContextConfig, which 40-net-tls.patch plumbed from this API. They
 * never meet, which is why fp-schema keeps them in separate tables and
 * fpSplitConfig() is the only thing allowed to separate them.
 *
 * Ordering matters for the same reason it does for the UA: the config must be
 * on the session BEFORE the first request that would open a socket, or the
 * first handshake goes out with the native shape.
 *
 * Called with null/empty to reset a tab back to the native TLS shape.
 */
function applyTabTLSConfig(partition, tls) {
  const sess = session.fromPartition(partition);
  try {
    if (!tls || typeof tls !== 'object' || !Object.keys(tls).length) {
      return { ok: true };
    }
    // Type-check first. The kernel reads each key with options.Get(), which
    // returns false on a type mismatch and then SKIPS the key - no throw, no
    // log, native shape retained. Measured: fpGreaseEnabled:1 and
    // fpAdvertisedVersionMax:"771" both apply silently as no-ops. The u16list
    // keys do throw, but with a message naming neither key nor type.
    const types = fpTlsValidateTypes(tls);
    if (!types.ok) {
      console.error('[fp] refused TLS config: ' + types.error);
      return { ok: false, error: types.error };
    }

    // Reject the one measured foot-gun BEFORE it reaches the network service.
    // setSSLConfig() would accept it, and the session would then fail every
    // handshake with ERR_UNEXPECTED while the panel showed the profile applied.
    if (Object.prototype.hasOwnProperty.call(tls, 'fpCipherList')) {
      const v = fpTlsValidateCipherList(tls.fpCipherList);
      if (!v.ok) {
        console.error('[fp] refused TLS config: ' + v.error);
        return { ok: false, error: v.error };
      }
    }
    sess.setSSLConfig(tls);
    return { ok: true };
  } catch (e) {
    // Not warn-and-continue. A TLS key that fails to apply means the session
    // keeps the NATIVE ClientHello while the UI reports a configured profile -
    // the exact "claims a fingerprint it does not produce" failure the
    // 50-electron-glue patch calls out as the worst possible outcome.
    //
    // Pre-flight validation above should catch every type problem, so reaching
    // here means something else went wrong. Keep the message honest rather than
    // guessing at a cause: the native text is truncated at "conversion failure
    // from " and names neither the key nor the type, so anything we appended
    // would be a guess.
    console.error('[fp] failed to apply TLS config: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Create a BrowserView for a tab with the given fingerprint profile.
 * Each tab gets a unique partition for full cookie/storage isolation.
 */
function createTabView(tabId, profileId) {
  const profiles = loadProfiles();
  const profile = profiles.profiles.find(p => p.id === profileId) || profiles.profiles[0];
  const fp = profile.fingerprint; // null = no fingerprint (native)

  // Unique partition per tab for full cookie/session/storage isolation
  const partition = `fp-tab-${tabId}`;

  // UA must be set before the view is constructed — see applyTabUserAgent().
  applyTabUserAgent(partition, profile.userAgent);

  // Split the profile into its two delivery planes. This is the tab-CREATION
  // path and it must route exactly like the panel path: the Blink keys go to
  // --fingerprint-config, the 9 TLS keys go to session.setSSLConfig().
  // Passing the RAW profile as `fingerprint` silently loses the TLS plane -
  // the kernel ignores keys it does not know, so the tab kept Chromium's native
  // GREASE while the profile claimed Safari. Caught by driving the real UI: a
  // Safari-preset tab measured grease=3, identical to native, while applying
  // the same config through the panel correctly measured grease=0.
  const split = fp ? fpSplitConfig(fp) : null;
  const blinkFp = split ? split.fingerprint : null;
  const tls = split ? split.tls : null;
  if (tls && Object.keys(tls).length) applyTabTLSConfig(partition, tls);

  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition,
      // ponytail: fingerprint injection — null config = native (no spoof)
      ...(blinkFp ? { fingerprint: blinkFp } : {})
    }
  });

  // Forward renderer events to main window
  view.webContents.on('page-title-updated', (e, title) => {
    const tab = tabs.get(tabId);
    if (tab) {
      tab.title = title;
      mainWindow?.webContents.send('tab:title-updated', { tabId, title });
    }
  });

  view.webContents.on('did-navigate', (e, url) => {
    const tab = tabs.get(tabId);
    if (tab) {
      tab.url = url;
      mainWindow?.webContents.send('tab:navigated', { tabId, url });
    }
  });

  view.webContents.on('did-navigate-in-page', (e, url) => {
    const tab = tabs.get(tabId);
    if (tab) {
      tab.url = url;
      mainWindow?.webContents.send('tab:navigated', { tabId, url });
    }
  });

  return { view, profileId, profileName: profile.name, url: 'about:blank',
           title: 'New Tab', userAgent: profile.userAgent || '' };
}

/**
 * Recreate a tab's BrowserView with a new fingerprint config.
 * Reuses the SAME partition so cookies/storage persist; the renderer
 * process is respawned so the new --fingerprint-config takes effect.
 * Returns the new view.
 */
function recreateTabView(tabId, fingerprint, keepUrl, userAgent, tls) {
  const tab = tabs.get(tabId);
  if (!tab) return null;

  // Destroy old view + detach from window
  try { mainWindow?.removeBrowserView(tab.view); } catch {}
  try { tab.view.webContents.close(); } catch {}

  const partition = `fp-tab-${tabId}`;
  // UA must be set before the view is constructed – see applyTabUserAgent().
  applyTabUserAgent(partition, userAgent);
  // TLS likewise: the network service reads SSLContextConfig when it opens a
  // socket, so it must be on the session before the view's first request.
  // Persisted on the tab so the self-test and the UI can report what is live.
  tab.tls = tls || null;
  const tlsRes = applyTabTLSConfig(partition, tab.tls);
  // Recorded on the tab rather than returned, because recreateTabView() already
  // returns the view and changing that would touch every caller.
  tab.tlsRefused = tlsRes.ok ? null : (tlsRes.error || 'TLS config was refused');
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition,
      ...(fingerprint ? { fingerprint } : {})
    }
  });

  // Re-attach event forwarding
  view.webContents.on('page-title-updated', (e, title) => {
    const t = tabs.get(tabId);
    if (t) {
      t.title = title;
      mainWindow?.webContents.send('tab:title-updated', { tabId, title });
    }
  });
  view.webContents.on('did-navigate', (e, url) => {
    const t = tabs.get(tabId);
    if (t) {
      t.url = url;
      mainWindow?.webContents.send('tab:navigated', { tabId, url });
    }
  });
  view.webContents.on('did-navigate-in-page', (e, url) => {
    const t = tabs.get(tabId);
    if (t) {
      t.url = url;
      mainWindow?.webContents.send('tab:navigated', { tabId, url });
    }
  });

  tab.view = view;

  // Reload the page so the new renderer picks up the fingerprint
  const url = keepUrl || tab.url || 'about:blank';
  tab.url = url;
  view.webContents.loadURL(url);

  // Re-attach if active
  if (activeTabId === tabId && mainWindow && !mainWindow.isDestroyed()) {
    // Same shared geometry as resizeActiveView(). This site previously
    // hardcoded the panel-closed formula inline, so a change to the panel
    // width would have applied here and nowhere else.
    const [width, height] = mainWindow.getContentSize();
    view.setBounds(viewBounds(width, height, panelOpen));
    view.setAutoResize({ width: true, height: true });
    mainWindow.addBrowserView(view);
  }

  return view;
}

function addTab(profileId = 'default') {
  const tabId = createTabId();
  const { view, profileId: pid, profileName, url, title, userAgent } = createTabView(tabId, profileId);
  tabs.set(tabId, { id: tabId, view, profileId: pid, profileName, url, title, userAgent });

  mainWindow?.webContents.send('tab:created', { tabId, profileId: pid, profileName, url, title });
  activateTab(tabId);
  return tabId;
}

function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  try {
    mainWindow?.removeBrowserView(tab.view);
    tab.view.webContents.close();
  } catch { /* already destroyed */ }

  tabs.delete(tabId);
  mainWindow?.webContents.send('tab:closed', { tabId });

  // Activate another tab if this was active
  if (activeTabId === tabId) {
    activeTabId = null;
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1]);
    }
  }
}

function activateTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Remove all BrowserViews first
  try {
    for (const t of tabs.values()) {
      mainWindow?.removeBrowserView(t.view);
    }
  } catch { /* ok */ }

  // Add the active one
  activeTabId = tabId;
  if (mainWindow && !mainWindow.isDestroyed()) {
    resizeActiveView();
    tab.view.setAutoResize({ width: true, height: true });
    mainWindow.addBrowserView(tab.view);
  }

  mainWindow?.webContents.send('tab:activated', { tabId, profileId: tab.profileId, profileName: tab.profileName, url: tab.url, title: tab.title });
}

function navigateTab(tabId, url) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Ensure URL has protocol
  if (!url.match(/^https?:\/\//i) && !url.startsWith('about:') && !url.startsWith('file:')) {
    // Check if it looks like a URL (has dot and no spaces)
    if (url.includes('.') && !url.includes(' ')) {
      url = 'https://' + url;
    } else {
      // Treat as search query
      url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    }
  }

  tab.url = url;
  tab.view.webContents.loadURL(url);
}

// --- Chrome height: TOP_HEIGHT (tab bar 36 + address bar 36 = 72) / STATUS_HEIGHT (22) ---

// --- Main Window ---
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    title: 'Electron FP Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Resize active BrowserView on window resize (also shrink if panel open)
  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    resizeActiveView();
  });

  mainWindow.on('closed', () => {
    for (const tab of tabs.values()) {
      try { tab.view.webContents.close(); } catch {}
    }
    tabs.clear();
    mainWindow = null;
  });

  // Wait for UI to be ready before attaching BrowserView.
  //
  // Opens the two fingerprint-detection sites as the default tabs: this client
  // exists to be checked against them, so making the operator navigate there by
  // hand every launch is wasted work. Both are the references the leak audit
  // was run against.
  //
  // They are opened AFTER the first tab so the normal "New Tab" flow stays the
  // first thing that happens - addTab() also activates whatever it creates, so
  // opening the sites afterwards would steal focus from it. We therefore add
  // them and then hand focus back to tab 1.
  mainWindow.webContents.once('did-finish-load', () => {
    const first = addTab('default');
    for (const site of FP_AUDIT_SITES) {
      const id = addTab('default');
      if (id) navigateTab(id, site);
    }
    if (first) activateTab(first);
  });
}

// --- IPC Handlers ---
function setupIPC() {
  // Tab operations
  ipcMain.handle('tab:create', (e, profileId) => addTab(profileId || 'default'));
  ipcMain.handle('tab:close', (e, tabId) => closeTab(tabId));
  ipcMain.handle('tab:activate', (e, tabId) => activateTab(tabId));
  ipcMain.handle('tab:navigate', (e, { tabId, url }) => navigateTab(tabId, url));
  ipcMain.handle('tab:list', () => {
    const list = [];
    for (const [id, tab] of tabs) {
      list.push({ id, profileId: tab.profileId, profileName: tab.profileName, url: tab.url, title: tab.title, isActive: id === activeTabId });
    }
    return list;
  });
  ipcMain.handle('tab:get-active', () => activeTabId);

  // Tab fingerprint operations
  ipcMain.handle('tab:get-fingerprint', (e, tabId) => {
    const tab = tabs.get(tabId || activeTabId);
    if (!tab) return null;
    try {
      return tab.view.webContents.getFingerprintConfig();
    } catch { return null; }
  });
  ipcMain.handle('tab:set-fingerprint', (e, { tabId, config, userAgent }) => {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return false;
    try {
      // Split into the two delivery planes BEFORE normalizing: fpNormalizeConfig
      // drops every key absent from FP_KEYS, so running it on the whole blob
      // would silently discard all 9 TLS keys. fpSplitConfig() routes Blink
      // keys to --fingerprint-config and TLS keys to session.setSSLConfig().
      let apply = null;
      let tlsApply = null;
      if (config && typeof config === 'object') {
        const split = fpSplitConfig(config);
        apply = split.fingerprint;
        tlsApply = split.tls;
        if (split.unknown.length) {
          console.warn('[fp] dropped unknown keys: ' + split.unknown.join(', '));
        }
      }

      // UA travels beside the fingerprint, never inside it: fpNormalizeConfig()
      // would silently drop it, and it is an Electron-level surface rather than
      // one of the kernel's 63 keys. undefined means "leave the current UA
      // alone"; only an explicit value (including '') overrides it.
      const ua = (userAgent === undefined)
        ? tab.userAgent
        : fpNormalizeUserAgent(userAgent);
      tab.userAgent = ua;

      // Recreate the renderer (same partition) so the new fingerprint config
      // is injected via --fingerprint-config at renderer startup, the new
      // UA is picked up by the fresh view, and the TLS config is on the
      // session before that view's first socket.
      recreateTabView(tid, apply, tab.url || 'about:blank', ua, tlsApply);
      tab.profileId = config ? 'custom' : 'default';
      tab.profileName = config ? 'Custom' : 'Default';
      mainWindow?.webContents.send('tab:profile-changed', { tabId: tid, profileId: tab.profileId, profileName: tab.profileName });

      // Report a refused TLS plane instead of claiming success. A bare `true`
      // here would leave the UI showing an applied profile while the session
      // still emits the native ClientHello.
      if (tlsApply && Object.keys(tlsApply).length && tab.tlsRefused) {
        return { ok: true, tlsError: tab.tlsRefused };
      }
      return true;
    } catch { return false; }
  });

  // User-Agent is a client-level (Electron) surface, kept separate from the
  // kernel's 63-key fingerprint config. See applyTabUserAgent() for why the
  // order of operations matters.
  ipcMain.handle('tab:get-ua', (e, tabId) => {
    const tab = tabs.get(tabId || activeTabId);
    if (!tab) return null;
    try {
      return session.fromPartition(`fp-tab-${tab.id}`).getUserAgent() || '';
    } catch { return tab.userAgent || ''; }
  });

  ipcMain.handle('tab:set-ua', (e, { tabId, userAgent }) => {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return false;
    try {
      // Same partition as the tab, so cookies/storage survive the respawn.
      const ua = fpNormalizeUserAgent(userAgent);
      tab.userAgent = ua;
      // Preserve the live TLS config. Omitting it here would silently reset the
      // tab to the native ClientHello on every UA change, because
      // recreateTabView() applies whatever it is handed - and "not handed" is
      // indistinguishable from "deliberately cleared".
      recreateTabView(tid, tab.view.webContents.getFingerprintConfig?.(),
        tab.url || 'about:blank', ua, tab.tls || null);
      mainWindow?.webContents.send('tab:profile-changed', {
        tabId: tid, profileId: tab.profileId, profileName: tab.profileName
      });
      return true;
    } catch { return false; }
  });

  // Fingerprint panel open/close — shrink/expand the active BrowserView so the
  // panel (DOM layer) is not covered by the BrowserView (native top layer).
  ipcMain.handle('panel:set-open', (e, isOpen) => {
    panelOpen = !!isOpen;
    resizeActiveView();
    return true;
  });

  // Profile operations
  ipcMain.handle('profile:list', () => loadProfiles().profiles);
  ipcMain.handle('profile:get', (e, profileId) => {
    const data = loadProfiles();
    return data.profiles.find(p => p.id === profileId) || null;
  });
  ipcMain.handle('profile:create', (e, profile) => {
    const data = loadProfiles();
    const id = profile.id || `profile-${Date.now()}`;
    const newProfile = { ...profile, id, createdAt: new Date().toISOString() };
    data.profiles.push(newProfile);
    saveProfiles(data);
    return newProfile;
  });
  ipcMain.handle('profile:update', (e, profile) => {
    const data = loadProfiles();
    const idx = data.profiles.findIndex(p => p.id === profile.id);
    if (idx === -1) return null;
    data.profiles[idx] = { ...data.profiles[idx], ...profile };
    saveProfiles(data);
    return data.profiles[idx];
  });
  ipcMain.handle('profile:delete', (e, profileId) => {
    const data = loadProfiles();
    data.profiles = data.profiles.filter(p => p.id !== profileId);
    saveProfiles(data);
    return true;
  });
  ipcMain.handle('profile:randomize', () => {
    return generateRandomProfile();
  });

  // DevTools for active tab
  ipcMain.handle('tab:toggle-devtools', (e, tabId) => {
    const tab = tabs.get(tabId || activeTabId);
    if (!tab) return;
    if (tab.view.webContents.isDevToolsOpened()) {
      tab.view.webContents.closeDevTools();
    } else {
      tab.view.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // Get Electron/Chromium version info
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8
  }));
  // Fingerprint schema: lets the renderer build grouped sections and validate
  // the JSON editor against the exact kernel key set (63 keys / 15 groups).
  ipcMain.handle('ua:presets', () => FP_UA_PRESETS);

  // Derive navigator_platform from a UA string in the main process rather than
  // duplicating the mapping in the renderer. Two copies of this table would
  // drift, and a drifted platform silently contradicts the UA - exactly the
  // failure mode this whole surface exists to prevent.
  ipcMain.handle('ua:platform-for', (e, ua) => fpPlatformForUserAgent(ua));

  // The TLS plane is delivered as a SEPARATE group list rather than merged into
  // `keys`/`groups`. Merging would make it indistinguishable from the 63 Blink
  // keys, and the difference is not cosmetic: those go to --fingerprint-config,
  // these go to session.setSSLConfig(). The renderer renders both but must not
  // forget which is which, so the payload keeps them apart.
  ipcMain.handle('fp:schema', () => ({
    version: FP_SCHEMA_VERSION,
    keyCount: FP_KEY_NAMES.length,
    keys: FP_KEYS,
    groups: FP_GROUPS,
    defaults: fpDefaultConfig(),
    tls: {
      keyCount: FP_TLS_KEY_NAMES.length,
      keys: FP_TLS_KEYS,
      groups: FP_TLS_GROUPS,
    }
  }));
  ipcMain.handle('fp:coverage', (e, cfg) => fpCoverage(cfg || {}));

  // --- Self-test ---------------------------------------------------------
  //
  // Runs the shared probe (Client/fp-probe.js - the same one smoke.js uses)
  // INSIDE the live tab, then compares each surface against that tab's OWN
  // config rather than a fixed expected table.
  //
  // That difference is the whole point. smoke.js asks "did MY chosen values
  // apply?"; the panel asks "did YOUR chosen values apply?". So a key has four
  // possible verdicts, and only two of them are a failure:
  //
  //   pass  - configured, and the surface reports exactly what was configured
  //   fail  - configured, but the surface reports something else. This is the
  //           case the panel exists to catch: the knob looked set, the UI said
  //           "active", and the renderer quietly used something else - most
  //           often the real hardware value.
  //   skip  - not configured (nothing to check) or the probe cannot see it
  //   error - the probe itself threw
  //
  // An inactive key is skip, NOT fail: the panel judges only what the user
  // actually asked for, otherwise a default profile would show 63 red rows.
  ipcMain.handle('selftest:run', async (e, tabId) => {
    const tab = tabs.get(tabId || activeTabId);
    if (!tab || !tab.view) return { error: 'no active tab', rows: [] };

    // Read the config the tab is really running with. getFingerprintConfig()
    // returns the decoded object, so this is post-normalisation - what the
    // kernel received, not what the UI sent.
    let cfg = null;
    try { cfg = tab.view.webContents.getFingerprintConfig(); } catch (_) { cfg = null; }
    if (!cfg) cfg = {};

    const wc = tab.view.webContents;
    const priorUrl = (() => { try { return wc.getURL(); } catch (_) { return ''; } })();

    // The probe MUST run on a real http origin. about:blank is an opaque origin
    // where navigator.storage and navigator.mediaDevices are undefined, which
    // silently blinds 5 surfaces. If the tab is not already on a usable origin,
    // borrow one for the duration and put the tab back afterwards.
    const needsTempOrigin = !/^https?:/i.test(priorUrl);
    let srv = null, tempUrl = null;
    if (needsTempOrigin) {
      srv = http.createServer((q, s) => {
        s.writeHead(200, { 'Content-Type': 'text/html' });
        s.end('<!doctype html><html><body>fp-selftest</body></html>');
      });
      try {
        await new Promise((res, rej) => {
          srv.listen(0, '127.0.0.1', res);
          srv.once('error', rej);
        });
        tempUrl = 'http://127.0.0.1:' + srv.address().port + '/';
        await wc.loadURL(tempUrl);
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        try { srv.close(); } catch (_) {}
        return { error: 'probe origin unavailable: ' + (err && err.message), rows: [] };
      }
    }

    let observed = null, probeError = null;
    try {
      const p = wc.executeJavaScript(PROBE, true);
      const t = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('probe timeout after 15s')), 15000));
      observed = await Promise.race([p, t]);
    } catch (err) {
      probeError = String((err && err.message) || err);
    }

    // Put the tab back where it was before we borrowed it for the probe.
    if (needsTempOrigin) {
      try { srv.close(); } catch (_) {}
      if (priorUrl) {
        try { await wc.loadURL(priorUrl); } catch (_) { /* best effort */ }
      }
    }

    if (probeError) return { error: probeError, rows: [] };
    if (!observed || typeof observed !== 'object') {
      return { error: 'probe returned nothing', rows: [] };
    }
    if (observed._probe_error) {
      return { error: 'probe threw: ' + observed._probe_error, rows: [] };
    }

    // The decision table lives in fp-probe.js, shared with the tests. It used
    // to be duplicated here and in test-selftest.js, and the copies had already
    // drifted (this one carried the explainMismatch hints, the test's did not),
    // so a test could stay green against behaviour that was not shipping.
    const { rows, summary } = verdicts(cfg, observed, {
      isActive: fpIsActive,
      explain: explainMismatch,
    });

    // --- TLS plane: measured in the MAIN process, not in the page ----------
    // The ClientHello never reaches page JS, so the 9 TLS keys are invisible to
    // PROBE and were absent from the panel entirely. tls-probe.js captures the
    // real handshake off a loopback socket driven by this tab's own session.
    const tlsCfg = tab.tls || {};
    const hasTls = Object.keys(tlsCfg).some((k) => fpTlsIsActive(k, tlsCfg[k]));
    let tlsRows = [], tlsSummary = null, tlsError = null;
    if (hasTls) {
      try {
        const sess = session.fromPartition(`fp-tab-${tab.id}`);
        // A baseline capture (native shape) is needed to judge the keys whose
        // effect is only "the offered set changed" - cipher list, max version,
        // permute, sigalgs. It runs in a throwaway partition configured with
        // nothing, so it is the platform's own default ClientHello.
        const baseSess = session.fromPartition('fp-tls-baseline-' + Date.now());
        const baseCap = await captureClientHello(baseSess, 3500);
        const cap = await captureClientHello(sess, 3500);
        if (!cap.ok) {
          tlsError = cap.error || 'could not capture a ClientHello';
        } else {
          const tv = tlsVerdicts(tlsCfg, cap.hello,
            baseCap.ok ? baseCap.hello : null, fpTlsIsActive);
          tlsRows = tv.rows;
          tlsSummary = tv.summary;
          if (!baseCap.ok) {
            // Verdicts that needed a baseline are already 'unknown'; say why.
            for (const r of tlsRows) {
              if (r.verdict === 'unknown' && /baseline/.test(r.reason || '')) {
                r.reason = 'baseline capture failed (' + (baseCap.error || 'unknown') + ')';
              }
            }
          }
        }
      } catch (err) {
        tlsError = String((err && err.message) || err);
      }
    }

    return {
      rows, summary,
      tlsRows, tlsSummary, tlsError,
      url: needsTempOrigin ? '(temporary probe origin)' : priorUrl,
    };
  });
}

// Human-readable explanations for the failure modes this panel is meant to
// surface. Each one is a mistake that was actually made and measured - these
// are not speculative hints.
function explainMismatch(key, expected, got) {
  if (key === 'webgl_max_viewport_dims') {
    return 'Expected ' + expected + ' expanded to "' + expected + ',' + expected +
      '". A quoted value (e.g. "' + expected + '") is rejected by the kernel and ' +
      'silently falls back to the real hardware value.';
  }
  if (key === 'webgpu_limits') {
    return 'Must be a brace-wrapped, quote-free object, e.g. {k:v}. A JSON value ' +
      'containing quotes is truncated at the first quote and applies nothing.';
  }
  if (key === 'audio_data_strength') {
    return 'Must be passed as a STRING. A number is serialised unquoted, which ' +
      'FpConfigString cannot read, so the 0.0005 default is used instead.';
  }
  if (/^(webgl_max_texture_size|webgl_max_renderbuffer_size|hardware_concurrency|device_memory|max_touch_points|screen_|net_rtt_ms|storage_|audio_sample_rate|audio_max_channels|perf_now_precision_ms)/.test(key)) {
    return 'Numeric keys must be unquoted. A quoted value is rejected and the ' +
      'surface falls back to the real hardware value.';
  }
  if (key === 'webgpu_device' || key === 'webgpu_description') {
    return 'These surfaces are only exposed when WebGPUDeveloperFeatures is on ' +
      '(--enable-blink-features=WebGPUDeveloperFeatures); otherwise they read as empty.';
  }
  return 'Configured ' + expected + ' but the surface reports ' + got +
    '. The key is active yet did not take effect.';
}

// --- Random Profile Generator ---
//
// Generates a config covering ALL 60 kernel keys, grouped so that related
// surfaces agree with each other. Cross-group consistency matters: a GPU vendor
// that differs between WebGL and WebGPU, or a mobile screen with desktop touch
// points, is itself a detection signal (constraint C17).
function generateRandomProfile() {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randSeed = () => randInt(10000, 99999);
  const maybe = (p, v) => (Math.random() < p ? v : '');

  // Platform archetypes. Each carries a coherent GPU identity reused by BOTH
  // webgl_* and webgpu_* so the two APIs never disagree.
  const platforms = [
    {
      id: 'win',
      hw: [4, 6, 8, 12, 16], mem: [4, 8, 16], touch: 0,
      screens: [[1920, 1080], [2560, 1440], [1366, 768], [1600, 900], [3840, 2160]],
      depth: [24, 30, 32],
      gpu: [
        { v: 'Google Inc. (NVIDIA)', r: 'ANGLE (NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)', arch: 'ampere', dev: 'NVIDIA GeForce RTX 4090' },
        { v: 'Google Inc. (AMD)', r: 'ANGLE (AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0)', arch: 'rdna3', dev: 'AMD Radeon RX 7900 XTX' },
        { v: 'Google Inc. (Intel)', r: 'ANGLE (Intel UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0)', arch: 'xe', dev: 'Intel UHD Graphics 770' }
      ],
      exts: 'EXT_texture_filter_anisotropic,WEBKIT_EXT_texture_filter_anisotropic,OES_texture_float_linear',
      maxTex: [8192, 16384],
      speechLang: 'en-US', voices: [4, 6, 8],
      // Must agree with the UA: a Chrome-on-Windows UA beside vendor
      // "Apple Computer, Inc." is the contradiction creepjs flags first.
      vendor: 'Google Inc.',
      langs: ['en-US,en', 'en-US,en,es', 'en-GB,en', 'de-DE,de,en'],
      dpr: [1, 1, 2],
      tzs: ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo'],
      battery: true
    },
    {
      id: 'mac',
      hw: [8, 10, 12], mem: [8, 16, 32], touch: 0,
      screens: [[2560, 1600], [3440, 1440], [2880, 1800]],
      depth: [30],
      gpu: [
        { v: 'Apple', r: 'Apple M3 Pro', arch: 'metal', dev: 'Apple M3 Pro' },
        { v: 'Apple', r: 'Apple M3 Max', arch: 'metal', dev: 'Apple M3 Max' },
        { v: 'Apple', r: 'Apple M2 Pro', arch: 'metal', dev: 'Apple M2 Pro' }
      ],
      exts: 'EXT_texture_filter_anisotropic,WEBKIT_EXT_texture_filter_anisotropic',
      maxTex: [16384],
      speechLang: 'en-GB', voices: [5, 7],
      // A Mac UA MUST report Apple here - Safari/Chrome on macOS both do.
      vendor: 'Apple Computer, Inc.',
      langs: ['en-GB,en', 'en-US,en', 'en-GB,en,fr', 'ja-JP,ja,en'],
      // Macs are Retina; 1 would contradict the screen sizes above.
      dpr: [2],
      tzs: ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'],
      battery: true
    },
    {
      id: 'linux',
      hw: [4, 6, 8], mem: [4, 8], touch: 0,
      screens: [[1920, 1080], [1366, 768], [1600, 900]],
      depth: [24, 30],
      gpu: [
        { v: 'Mesa', r: 'llvmpipe (LLVM 15.0.7, 256 bits)', arch: 'llvmpipe', dev: 'llvmpipe' },
        { v: 'Intel Open Source Technology Center', r: 'Mesa Intel(R) UHD Graphics 630', arch: 'gen9', dev: 'Intel UHD Graphics 630' }
      ],
      exts: 'EXT_texture_filter_anisotropic,OES_texture_float_linear',
      maxTex: [8192, 16384],
      speechLang: 'en-US', voices: [3, 5],
      vendor: 'Google Inc.',
      langs: ['en-US,en', 'de-DE,de,en', 'fr-FR,fr,en', 'en-GB,en'],
      dpr: [1, 1, 2],
      tzs: ['Europe/Berlin', 'Europe/Paris', 'Asia/Kolkata'],
      battery: true
    },
    {
      id: 'android',
      hw: [6, 8], mem: [4, 6], touch: 5,
      screens: [[412, 915], [360, 800], [393, 873]],
      depth: [24, 32],
      gpu: [
        { v: 'Qualcomm', r: 'Adreno (TM) 730', arch: 'adreno', dev: 'Adreno 730' },
        { v: 'ARM', r: 'Mali-G78 MP14', arch: 'mali', dev: 'Mali-G78' }
      ],
      exts: 'EXT_texture_filter_anisotropic,OES_texture_float_linear',
      maxTex: [4096, 8192],
      speechLang: 'en-US', voices: [2, 3],
      vendor: 'Google Inc.',
      langs: ['en-US,en', 'zh-CN,zh,en', 'ja-JP,ja,en', 'en-GB,en'],
      // Phones are always >1; 1 here would contradict the mobile UA and the
      // small screen sizes. These are the real ratios such devices report.
      dpr: [2.75, 3, 4],
      tzs: ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London'],
      battery: true
    }
  ];

  const p = pick(platforms);
  const hw = pick(p.hw);
  const mem = pick(p.mem);
  const [sw, sh] = pick(p.screens);
  const availH = sh - (sw > 1000 ? 40 : 32);
  const gpu = pick(p.gpu);
  const tz = pick(p.tzs);
  const maxTex = pick(p.maxTex);
  const isMobile = p.id === 'android';

  // Geo consistent with the chosen timezone (approximate city centers) so the
  // timezone and the reported coordinates never contradict each other.
  const geo = {
    'America/New_York': ['40.7128', '-74.0060'],
    'America/Chicago': ['41.8781', '-87.6298'],
    'America/Los_Angeles': ['34.0522', '-118.2437'],
    'Europe/London': ['51.5074', '-0.1278'],
    'Europe/Berlin': ['52.5200', '13.4050'],
    'Europe/Paris': ['48.8566', '2.3522'],
    'Asia/Tokyo': ['35.6762', '139.6503'],
    'Asia/Shanghai': ['31.2304', '121.4737'],
    'Asia/Kolkata': ['19.0760', '72.8777']
  }[tz] || ['0', '0'];

  // Build via the canonical schema so the randomizer can never drift out of
  // sync with the kernel key set.
  const fp = fpDefaultConfig();

  // --- Hardware ---
  fp.hardware_concurrency = hw;
  fp.device_memory = mem;
  fp.max_touch_points = isMobile ? p.touch : 0;

  // --- Screen ---
  fp.screen_width = sw;
  fp.screen_height = sh;
  fp.screen_avail_width = sw;
  fp.screen_avail_height = availH;
  fp.screen_color_depth = pick(p.depth);

  // --- Audio ---
  fp.audio_sample_rate = pick([44100, 48000]);
  fp.audio_max_channels = pick([2, 2, 6, 8]);
  fp.audio_output_latency_ms = pick([10, 20, 40, 50]);
  fp.audio_data_seed = randSeed();
  fp.audio_data_strength = String(pick([0.0002, 0.0005, 0.0008]));

  // --- WebGL ---
  fp.webgl_max_texture_size = maxTex;
  fp.webgl_max_renderbuffer_size = maxTex;
  fp.webgl_max_viewport_dims = maxTex;
  fp.webgl_aliased_point_size_range = '1,255';
  fp.webgl_aliased_line_width_range = '1,1';
  fp.webgl_vendor = gpu.v;
  fp.webgl_renderer = gpu.r;
  fp.webgl_extensions = maybe(0.7, p.exts);
  fp.webgl_shader_precision_highp = maybe(0.6, '23,23,23');

  // --- WebGPU (mirrors webgl_* on purpose) ---
  fp.webgpu_vendor = gpu.v;
  fp.webgpu_architecture = gpu.arch;
  fp.webgpu_device = gpu.dev;
  fp.webgpu_description = gpu.r;

  // webgpu_features is REPLACE: the configured list becomes the adapter's
  // entire feature set. The kernel drops any name outside the real
  // GPUFeatureName enum, so an invented name buys nothing and is itself a
  // detection signal. These are the names this adapter can actually expose.
  const WEBGPU_FEATURE_NAMES = [
    'bgra8unorm-storage', 'clip-distances', 'core-features-and-limits',
    'depth-clip-control', 'depth32float-stencil8', 'dual-source-blending',
    'float32-blendable', 'float32-filterable', 'indirect-first-instance',
    'primitive-index', 'rg11b10ufloat-renderable', 'shader-f16',
    'texture-component-swizzle', 'texture-compression-bc',
    'texture-compression-bc-sliced-3d', 'texture-formats-tier1',
    'texture-formats-tier2', 'timestamp-query'
  ];

  // webgpu_limits is MERGE, and is bounded on BOTH sides:
  //   ceiling = the native adapter value. Over-reporting makes Dawn reject
  //             device creation, which breaks WebGPU outright.
  //   floor   = max(WebGPU spec default, native/2). A page that requests
  //             nothing still gets the spec defaults, so dropping below them
  //             breaks device creation too; the native/2 term keeps each
  //             downgrade modest so pages asking for above-default limits
  //             keep working.
  // Values below are [specDefault, nativeCeiling]. Alignment fields
  // (min*OffsetAlignment) are power-of-two invariants and are deliberately
  // absent; keys whose default already equals native are omitted as no-ops.
  const WEBGPU_LIMIT_RANGE = {
    maxTextureDimension1D: [8192, 16384],
    maxTextureDimension2D: [8192, 16384],
    maxTextureArrayLayers: [256, 2048],
    maxDynamicUniformBuffersPerPipelineLayout: [8, 10],
    maxDynamicStorageBuffersPerPipelineLayout: [4, 8],
    maxSampledTexturesPerShaderStage: [16, 48],
    maxStorageBuffersPerShaderStage: [8, 16],
    maxStorageTexturesPerShaderStage: [4, 8],
    maxStorageBufferBindingSize: [134217728, 2147483644],
    maxBufferSize: [268435456, 2147483648],
    maxVertexAttributes: [16, 30],
    maxInterStageShaderVariables: [16, 28],
    maxColorAttachmentBytesPerSample: [32, 128],
    maxComputeWorkgroupStorageSize: [16384, 32768],
    maxComputeInvocationsPerWorkgroup: [256, 1024],
    maxComputeWorkgroupSizeX: [256, 1024],
    maxComputeWorkgroupSizeY: [256, 1024],
    maxImmediateSize: [0, 64]
  };

  // Real adapter limits are almost always powers of two (or a power of two
  // minus a small delta). Draw from those inside the window, plus the exact
  // native value, so the result reads as hardware rather than as noise.
  const plausibleLimit = (floor, ceil) => {
    const cands = [];
    for (let e = 0; e <= 34; e++) {
      const v = Math.pow(2, e);
      if (v >= floor && v <= ceil) cands.push(v);
    }
    if (cands.indexOf(ceil) === -1) cands.push(ceil);
    return pick(cands);
  };

  // A random subset of the real names. 9..16 keeps it plausible: an adapter
  // exposing every feature, or almost none, looks synthetic.
  {
    const pool = WEBGPU_FEATURE_NAMES.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const want = randInt(9, 16);
    // Shuffle core-features-and-limits to the front first so forcing it in
    // can never push the final count past |want|.
    const ci = pool.indexOf('core-features-and-limits');
    pool.splice(ci, 1);
    pool.unshift('core-features-and-limits');
    fp.webgpu_features = pool.slice(0, want).join(',');
  }

  // Vary a few limits, each landing inside its own window.
  {
    const pool = Object.keys(WEBGPU_LIMIT_RANGE);
    const n = Math.min(randInt(3, 6), pool.length);
    const chosen = [];
    while (chosen.length < n) {
      chosen.push(pool.splice(randInt(0, pool.length - 1), 1)[0]);
    }
    // Keys are deliberately UNQUOTED. FpConfigString() reads the value as a
    // JSON string and terminates at the first closing quote, so a value like
    // {"maxBindGroups":4} is truncated to "{" and every key is silently
    // dropped. The kernel's brace-parser does not require the quotes, so
    // {maxBindGroups:4} is the format that actually survives the round trip.
    fp.webgpu_limits = '{' + chosen.map(function (k) {
      const r = WEBGPU_LIMIT_RANGE[k];
      return k + ':' +
        plausibleLimit(Math.max(r[0], Math.ceil(r[1] / 2)), r[1]);
    }).join(',') + '}';
  }

  // --- Geolocation ---
  fp.geo_latitude = maybe(0.8, geo[0]);
  fp.geo_longitude = maybe(0.8, geo[1]);
  fp.geo_accuracy = maybe(0.8, String(pick([10, 25, 50, 100])));

  // --- Speech ---
  fp.speech_voices_count = pick(p.voices);
  fp.speech_voices_lang = p.speechLang;

  // --- Media devices ---
  fp.media_devices_audio_input = pick([0, 1, 2]);
  fp.media_devices_video_input = pick([0, 1, 1]);
  fp.media_devices_audio_output = pick([0, 1, 2]);
  fp.media_codecs_denylist = maybe(0.25, 'vp09,av01');

  // --- Canvas / text / rects ---
  fp.canvas_noise_seed = randSeed();
  fp.canvas_noise_strength = pick([1, 2, 3]);
  fp.measure_text_seed = randInt(1, 999999);
  fp.client_rects_seed = randSeed();

  // --- Locale & privacy ---
  fp.tz_id = tz;
  fp.prefers_color_scheme = pick(['light', 'dark']);
  fp.do_not_track = pick(['1', '1', '0']);

  // --- Network ---
  // net_* and webrtc_ip must tell ONE consistent story. A mobile radio type
  // (3g/4g) must not be reported alongside a datacentre IP, and a residential
  // IP must not claim a datacentre-grade downlink. So pick the network class
  // first and let it drive rtt, downlink and the IP block together.
  const netClass = pick(['4g', '4g', '4g', '3g', 'broadband', 'broadband']);

  // Ranges are deliberately wide and overlapping: a fingerprint test comparing
  // rtt against the class sees an ordinary value, not a tell-tale exact match.
  let rttRange, downPool, ipPool;
  if (netClass === '3g') {
    fp.net_effective_type = '3g';
    rttRange = [120, 400];
    downPool = [0.5, 1, 2, 3];
    // Mobile carriers: RFC 6598 shared space and common carrier NAT pools
    // are what a real phone handset is seen as on a 3g radio.
    ipPool = ['100.64', '100.96', '100.100', '10.200'];
  } else if (netClass === '4g') {
    fp.net_effective_type = '4g';
    rttRange = [40, 180];
    downPool = [5, 10, 20, 30];
    ipPool = ['100.64', '100.96', '100.100', '10.200'];
  } else {
    fp.net_effective_type = '4g';  // navigator.connection has no "broadband"
    rttRange = [10, 60];
    downPool = [50, 100, 200, 300, 500];
    // Residential-looking broadband. These sit inside documented DOCSIS/DSL
    // ISP ranges. They are NOT validated as reachable: the goal is a value
    // consistent with the rest of the profile, not a live endpoint.
    ipPool = ['24.90', '67.160', '71.192', '73.44', '98.192', '174.64'];
  }

  fp.net_rtt_ms = randInt(rttRange[0], rttRange[1]);
  fp.net_downlink_mbps = String(pick(downPool));

  // webrtc_ip overrides the ICE host candidate. It must look like it belongs
  // to the network class above, so draw from the chosen /16 block and avoid
  // the reserved ends (.0 network, .255 broadcast) plus the router's usual .1.
  fp.webrtc_ip = pick(ipPool) + '.' + randInt(1, 254) + '.' + randInt(2, 254);

  // --- Storage & perf ---
  fp.permissions_status = pick(['granted', 'prompt']);
  fp.storage_usage_bytes = randInt(524288, 8388608);
  fp.storage_quota_bytes = pick([1073741824, 5368709120, 10737418240, 21474836480]);
  fp.perf_now_precision_ms = pick([0, 0, 100, 200]);

  // --- Fonts ---
  // Hide a few fonts, but with restraint. The kernel hides a family from
  // BOTH FontCache and FontFaceSet.check(), so every name here vanishes from
  // the usual enumeration probes. Hiding many - or hiding fonts that the
  // platform always has - is itself a signal, so this picks 1..3 obscure
  // faces and keeps them consistent with the platform archetype.
  {
    const obscureByPlatform = {
      win: ['Estrangelo Edessa', 'MingLiU-ExtB', 'MS Outlook', 'Marlett'],
      mac: ['Kohinoor Telugu', 'Luminari', 'Noto Nastaliq Urdu', 'Zapfino'],
      linux: ['URW Chancery L', 'Z003', 'Kinnari', 'Loma'],
      android: ['Noto Naskh Arabic UI', 'Noto Serif CJK SC', 'Droid Sans Hebrew']
    };
    const pool = (obscureByPlatform[p.id] || []).slice();
    const n = Math.min(pool.length, randInt(1, 3));
    const chosen = [];
    while (chosen.length < n) {
      chosen.push(pool.splice(randInt(0, pool.length - 1), 1)[0]);
    }
    fp.fonts_blocklist = chosen.join(',');
  }
  // Whitelist wins over blocklist in the kernel, so setting both would make
  // fonts_blocklist dead weight. Leave whitelist empty and let blocklist act.
  fp.fonts_whitelist = '';

  // --- Battery ---
  fp.battery_charging = maybe(0.7, pick(['true', 'false']));
  fp.battery_level = maybe(0.7, String(pick([0.42, 0.67, 0.85, 1.0])));

  // Independent of the platform archetype above, by deliberate choice: the
  // user asked for the UA to be drawn from its own pool rather than matched
  // to p.id. The tradeoff is real and is surfaced in the UI: a profile can
  // therefore carry a Mac screen with a Windows UA, which is a cross-group
  // inconsistency. It is left visible on purpose instead of being papered
  // over, so the operator can decide per profile.
  const ua = fpRandomUserAgent();

  // navigator_platform follows the UA so the pair stays coherent. The kernel
  // does NOT enforce this - it is an application-layer policy, applied here.
  fp.navigator_platform = fpPlatformForUserAgent(ua);

  // --- Sec-CH-UA client hints (keys 58-60) ---
  // Left EMPTY so the kernel derives them from the UA actually in effect. That
  // is the default behaviour and it keeps navigator.userAgentData consistent
  // with navigator.userAgent without the operator having to maintain two
  // copies of the same fact.
  //
  // They are nonetheless full first-class keys and are set explicitly here
  // (to their empty default) so the generator covers all 60: a key the
  // generator never mentions cannot be exercised, and coverage is asserted by
  // test-random.js. An operator who WANTS a specific hint overrides these in
  // the JSON editor - the kernel honours any non-empty value verbatim, with no
  // reference to the UA:
  //     ua_platform: "Plan9", ua_mobile: "true", ua_brands: "AcmeBrowser=42"
  // measured working with NO userAgent set at all.
  //
  // ua_brands must be the QUOTE-FREE config form (Brand=99,Brand2=131). The
  // wire form ("Brand";v="99") does not survive: FpConfigString() terminates
  // at the first quote, so the quoted form parses to a single garbage entry.
  fp.ua_platform = '';
  fp.ua_mobile = '';
  fp.ua_brands = '';

  // --- Keys 61-63: the surfaces that leaked the host in the external audit ---
  // Found by diffing browserleaks.com / creepjs output between a baseline and a
  // spoofed run: with every one of the original 63 keys set, navigator.vendor,
  // navigator.language/languages and window.devicePixelRatio all still reported
  // the host's real values, each contradicting the UA.
  //
  // These are derived FROM THE UA, not from the archetype. The archetype and
  // the UA are drawn from independent pools (see above), so taking vendor from
  // the archetype produced "iPhone UA + Google Inc." in about half of all
  // random profiles - measured 5 of 10. That is the contradiction detection
  // sites flag first, so for these three the UA is the authority.
  //
  // An explicit operator override in the JSON editor still wins verbatim; this
  // only supplies the generated default.
  fp.navigator_vendor = fpVendorForUserAgent(ua) || p.vendor;
  fp.navigator_languages = fpLanguagesForUserAgent(ua) || pick(p.langs);
  fp.device_pixel_ratio = fpPixelRatioForUserAgent(ua) || String(pick(p.dpr));

  // --- TLS plane ---------------------------------------------------------
  // Derived from the UA, not picked at random, for the same reason the block
  // above is: an incoherent pair is itself a detection signal. A Safari UA
  // speaking a GREASEd Chromium ClientHello announces the lie on the one layer
  // the page cannot see but the server always can.
  //
  // Only keys with a measured, stable effect are set:
  //   * fpGreaseEnabled - the clean browser-family signal. Chromium GREASEs
  //     (RFC 8701), WebKit and NSS do not. Verified stable 6/6 either way.
  //   * fpAdvertisedVersionMax - 771 is the ONLY way to drop the TLS 1.3
  //     suites; fpCipherList cannot remove 1301/1302/1303 (measured).
  //   * fpOmitAlpn / fpOmitSessionTicket - real extension removals, varied so
  //     a random profile is not a fixed JA3.
  // The remaining 4 keys (fpCipherList, fpExtensionOrder,
  // fpSignatureAlgorithms, fpPermuteExtensions) are left unset: they change the
  // hello but do not correspond to a named browser shape, so setting them
  // would be randomisation pretending to be fidelity.
  const isWebKit = /AppleWebKit\/6|Version\/\d+.*Safari/.test(ua) &&
    !/Chrome|Chromium|Edg|OPR/.test(ua);
  const isFirefox = /Firefox\//.test(ua) && !/Seamonkey|Iceweasel/.test(ua);
  if (isWebKit || isFirefox) {
    fp.fpGreaseEnabled = false;
    fp.fpGreaseSigalgsEnabled = false;
  } else {
    // Chromium family (including the many Chromium-derived UAs).
    fp.fpGreaseEnabled = true;
    fp.fpGreaseSigalgsEnabled = true;
  }
  if (isFirefox) {
    fp.fpAdvertisedVersionMax = 771;   // drops the TLS 1.3 suites
  }
  fp.fpOmitAlpn = maybe(0.25, true) || false;
  fp.fpOmitSessionTicket = maybe(0.25, true) || false;

  return {
    id: `random-${Date.now()}`,
    name: `Random ${sw}x${sh} / ${tz.split('/')[1]}`,
    fingerprint: fp,
    userAgent: ua,
    createdAt: new Date().toISOString()
  };
}
// --- App Lifecycle ---
app.whenReady().then(() => {
  setupIPC();
  createMainWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});
