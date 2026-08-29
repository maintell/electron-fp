'use strict';

// --- State ---
let currentTabId = null;
let profiles = [];

// --- DOM refs ---
const $tabsContainer = document.getElementById('tabs-container');
const $newTabBtn = document.getElementById('new-tab-btn');
const $urlInput = document.getElementById('url-input');
const $btnGo = document.getElementById('btn-go');
const $btnBack = document.getElementById('btn-back');
const $btnForward = document.getElementById('btn-forward');
const $btnReload = document.getElementById('btn-reload');
const $btnDevtools = document.getElementById('btn-devtools');
const $btnProfile = document.getElementById('btn-profile');
const $fpPanel = document.getElementById('fp-panel');
const $fpPanelClose = document.getElementById('fp-panel-close');
const $fpProfileSelect = document.getElementById('fp-profile-select');
const $fpApplyProfile = document.getElementById('fp-apply-profile');
const $fpRandomize = document.getElementById('fp-randomize');
const $fpNewProfile = document.getElementById('fp-new-profile');
const $fpSaveProfile = document.getElementById('fp-save-profile');
const $fpDeleteProfile = document.getElementById('fp-delete-profile');
const $fpExportProfile = document.getElementById('fp-export-profile');
const $fpImportFile = document.getElementById('fp-import-file');
const $fpJsonEditor = document.getElementById('fp-json-editor');
const $fpApplyConfig = document.getElementById('fp-apply-config');
const $fpStatus = document.getElementById('fp-status');
const $fpGroups = document.getElementById('fp-groups');
const $fpGroupsSummary = document.getElementById('fp-groups-summary');
const $fpUaPreset = document.getElementById('fp-ua-preset');
const $fpUaInput = document.getElementById('fp-ua-input');
const $fpUaApply = document.getElementById('fp-ua-apply');
const $fpUaReset = document.getElementById('fp-ua-reset');
const $statusProfile = document.getElementById('status-profile');
const $statusInfo = document.getElementById('status-info');
const $statusVersion = document.getElementById('status-version');

// --- Tab Rendering ---
function renderTabs(tabs) {
  $tabsContainer.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = `tab${tab.id === currentTabId ? ' active' : ''}`;
    el.dataset.tabId = tab.id;

    const dot = document.createElement('span');
    dot.className = `tab-profile-dot dot-${getProfileDotClass(tab.profileId)}`;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'New Tab';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.closeTab(tab.id);
    });

    el.appendChild(dot);
    el.appendChild(title);
    el.appendChild(closeBtn);

    el.addEventListener('click', () => {
      window.api.activateTab(tab.id);
    });

    // Middle-click to close
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        window.api.closeTab(tab.id);
      }
    });

    $tabsContainer.appendChild(el);
  }
}

function getProfileDotClass(profileId) {
  if (!profileId || profileId === 'default') return 'default';
  if (profileId.includes('win')) return 'win10';
  if (profileId.includes('mac')) return 'macos';
  if (profileId.includes('linux')) return 'linux';
  if (profileId.includes('mobile') || profileId.includes('android')) return 'mobile';
  if (profileId.includes('random')) return 'random';
  return 'default';
}

// --- URL Bar ---
function updateUrlBar(url, title) {
  $urlInput.value = url || '';
  document.title = title ? `${title} - Electron FP Browser` : 'Electron FP Browser';
}

function handleNavigate() {
  const url = $urlInput.value.trim();
  if (!url || !currentTabId) return;
  window.api.navigateTab(currentTabId, url);
}

$urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleNavigate();
});
$btnGo.addEventListener('click', handleNavigate);
$btnBack.addEventListener('click', () => {
  // BrowserView doesn't expose history directly; use webContents
  // This is a limitation — back/forward requires webContents navigation history
  if (currentTabId) window.api.navigateTab(currentTabId, $urlInput.value);
});
$btnReload.addEventListener('click', () => {
  if (currentTabId) window.api.navigateTab(currentTabId, $urlInput.value);
});
$btnDevtools.addEventListener('click', () => {
  if (currentTabId) window.api.toggleDevtools(currentTabId);
});

// --- Fingerprint Panel (permanent sidebar, per-tab config) ---
// IMPORTANT: the fingerprint panel is part of the main window's DOM, which sits
// BEHIND the active BrowserView's native layer. When the panel is open we tell the
// main process to shrink the BrowserView so the panel area is not covered — only
// then are the panel's buttons actually clickable (clicks would otherwise hit
// the page rendered by the BrowserView).
let panelOpen = true; // always visible by default

function setPanelState(isOpen) {
  panelOpen = isOpen;
  if (isOpen) {
    $fpPanel.classList.remove('collapsed');
    $btnProfile.classList.add('active');
    loadProfilesIntoSelect();
    loadCurrentFingerprint();
  } else {
    $fpPanel.classList.add('collapsed');
    $btnProfile.classList.remove('active');
  }
  window.api.setPanelOpen(isOpen);
}

// Update the "Tab: N" indicator and load THAT tab's own fingerprint config
function syncPanelToTab(tabId, title) {
  const shortId = tabId ? tabId.replace('tab-', '#') : '-';
  document.getElementById('fp-tab-indicator').textContent = `Tab: ${shortId}`;
  if (panelOpen) loadCurrentFingerprint();
}

$btnProfile.addEventListener('click', () => setPanelState(!panelOpen));

$fpPanelClose.addEventListener('click', () => setPanelState(false));

async function loadProfilesIntoSelect() {
  profiles = await window.api.listProfiles();
  $fpProfileSelect.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    $fpProfileSelect.appendChild(opt);
  }
}

async function loadCurrentFingerprint() {
  if (!currentTabId) return;
  const fp = await window.api.getFingerprint(currentTabId);
  $fpJsonEditor.value = fp ? JSON.stringify(fp, null, 2) : '{\n  \n}';
  $fpStatus.textContent = '';
  await loadCurrentUserAgent();
  await renderFpGroups();
}

// --- User-Agent (client-level surface, separate from the 56 kernel keys) ---

async function loadUaPresets() {
  const presets = await window.api.listUaPresets();
  $fpUaPreset.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— preset —';
  $fpUaPreset.appendChild(blank);
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.ua;
    opt.textContent = p.label;
    $fpUaPreset.appendChild(opt);
  }
}

async function loadCurrentUserAgent() {
  if (!currentTabId) return;
  const ua = await window.api.getUserAgent(currentTabId);
  $fpUaInput.value = ua || '';
}

$fpUaPreset.addEventListener('change', () => {
  if ($fpUaPreset.value) $fpUaInput.value = $fpUaPreset.value;
  $fpUaPreset.value = '';
});

$fpUaApply.addEventListener('click', async () => {
  if (!currentTabId) return;
  const ok = await window.api.setUserAgent(currentTabId, $fpUaInput.value);
  $fpStatus.textContent = ok ? 'UA applied' : 'Failed to apply UA';
  setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
});

$fpUaReset.addEventListener('click', async () => {
  if (!currentTabId) return;
  await window.api.setUserAgent(currentTabId, '');
  $fpUaInput.value = '';
  $fpStatus.textContent = 'UA reset to native';
  setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
});

$fpApplyProfile.addEventListener('click', async () => {
  const profileId = $fpProfileSelect.value;
  if (!profileId || !currentTabId) return;
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;
  // The profile's UA travels alongside the fingerprint, not inside it: it is an
  // Electron-level surface, and fpNormalizeConfig() would drop it if nested.
  const ok = await window.api.setFingerprint(currentTabId, profile.fingerprint, profile.userAgent);
  $fpStatus.textContent = ok ? `Applied: ${profile.name}` : 'Failed to apply';
  $statusProfile.textContent = `Profile: ${profile.name}`;
  await loadCurrentUserAgent();
  await renderFpGroups();
  setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
});

$fpRandomize.addEventListener('click', async () => {
  const randomProfile = await window.api.randomizeProfile();
  $fpJsonEditor.value = JSON.stringify(randomProfile.fingerprint, null, 2);
  // Also create the profile
  await window.api.createProfile(randomProfile);
  await loadProfilesIntoSelect();
  $fpProfileSelect.value = randomProfile.id;
  $fpUaInput.value = randomProfile.userAgent || '';
  $fpStatus.textContent = `Generated: ${randomProfile.name}`;
  await renderFpGroups();
});

$fpApplyConfig.addEventListener('click', async () => {
  if (!currentTabId) return;
  try {
    const config = JSON.parse($fpJsonEditor.value);
    // undefined => keep the tab's current UA, so editing the 56 kernel keys
    // alone does not silently wipe a UA the operator set in the UA box.
    const ok = await window.api.setFingerprint(currentTabId, config, undefined);
    $fpStatus.textContent = ok ? 'Applied!' : 'Failed to apply';
    $statusProfile.textContent = 'Profile: Custom';
    await loadCurrentUserAgent();
    await renderFpGroups();
    setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
  } catch (e) {
    $fpStatus.textContent = `JSON error: ${e.message}`;
    $fpStatus.style.color = '#f44336';
    setTimeout(() => { $fpStatus.style.color = ''; }, 2000);
  }
});

$fpNewProfile.addEventListener('click', async () => {
  const name = prompt('Profile name:');
  if (!name) return;
  const id = `profile-${Date.now()}`;
  const fp = tryParseJson($fpJsonEditor.value);
  await window.api.createProfile({ id, name, fingerprint: fp });
  await loadProfilesIntoSelect();
  $fpProfileSelect.value = id;
  $fpStatus.textContent = `Created: ${name}`;
});

$fpSaveProfile.addEventListener('click', async () => {
  const selectedId = $fpProfileSelect.value;
  if (!selectedId) return;
  const fp = tryParseJson($fpJsonEditor.value);
  await window.api.updateProfile({ id: selectedId, fingerprint: fp });
  $fpStatus.textContent = 'Saved!';
  setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
});

$fpDeleteProfile.addEventListener('click', async () => {
  const selectedId = $fpProfileSelect.value;
  if (!selectedId || selectedId === 'default') return;
  if (!confirm('Delete this profile?')) return;
  await window.api.deleteProfile(selectedId);
  await loadProfilesIntoSelect();
  $fpStatus.textContent = 'Deleted';
});

$fpExportProfile.addEventListener('click', async () => {
  const selectedId = $fpProfileSelect.value;
  if (!selectedId) return;
  const profile = profiles.find(p => p.id === selectedId);
  if (!profile) return;
  const blob = JSON.stringify(profile, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
  a.download = `fp-profile-${selectedId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$fpImportFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const profile = JSON.parse(text);
    if (!profile.id || !profile.name) {
      alert('Invalid profile format: must have "id" and "name"');
      return;
    }
    await window.api.createProfile(profile);
    await loadProfilesIntoSelect();
    $fpProfileSelect.value = profile.id;
    $fpStatus.textContent = `Imported: ${profile.name}`;
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
  e.target.value = '';
});

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ============================================================================
// Grouped fingerprint UI
//
// Renders the kernel's 56 keys as collapsible sections, one per functional
// group (hardware / screen / audio / webgl / webgpu / geo / speech / media /
// canvas / env / network / storage / fonts / battery). The JSON textarea remains
// the source of truth: editing a field rewrites the JSON, and editing the JSON
// refreshes the fields. Unknown keys typed by hand are surfaced, not silently
// dropped.
// ============================================================================
let fpSchema = null;        // { version, keyCount, keys, groups, defaults }
let fpGroupCollapsed = {};  // groupId -> bool (persisted in-memory per session)

async function ensureFpSchema() {
  if (!fpSchema) fpSchema = await window.api.getFpSchema();
  return fpSchema;
}

/** Render all group sections from the current JSON editor content. */
async function renderFpGroups() {
  const schema = await ensureFpSchema();
  const cfg = tryParseJson($fpJsonEditor.value) || {};

  let activeTotal = 0, keyTotal = 0;
  const unknown = Object.keys(cfg).filter(function (k) { return !(k in schema.keys); });

  $fpGroups.innerHTML = '';
  for (const g of schema.groups) {
    const keys = Object.keys(schema.keys).filter(function (k) {
      return schema.keys[k].group === g.id;
    });
    const active = keys.filter(function (k) {
      return isKeyActive(schema.keys[k].def, cfg[k]);
    }).length;
    keyTotal += keys.length;
    activeTotal += active;

    const section = document.createElement('div');
    section.className = 'fp-group';

    const head = document.createElement('button');
    head.className = 'fp-group-head';
    head.type = 'button';
    const caret = fpGroupCollapsed[g.id] ? '\u25B6' : '\u25BC';
    head.textContent = caret + ' ' + g.label + '  (' + active + '/' + keys.length + ')';
    head.title = g.desc;
    if (active > 0) head.classList.add('has-active');

    const body = document.createElement('div');
    body.className = 'fp-group-body';
    if (fpGroupCollapsed[g.id]) body.style.display = 'none';

    head.addEventListener('click', function () {
      fpGroupCollapsed[g.id] = !fpGroupCollapsed[g.id];
      renderFpGroups();
    });

    for (const k of keys) {
      const meta = schema.keys[k];
      const row = document.createElement('div');
      row.className = 'fp-field';

      const label = document.createElement('label');
      label.textContent = k;
      label.title = g.label + ' \u00b7 ' + meta.kind;

      const input = document.createElement('input');
      input.type = (meta.kind === 'int' || meta.kind === 'int64') ? 'number' : 'text';
      input.dataset.key = k;
      input.value = (k in cfg) ? String(cfg[k]) : String(meta.def);
      if (isKeyActive(meta.def, cfg[k])) input.classList.add('active');
      input.title = meta.kind + ' value';

      // Field -> JSON: the textarea stays the single source of truth.
      input.addEventListener('change', function () {
        const next = tryParseJson($fpJsonEditor.value) || {};
        const raw = input.value;
        if (meta.kind === 'int' || meta.kind === 'int64') {
          const n = Number(raw);
          if (raw === '' || Number.isNaN(n)) delete next[k];
          else next[k] = n;
        } else {
          if (raw === '') delete next[k];
          else next[k] = raw;
        }
        $fpJsonEditor.value = JSON.stringify(next, null, 2);
        renderFpGroups();
      });

      row.appendChild(label);
      row.appendChild(input);
      body.appendChild(row);
    }

    section.appendChild(head);
    section.appendChild(body);
    $fpGroups.appendChild(section);
  }

  // Summary: coverage plus any hand-typed keys the kernel would ignore.
  let html = '<div class="fp-cov">Coverage: <b>' + activeTotal + '</b>/' + keyTotal + ' keys active</div>';
  if (unknown.length) {
    html += '<div class="fp-unknown">Ignored by kernel: ' + unknown.join(', ') + '</div>';
  }
  $fpGroupsSummary.innerHTML = html;
}

/** Mirrors fpIsActive() in fp-schema.js: differs from the disabled default. */
function isKeyActive(def, value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof def === 'number') return Number(value) !== 0;
  return String(value) !== String(def);
}

// JSON edits (typed or programmatic) refresh the grouped fields. Debounced so
// typing in the textarea doesn't fight the re-render.
let fpGroupsTimer = null;
function scheduleFpGroupsRender() {
  clearTimeout(fpGroupsTimer);
  fpGroupsTimer = setTimeout(function () { renderFpGroups(); }, 250);
}
$fpJsonEditor.addEventListener('input', scheduleFpGroupsRender);

// Test hook: lets test-ui-groups.js drive a render without simulating input.
window.__renderFpGroupsForTest = renderFpGroups;


// --- Window Controls (frameless window) ---
// These only work if the window is frameless; with default frame they're decorative
document.getElementById('btn-minimize')?.addEventListener('click', () => {
  window.electron?.process?.platform; // noop placeholder
});
document.getElementById('btn-maximize')?.addEventListener('click', () => {});
document.getElementById('btn-close')?.addEventListener('click', () => {});

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  // Ctrl+T: new tab
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    window.api.createTab('default');
  }
  // Ctrl+W: close tab
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (currentTabId) window.api.closeTab(currentTabId);
  }
  // Ctrl+L or F6: focus address bar
  if ((e.ctrlKey && e.key === 'l') || e.key === 'F6') {
    e.preventDefault();
    $urlInput.focus();
    $urlInput.select();
  }
  // F5 or Ctrl+R: reload
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
    e.preventDefault();
    if (currentTabId) window.api.navigateTab(currentTabId, $urlInput.value);
  }
  // F12: toggle devtools
  if (e.key === 'F12') {
    e.preventDefault();
    if (currentTabId) window.api.toggleDevtools(currentTabId);
  }
  // F10: toggle fingerprint panel
  if (e.key === 'F10') {
    e.preventDefault();
    setPanelState(!panelOpen);
  }
});

// --- New Tab ---
$newTabBtn.addEventListener('click', () => {
  window.api.createTab('default');
});

// --- IPC Event Listeners ---
window.api.on('tab:created', async (data) => {
  const tabs = await window.api.listTabs();
  renderTabs(tabs);
});

window.api.on('tab:closed', async (data) => {
  const tabs = await window.api.listTabs();
  renderTabs(tabs);
  if (tabs.length === 0) {
    updateUrlBar('', '');
    $statusProfile.textContent = 'Profile: -';
  }
});

window.api.on('tab:activated', async (data) => {
  currentTabId = data.tabId;
  updateUrlBar(data.url, data.title);
  $statusProfile.textContent = `Profile: ${data.profileName || data.profileId}`;
  syncPanelToTab(data.tabId, data.title);
  const tabs = await window.api.listTabs();
  renderTabs(tabs);
});

window.api.on('tab:title-updated', async (data) => {
  if (data.tabId === currentTabId) {
    document.title = data.title ? `${data.title} - Electron FP Browser` : 'Electron FP Browser';
  }
  const tabs = await window.api.listTabs();
  renderTabs(tabs);
});

window.api.on('tab:navigated', async (data) => {
  if (data.tabId === currentTabId) {
    $urlInput.value = data.url || '';
  }
});

// When a tab's fingerprint profile is switched at runtime, refresh the panel
window.api.on('tab:profile-changed', async (data) => {
  if (data.tabId === currentTabId) {
    $statusProfile.textContent = `Profile: ${data.profileName || data.profileId}`;
    await loadCurrentFingerprint();
  }
});

// --- Init ---
async function init() {
  const versions = await window.api.getVersions();
  $statusVersion.textContent = `Electron ${versions.electron} / Chrome ${versions.chrome}`;

  const tabs = await window.api.listTabs();
  renderTabs(tabs);

  if (tabs.length > 0) {
    const active = tabs.find(t => t.isActive) || tabs[0];
    currentTabId = active.id;
    updateUrlBar(active.url, active.title);
    $statusProfile.textContent = `Profile: ${active.profileName || active.profileId}`;
  }

  // Open the fingerprint sidebar by default and load the active tab's config
  setPanelState(true);
  await loadUaPresets();
  await loadCurrentUserAgent();
  await renderFpGroups();
}

init();
