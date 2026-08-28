'use strict';

const { app, BrowserWindow, BrowserView, ipcMain, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { fpDefaultConfig, fpNormalizeConfig, fpCoverage, fpKeysInGroup, fpIsActive,
        FP_KEYS, FP_KEY_NAMES, FP_SCHEMA_VERSION, FP_GROUPS, FP_GROUP_IDS } = require('./fp-schema');

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
const PANEL_WIDTH = 420; // must match #fp-panel width in renderer/style.css
const TOP_HEIGHT = 72;   // tab bar (36) + address bar (36) — must match #top-bar in DOM
const STATUS_HEIGHT = 22;// status bar height — must match #status-bar in DOM

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
      const [width, height] = mainWindow.getContentSize();
      const viewWidth = panelOpen ? Math.max(200, width - PANEL_WIDTH) : width;
      tab.view.setBounds({ x: 0, y: TOP_HEIGHT, width: viewWidth, height: height - TOP_HEIGHT - STATUS_HEIGHT });
    }
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

  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition,
      // ponytail: fingerprint injection — null config = native (no spoof)
      ...(fp ? { fingerprint: fp } : {})
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

  return { view, profileId, profileName: profile.name, url: 'about:blank', title: 'New Tab' };
}

/**
 * Recreate a tab's BrowserView with a new fingerprint config.
 * Reuses the SAME partition so cookies/storage persist; the renderer
 * process is respawned so the new --fingerprint-config takes effect.
 * Returns the new view.
 */
function recreateTabView(tabId, fingerprint, keepUrl) {
  const tab = tabs.get(tabId);
  if (!tab) return null;

  // Destroy old view + detach from window
  try { mainWindow?.removeBrowserView(tab.view); } catch {}
  try { tab.view.webContents.close(); } catch {}

  const partition = `fp-tab-${tabId}`;
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
    const [width, height] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: TOP_HEIGHT, width, height: height - TOP_HEIGHT - STATUS_HEIGHT });
    view.setAutoResize({ width: true, height: true });
    mainWindow.addBrowserView(view);
  }

  return view;
}

function addTab(profileId = 'default') {
  const tabId = createTabId();
  const { view, profileId: pid, profileName, url, title } = createTabView(tabId, profileId);
  tabs.set(tabId, { id: tabId, view, profileId: pid, profileName, url, title });

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

  // Wait for UI to be ready before attaching BrowserView
  mainWindow.webContents.once('did-finish-load', () => {
    addTab('default');
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
  ipcMain.handle('tab:set-fingerprint', (e, { tabId, config }) => {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return false;
    try {
      // Normalize against the canonical 56-key schema: fill missing keys with
      // their disabled default and drop anything the kernel does not parse, so
      // a hand-edited JSON blob can never ship an unknown/no-op field.
      let apply = null;
      if (config && typeof config === 'object') {
        const norm = fpNormalizeConfig(config);
        apply = norm.config;
        if (norm.unknown.length) {
          console.warn('[fp] dropped unknown keys: ' + norm.unknown.join(', '));
        }
      }

      // Recreate the renderer (same partition) so the new fingerprint config
      // is injected via --fingerprint-config at renderer startup.
      recreateTabView(tid, apply, tab.url || 'about:blank');
      tab.profileId = config ? 'custom' : 'default';
      tab.profileName = config ? 'Custom' : 'Default';
      mainWindow?.webContents.send('tab:profile-changed', { tabId: tid, profileId: tab.profileId, profileName: tab.profileName });
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
  // the JSON editor against the exact kernel key set (56 keys / 14 groups).
  ipcMain.handle('fp:schema', () => ({
    version: FP_SCHEMA_VERSION,
    keyCount: FP_KEY_NAMES.length,
    keys: FP_KEYS,
    groups: FP_GROUPS,
    defaults: fpDefaultConfig()
  }));
  ipcMain.handle('fp:coverage', (e, cfg) => fpCoverage(cfg || {}));
}

// --- Random Profile Generator ---
//
// Generates a config covering ALL 56 kernel keys, grouped so that related
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
  fp.webgpu_features = '';  // REPLACE semantics: leaving "" keeps native set
  fp.webgpu_limits = '';    // MERGE semantics: leaving "" keeps native limits

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
  fp.net_effective_type = pick(['3g', '4g', '4g']);
  fp.net_rtt_ms = randInt(20, 150);
  fp.net_downlink_mbps = String(pick([2, 5, 10, 25, 50]));
  fp.webrtc_ip = '';  // only set deliberately; a wrong IP is a hard signal

  // --- Storage & perf ---
  fp.permissions_status = pick(['granted', 'prompt']);
  fp.storage_usage_bytes = randInt(524288, 8388608);
  fp.storage_quota_bytes = pick([1073741824, 5368709120, 10737418240, 21474836480]);
  fp.perf_now_precision_ms = pick([0, 0, 100, 200]);

  // --- Fonts ---
  fp.fonts_blocklist = '';
  fp.fonts_whitelist = '';

  // --- Battery ---
  fp.battery_charging = maybe(0.7, pick(['true', 'false']));
  fp.battery_level = maybe(0.7, String(pick([0.42, 0.67, 0.85, 1.0])));

  return {
    id: `random-${Date.now()}`,
    name: `Random ${sw}x${sh} / ${tz.split('/')[1]}`,
    fingerprint: fp,
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
