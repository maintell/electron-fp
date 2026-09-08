'use strict';

// --- State ---
let currentTabId = null;
let profiles = [];
// --- Group state (two-level tabs: profile groups -> sub-tabs) ---
let groups = [];
let activeGroupId = null;
let allTabs = [];

// --- DOM refs ---
const $tabsContainer = document.getElementById('tabs-container');
const $newTabBtn = document.getElementById('new-tab-btn');
const $groupsContainer = document.getElementById('groups-container');
const $newGroupBtn = document.getElementById('new-group-btn');
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
// --- Self-test pane ---
const $fpTabConfig = document.getElementById('fp-tab-config');
const $fpTabSelfTest = document.getElementById('fp-tab-selftest');
const $fpPaneConfig = document.getElementById('fp-pane-config');
const $fpPaneSelfTest = document.getElementById('fp-pane-selftest');
const $fpSelfTestRun = document.getElementById('fp-selftest-run');
const $fpSelfTestSummary = document.getElementById('fp-selftest-summary');
const $fpSelfTestResults = document.getElementById('fp-selftest-results');
const $fpSelfTestShowSkipped = document.getElementById('fp-selftest-show-skipped');

// --- Tab Rendering ---
function renderTabs(tabs) {
  allTabs = Array.isArray(tabs) ? tabs : [];
  // Show only the active group's sub-tabs. Tabs without a groupId come from
  // an older main process without groups — show them all so nothing vanishes.
  const visible = activeGroupId
    ? allTabs.filter((t) => !t.groupId || t.groupId === activeGroupId)
    : allTabs;
  $tabsContainer.innerHTML = '';
  for (const tab of visible) {
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
      handleCloseTab(tab.id);
    });

    el.appendChild(dot);
    el.appendChild(title);
    el.appendChild(closeBtn);

    el.addEventListener('click', () => {
      if (hasApi('activateTab')) window.api.activateTab(tab.id);
      else warnMissingApi('activateTab');
    });

    // Middle-click to close
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        handleCloseTab(tab.id);
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

// --- Group helpers (renderer-side compat: main-process lane owns main.js) ---
function hasApi(name) {
  return !!(window.api && typeof window.api[name] === 'function');
}
function warnMissingApi(name) {
  console.warn(`[renderer] window.api.${name}() missing — main-process lane not wired yet`);
}
function groupIdOf(g) {
  return g ? (g.groupId || g.id) : null;
}
function groupNameOf(g) {
  return (g && (g.name || g.profileName || g.profileId)) || groupIdOf(g) || '-';
}
function groupProfileOf(g) {
  return (g && (g.profileId || g.profile)) || 'default';
}
function currentGroup() {
  return groups.find((g) => groupIdOf(g) === activeGroupId) || null;
}
function currentTab() {
  return allTabs.find((t) => t.id === currentTabId) || null;
}
function tabsInGroup(gid) {
  if (!gid) return allTabs;
  return allTabs.filter((t) => !t.groupId || t.groupId === gid);
}
// Target for all fingerprint panel actions: the active group's active tab.
function targetTabId() {
  const t = currentTab();
  if (t && (!t.groupId || t.groupId === activeGroupId)) return t.id;
  const sibs = tabsInGroup(activeGroupId);
  return (sibs.length && sibs[0].id) || currentTabId;
}
// Group-level apply with fallback: prefer setGroupProfile, else per-tab setFingerprint.
async function applyFingerprintToGroup(groupId, tabId, config, userAgent) {
  if (hasApi('setGroupProfile') && groupId) {
    return window.api.setGroupProfile(groupId, config, userAgent);
  }
  if (hasApi('setFingerprint') && tabId) {
    return window.api.setFingerprint(tabId, config, userAgent);
  }
  warnMissingApi(hasApi('setGroupProfile') ? 'setFingerprint' : 'setGroupProfile');
  return false;
}
function updateStatusProfile(profileLabel) {
  const g = currentGroup();
  const t = currentTab();
  const gn = g ? groupNameOf(g) : '-';
  const tn = t ? (t.title || t.id) : '-';
  const pl = profileLabel || (t && (t.profileName || t.profileId)) || (g && groupProfileOf(g)) || '-';
  $statusProfile.textContent = `Group: ${gn} | Tab: ${tn} | Profile: ${pl}`;
}
function updateFpIndicator() {
  const g = currentGroup();
  const t = currentTab();
  const el = document.getElementById('fp-tab-indicator');
  if (!el) return;
  const gn = g ? groupNameOf(g) : '-';
  const tn = t ? (t.title || t.id || '-').toString().slice(0, 24) : '-';
  el.textContent = `Group: ${gn} / Tab: ${tn}`;
}

// --- Group rendering ---
function renderGroups(list) {
  if (Array.isArray(list)) groups = list;
  if (!$groupsContainer) return;
  $groupsContainer.innerHTML = '';
  for (const g of groups) {
    const gid = groupIdOf(g);
    const el = document.createElement('div');
    el.className = `group${gid === activeGroupId ? ' active' : ''}`;
    el.dataset.groupId = gid;
    el.title = `Profile group: ${groupNameOf(g)}`;

    const dot = document.createElement('span');
    dot.className = `tab-profile-dot dot-${getProfileDotClass(groupProfileOf(g))}`;

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = groupNameOf(g);

    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(tabsInGroup(gid).length);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'group-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Close group';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleCloseGroup(gid);
    });

    el.appendChild(dot);
    el.appendChild(name);
    el.appendChild(count);
    el.appendChild(closeBtn);

    el.addEventListener('click', () => { handleActivateGroup(gid); });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); handleCloseGroup(gid); }
    });

    $groupsContainer.appendChild(el);
  }
}

async function handleActivateGroup(gid) {
  if (!gid) return;
  if (!hasApi('activateGroup')) { warnMissingApi('activateGroup'); return; }
  try { await window.api.activateGroup(gid); } catch (e) { console.warn('[renderer] activateGroup failed:', e); }
  await refreshAll();
}

async function handleCloseGroup(gid) {
  if (!gid) return;
  if (!hasApi('closeGroup')) { warnMissingApi('closeGroup'); return; }
  try { await window.api.closeGroup(gid); } catch (e) { console.warn('[renderer] closeGroup failed:', e); }
  await refreshAll();
  // Always keep one usable group around.
  if (!groups.length && hasApi('createGroup')) {
    try { await window.api.createGroup('default'); } catch (e) { /* noop */ }
    await refreshAll();
  }
}

async function handleNewGroup() {
  if (!hasApi('createGroup')) { warnMissingApi('createGroup'); return; }
  try { await window.api.createGroup('default'); } catch (e) { console.warn('[renderer] createGroup failed:', e); }
  await refreshAll();
}

// Close a sub-tab; if it was the last one in its group, close the group too.
async function handleCloseTab(tabId) {
  if (!tabId) return;
  if (!hasApi('closeTab')) { warnMissingApi('closeTab'); return; }
  const tab = allTabs.find((t) => t.id === tabId);
  const gid = (tab && tab.groupId) || activeGroupId;
  try { await window.api.closeTab(tabId); } catch (e) { console.warn('[renderer] closeTab failed:', e); }
  await refreshAll();
  const remaining = gid ? allTabs.filter((t) => t.groupId === gid || (!t.groupId && gid === activeGroupId)) : [];
  if (gid && remaining.length === 0) {
    if (hasApi('closeGroup')) {
      try { await window.api.closeGroup(gid); } catch (e) { /* noop */ }
      await refreshAll();
    }
    if (!groups.length && hasApi('createGroup')) {
      try { await window.api.createGroup('default'); } catch (e) { /* noop */ }
      await refreshAll();
    }
  }
}

// Single refresh: groups -> group row, tabs -> filtered sub-tab row, panel + URL bar.
async function refreshAll() {
  try {
    if (hasApi('listGroups')) {
      try {
        const gs = await window.api.listGroups();
        if (Array.isArray(gs)) groups = gs;
      } catch (e) { console.warn('[renderer] listGroups failed:', e); }
      if (hasApi('getActiveGroup')) {
        try {
          const ag = await window.api.getActiveGroup();
          if (ag) activeGroupId = (typeof ag === 'string') ? ag : (ag.groupId || ag.id || activeGroupId);
        } catch (e) { /* keep current */ }
      }
      if (activeGroupId && !groups.some((g) => groupIdOf(g) === activeGroupId)) {
        activeGroupId = groups.length ? groupIdOf(groups[0]) : null;
      }
      if (!activeGroupId && groups.length) activeGroupId = groupIdOf(groups[0]);
      renderGroups(groups);
    }
    let tabs = [];
    if (hasApi('listTabs')) {
      try { tabs = await window.api.listTabs() || []; } catch (e) { console.warn('[renderer] listTabs failed:', e); }
    }
    renderTabs(tabs);
    // Sync to the active tab of the active group.
    // getActiveTab may return a bare tabId string or { groupId, tabId }.
    if (hasApi('getActiveTab')) {
      try {
        const at = await window.api.getActiveTab();
        if (at) {
          if (typeof at === 'string') currentTabId = at;
          else {
            if (at.groupId) activeGroupId = at.groupId;
            if (at.tabId || at.id) currentTabId = at.tabId || at.id;
          }
        }
      } catch (e) { /* keep list-derived active */ }
    }
    let active = allTabs.find((t) => t.isActive) || null;
    if (activeGroupId) {
      const inGroup = allTabs.filter((t) => !t.groupId || t.groupId === activeGroupId);
      active = inGroup.find((t) => t.isActive) || inGroup.find((t) => t.id === currentTabId) || inGroup[0] || active;
    }
    if (active) {
      currentTabId = active.id;
      updateUrlBar(active.url, active.title);
      updateStatusProfile(active.profileName || active.profileId);
    } else if (!allTabs.length) {
      updateUrlBar('', '');
    }
    updateFpIndicator();
    if (panelOpen) loadCurrentFingerprint();
  } catch (e) {
    console.warn('[renderer] refreshAll failed:', e);
  }
}

// Debounced refresh for bursty tab:*/group:* events.
let refreshTimer = null;
function scheduleRefreshAll() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshAll(); }, 120);
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

// Update the "Group: X / Tab: Y" indicator and load the active group's config.
// The panel is group-level: it always shows the active group's active tab.
function syncPanelToTab(tabId, title) {
  updateFpIndicator();
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
  const tid = targetTabId();
  if (!tid) return;
  const fp = await window.api.getFingerprint(tid);
  $fpJsonEditor.value = fp ? JSON.stringify(fp, null, 2) : '{\n  \n}';
  $fpStatus.textContent = '';
  await loadCurrentUserAgent();
  await renderFpGroups();
}

// --- User-Agent (client-level surface, separate from the 60 kernel keys) ---

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
  const tid = targetTabId();
  if (!tid) return;
  const ua = await window.api.getUserAgent(tid);
  $fpUaInput.value = ua || '';
}

$fpUaPreset.addEventListener('change', () => {
  if ($fpUaPreset.value) $fpUaInput.value = $fpUaPreset.value;
  $fpUaPreset.value = '';
});

$fpUaApply.addEventListener('click', async () => {
  const tid = targetTabId();
  if (!tid) return;
  const ua = $fpUaInput.value;
  // Keep navigator_platform in step with the UA. The two are separate surfaces
  // and nothing enforces agreement, so a Mac UA left beside the host's real
  // "Win32" is exactly the contradiction the key exists to prevent. The JSON
  // textarea is the source of truth for the kernel config, so rewrite it here
  // and let the existing apply path carry both across together.
  const platform = await window.api.platformForUserAgent(ua);
  if (platform !== null && platform !== undefined) {
    const cfg = tryParseJson($fpJsonEditor.value) || {};
    if (platform) cfg.navigator_platform = platform;
    else delete cfg.navigator_platform;
    $fpJsonEditor.value = JSON.stringify(cfg, null, 2);
  }
  const ok = await window.api.setUserAgent(tid, ua);
  // Group-level: whole active group shares one profile (setGroupProfile when
  // the main-process lane provides it, else per-tab fallback).
  await applyFingerprintToGroup(activeGroupId, tid, tryParseJson($fpJsonEditor.value), ua);
  $fpStatus.textContent = ok ? 'UA applied to group' : 'Failed to apply UA';
  await renderFpGroups();
  setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
});

$fpUaReset.addEventListener('click', async () => {
  const tid = targetTabId();
  if (!tid) return;
  // Resetting the UA means there is nothing to stay consistent with, so drop
  // navigator_platform too rather than leaving a MacIntel override behind.
  const cfg = tryParseJson($fpJsonEditor.value) || {};
  delete cfg.navigator_platform;
  $fpJsonEditor.value = JSON.stringify(cfg, null, 2);
  await window.api.setUserAgent(tid, '');
  await applyFingerprintToGroup(activeGroupId, tid, cfg, '');
  $fpUaInput.value = '';
  $fpStatus.textContent = 'UA reset to native';
  await renderFpGroups();
  setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
});

$fpApplyProfile.addEventListener('click', async () => {
  const profileId = $fpProfileSelect.value;
  const tid = targetTabId();
  if (!profileId || !tid) return;
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;
  // The profile's UA travels alongside the fingerprint, not inside it: it is an
  // Electron-level surface, and fpNormalizeConfig() would drop it if nested.
  // Group-level: Apply covers the whole active group.
  const ok = await applyFingerprintToGroup(activeGroupId, tid, profile.fingerprint, profile.userAgent);
  $fpStatus.textContent = ok ? `Applied to group: ${profile.name}` : 'Failed to apply';
  updateStatusProfile(profile.name);
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
  const tid = targetTabId();
  if (!tid) return;
  try {
    const config = JSON.parse($fpJsonEditor.value);
    // undefined => keep the tab's current UA, so editing the 60 kernel keys
    // alone does not silently wipe a UA the operator set in the UA box.
    // Group-level: Apply covers the whole active group.
    const ok = await applyFingerprintToGroup(activeGroupId, tid, config, undefined);
    $fpStatus.textContent = ok ? 'Applied to group!' : 'Failed to apply';
    updateStatusProfile('Custom');
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
// Renders the kernel's 63 keys as collapsible sections, one per functional
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

/**
 * Every key the user may put in the JSON editor: the 63 Blink keys plus the 9
 * TLS keys.
 *
 * The two planes live in separate tables (see fp-schema.js) because they are
 * delivered differently, but the editor and the group list show them together.
 * Without this union the "unknown key" filter below would flag all 9 TLS keys
 * as unknown and drop them - which is how they came to be missing from the
 * client in the first place.
 */
function allEditableKeys(schema) {
  const keys = Object.keys(schema.keys || {});
  const tls = schema.tls && schema.tls.keys ? Object.keys(schema.tls.keys) : [];
  const h2 = schema.h2 && schema.h2.keys ? Object.keys(schema.h2.keys) : [];
  return keys.concat(tls).concat(h2);
}

/** Key metadata from whichever plane owns it. */
function keyMeta(schema, k) {
  if (schema.keys && schema.keys[k]) return schema.keys[k];
  if (schema.tls && schema.tls.keys && schema.tls.keys[k]) return schema.tls.keys[k];
  if (schema.h2 && schema.h2.keys && schema.h2.keys[k]) return schema.h2.keys[k];
  return null;
}

/** Is a key from the TLS plane? */
function isTlsKey(schema, k) {
  return !!(schema.tls && schema.tls.keys && schema.tls.keys[k]);
}

/** Is a key from the HTTP/2 plane? */
function isH2Key(schema, k) {
  return !!(schema.h2 && schema.h2.keys && schema.h2.keys[k]);
}

/** Render all group sections from the current JSON editor content. */
async function renderFpGroups() {
  const schema = await ensureFpSchema();
  const cfg = tryParseJson($fpJsonEditor.value) || {};

  let activeTotal = 0, keyTotal = 0;
  const editable = allEditableKeys(schema);
  const editableSet = new Set(editable);
  const unknown = Object.keys(cfg).filter(function (k) { return !editableSet.has(k); });

  $fpGroups.innerHTML = '';
  // The two non-Blink planes come FIRST, then the Blink groups. These were
  // appended last, which put them at roughly 3013px inside a 2808px pane -
  // permanently below the fold, with 15 sections of page-level keys to scroll
  // past. A user reported the TLS settings as simply absent. Putting the other
  // delivery planes at the top also matches how they behave: they are different
  // layers, not the 16th and 17th groups.
  // HTTP/2 leads because it is the most constrained: it can only be set when
  // the tab is created, so burying it would hide that fact from anyone who
  // needs it.
  const tlsGroups = (schema.tls && schema.tls.groups) || [];
  const h2Groups = (schema.h2 && schema.h2.groups) || [];
  const allGroups = h2Groups.concat(tlsGroups).concat(schema.groups || []);
  for (const g of allGroups) {
    const tlsGroup = tlsGroups.indexOf(g) >= 0;
    const h2Group = h2Groups.indexOf(g) >= 0;
    const keys = editable.filter(function (k) {
      if (tlsGroup) return isTlsKey(schema, k);
      if (h2Group) return isH2Key(schema, k);
      const meta = schema.keys[k];
      return !!meta && meta.group === g.id;
    });
    const active = keys.filter(function (k) {
      const meta = keyMeta(schema, k);
      return meta ? isKeyActive(meta.def, cfg[k]) : false;
    }).length;
    keyTotal += keys.length;
    activeTotal += active;

    const section = document.createElement('div');
    // Tag the non-Blink planes so style.css can mark them: these keys travel by
    // setSSLConfig() / a fromPartition() option and are invisible to page JS, so
    // they must read as a different layer, not as just another group at the
    // bottom of the list.
    section.className = 'fp-group' +
      (tlsGroup ? ' fp-group-tls' : '') +
      (h2Group ? ' fp-group-h2' : '');

    const head = document.createElement('button');
    head.className = 'fp-group-head';
    head.type = 'button';
    const caret = fpGroupCollapsed[g.id] ? '\u25B6' : '\u25BC';
    // Each non-Blink plane names its delivery mechanism in the header. Without
    // it the section is just one more heading, and the one thing a user must
    // know about these keys - that they are applied to the network layer, not
    // the page - is nowhere on screen.
    head.textContent = caret + ' ' + g.label + '  (' + active + '/' + keys.length + ')' +
      (tlsGroup ? '  \u00b7 setSSLConfig' : '') +
      (h2Group ? '  \u00b7 fromPartition' : '');
    head.title = g.desc + (h2Group
      ? ' \u2014 applied to the network layer, invisible to page JavaScript. ' +
        'FIXED WHEN THE TAB IS CREATED: changing these on an open tab has no ' +
        'effect, so close and reopen the tab to apply them.'
      : tlsGroup
      ? ' \u2014 applied to the session, invisible to page JavaScript'
      : '');
    if (active > 0) head.classList.add('has-active');

    const body = document.createElement('div');
    body.className = 'fp-group-body';
    if (fpGroupCollapsed[g.id]) body.style.display = 'none';

    head.addEventListener('click', function () {
      fpGroupCollapsed[g.id] = !fpGroupCollapsed[g.id];
      renderFpGroups();
    });

    for (const k of keys) {
      const meta = keyMeta(schema, k);
      if (!meta) continue;
      const row = document.createElement('div');
      row.className = 'fp-field' +
        (isTlsKey(schema, k) ? ' fp-field-tls' : '') +
        (isH2Key(schema, k) ? ' fp-field-h2' : '');

      const label = document.createElement('label');
      label.textContent = (meta.label ? meta.label + ' \u00b7 ' : '') + k;
      label.title = g.label + ' \u00b7 ' + meta.kind;

      const input = document.createElement('input');
      // TLS/H2 bools render as a checkbox so the user cannot type "yes" and get a
      // coercion surprise; the int/u16list kinds stay numeric text. greaseFrame
      // is an object in the kernel, so it is edited as JSON text and validated
      // by fpH2Validate() at the funnel - a bad shape is refused with a message
      // instead of dropping the whole profile.
      if (meta.kind === 'bool') {
        input.type = 'checkbox';
        input.dataset.key = k;
        input.checked = (k in cfg) ? isKeyActive(meta.def, cfg[k]) : false;
        if (isKeyActive(meta.def, cfg[k])) input.classList.add('active');
      } else if (meta.kind === 'greaseframe') {
        input.type = 'text';
        input.dataset.key = k;
        input.placeholder = '{"type":42,"flags":0,"payload":"deadbeef"}';
        input.value = (k in cfg)
          ? (typeof cfg[k] === 'string' ? cfg[k] : JSON.stringify(cfg[k]))
          : '';
        if (isKeyActive(meta.def, cfg[k])) input.classList.add('active');
      } else {
        input.type = (meta.kind === 'int' || meta.kind === 'int64') ? 'number' : 'text';
        input.dataset.key = k;
        input.value = (k in cfg) ? String(cfg[k]) : String(meta.def);
        if (isKeyActive(meta.def, cfg[k])) input.classList.add('active');
      }
      input.title = meta.kind + ' value';

      // Field -> JSON: the textarea stays the single source of truth.
      input.addEventListener('change', function () {
        const next = tryParseJson($fpJsonEditor.value) || {};
        // A checkbox is tri-state in meaning: unchecked means "not configured"
        // (delete the key) rather than "false", because setting
        // fpGreaseEnabled:false is a real, different instruction from not
        // mentioning it. So the box is checked=configured, and a separate
        // control would be needed to say "explicitly false" - see the hint.
        if (meta.kind === 'bool') {
          if (input.checked) next[k] = true;
          else delete next[k];
        } else if (meta.kind === 'greaseframe') {
          const raw = input.value.trim();
          if (raw === '') { delete next[k]; }
          else {
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
            if (parsed === null) {
              // Refuse rather than store a string the validator would reject
              // later with no visible cause.
              input.classList.add('fp-field-bad');
              input.title = 'must be JSON, e.g. {"type":42,"flags":0}';
              $fpJsonEditor.value = JSON.stringify(next, null, 2);
              return;
            }
            input.classList.remove('fp-field-bad');
            next[k] = parsed;
          }
        } else {
          const raw = input.value;
          if (meta.kind === 'int' || meta.kind === 'int64') {
            const n = Number(raw);
            if (raw === '' || Number.isNaN(n)) delete next[k];
            else next[k] = n;
          } else {
            if (raw === '') delete next[k];
            else next[k] = raw;
          }
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

// Test hook: the UA/panel handlers guard on currentTabId, which is null in the
// standalone harness because it has no real tabs. Setting it lets those
// handlers be exercised without weakening the guard in production code.
window.__setCurrentTabForTest = (id) => { currentTabId = id; };
window.__clearCurrentTabForTest = () => { currentTabId = null; };


// --- Window Controls (frameless window) ---
// These only work if the window is frameless; with default frame they're decorative
document.getElementById('btn-minimize')?.addEventListener('click', () => {
  window.electron?.process?.platform; // noop placeholder
});
document.getElementById('btn-maximize')?.addEventListener('click', () => {});
document.getElementById('btn-close')?.addEventListener('click', () => {});

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  // Ctrl+T: new sub-tab inside the active group (kept)
  if (e.ctrlKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    if (hasApi('createTab')) window.api.createTab(activeGroupId || 'default');
    else warnMissingApi('createTab');
  }
  // Ctrl+G or Alt+T: new profile group
  if ((e.ctrlKey && !e.altKey && (e.key === 'g' || e.key === 'G')) ||
      (e.altKey && !e.ctrlKey && (e.key === 't' || e.key === 'T'))) {
    e.preventDefault();
    handleNewGroup();
  }
  // Ctrl+W: close sub-tab (kept); if the group ends up empty, its group closes too
  if (e.ctrlKey && (e.key === 'w' || e.key === 'W')) {
    e.preventDefault();
    if (currentTabId) handleCloseTab(currentTabId);
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

// --- New Tab / New Group ---
$newTabBtn.addEventListener('click', () => {
  // New sub-tab is always created inside the active group.
  if (hasApi('createTab')) window.api.createTab(activeGroupId || 'default');
  else warnMissingApi('createTab');
});
if ($newGroupBtn) $newGroupBtn.addEventListener('click', handleNewGroup);

// --- IPC Event Listeners ---
// Guarded: the main-process lane may not have wired group:* yet.
function subscribeEvent(name, fn) {
  try {
    if (window.api && typeof window.api.on === 'function') window.api.on(name, fn);
  } catch (e) { console.warn(`[renderer] subscribe ${name} failed:`, e); }
}
subscribeEvent('tab:created', async (data) => {
  if (data && data.groupId && activeGroupId && data.groupId !== activeGroupId) {
    // A tab for another group — still refresh counts.
    scheduleRefreshAll();
    return;
  }
  scheduleRefreshAll();
});

subscribeEvent('tab:closed', async (data) => {
  const tabs = await window.api.listTabs();
  renderTabs(tabs);
  if (tabs.length === 0) {
    updateUrlBar('', '');
    $statusProfile.textContent = 'Profile: -';
  }
  scheduleRefreshAll();
});

subscribeEvent('tab:activated', async (data) => {
  if (data && data.groupId) activeGroupId = data.groupId;
  else if (data && data.tabId) {
    const t = allTabs.find((x) => x.id === data.tabId);
    if (t && t.groupId) activeGroupId = t.groupId;
  }
  currentTabId = data.tabId;
  updateUrlBar(data.url, data.title);
  updateStatusProfile(data.profileName || data.profileId);
  syncPanelToTab(data.tabId, data.title);
  const tabs = await window.api.listTabs();
  renderTabs(tabs);
  renderGroups();
  updateFpIndicator();
});

subscribeEvent('tab:title-updated', async (data) => {
  if (data.tabId === currentTabId) {
    document.title = data.title ? `${data.title} - Electron FP Browser` : 'Electron FP Browser';
  }
  const tabs = await window.api.listTabs();
  renderTabs(tabs);
});

subscribeEvent('tab:navigated', async (data) => {
  if (data.tabId === currentTabId) {
    $urlInput.value = data.url || '';
  }
});

// When a tab's fingerprint profile is switched at runtime, refresh the panel
subscribeEvent('tab:profile-changed', async (data) => {
  if (!data || data.tabId === currentTabId || (data.groupId && data.groupId === activeGroupId)) {
    updateStatusProfile(data.profileName || data.profileId);
    await loadCurrentFingerprint();
  }
});

// Group events (payloads carry groupId): any change re-syncs both rows + panel.
subscribeEvent('group:created', async () => { scheduleRefreshAll(); });
subscribeEvent('group:closed', async () => { scheduleRefreshAll(); });
subscribeEvent('group:activated', async (data) => {
  if (data) activeGroupId = (typeof data === 'string') ? data : (data.groupId || data.id || activeGroupId);
  await refreshAll();
});
subscribeEvent('group:profile-changed', async (data) => {
  if (!data || !data.groupId || data.groupId === activeGroupId) {
    updateStatusProfile(data && (data.profileName || data.profileId));
    await loadCurrentFingerprint();
  }
});

// --- Self-test ---
//
// Runs the shared probe inside the live tab and renders a row per surface.
//
// The verdict wording matters: `skip` means "you did not configure this, so
// there is nothing to check", NOT "this passed". Rendering skips as successes
// would turn a default profile into a wall of green and hide the failures -
// which is the exact opposite of what a self-test is for.
let lastSelfTest = null;

function setSelfTestTab(which) {
  const isConfig = which === 'config';
  $fpPaneConfig.hidden = !isConfig;
  $fpPaneSelfTest.hidden = isConfig;
  $fpTabConfig.classList.toggle('fp-tab-active', isConfig);
  $fpTabSelfTest.classList.toggle('fp-tab-active', !isConfig);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderSelfTest(result) {
  if (result.error) {
    $fpSelfTestSummary.textContent = 'error';
    $fpSelfTestResults.innerHTML =
      '<div class="fp-selftest-error">' + escapeHtml(result.error) + '</div>';
    return;
  }

  // Two planes, one list. The TLS rows come from a ClientHello captured in the
  // main process (the page cannot see its own handshake), so they arrive in a
  // separate array - but they are the user's fingerprints too and belong in the
  // same verdict list, not in a corner the eye skips.
  const rows = (result.rows || []).concat(result.tlsRows || []);
  const s = result.summary || {};
  const ts = result.tlsSummary || {};
  const sum = (f) => (s[f] || 0) + (ts[f] || 0);
  $fpSelfTestSummary.innerHTML =
    '<span class="fp-badge fp-badge-pass">' + sum('pass') + ' pass</span> ' +
    '<span class="fp-badge fp-badge-fail">' + sum('fail') + ' fail</span> ' +
    '<span class="fp-badge fp-badge-unknown">' + sum('unknown') + ' unknown</span> ' +
    '<span class="fp-badge fp-badge-skip">' + sum('skip') + ' skip</span> ' +
    '<span class="fp-badge fp-badge-error">' + sum('error') + ' error</span>';

  // A TLS capture failure is shown even when the page probe succeeded. Hiding
  // it behind "N pass" would let a user read the pane as fully verified.
  const tlsError = result.tlsError
    ? '<div class="fp-selftest-error">TLS: ' + escapeHtml(result.tlsError) + '</div>'
    : '';

  const showSkipped = $fpSelfTestShowSkipped.checked;
  const visible = showSkipped ? rows : rows.filter((r) => r.verdict !== 'skip');

  if (!visible.length) {
    $fpSelfTestResults.innerHTML = tlsError + (showSkipped
      ? '<div class="fp-selftest-empty">No surfaces probed.</div>'
      : '<div class="fp-selftest-empty">No configured surfaces to check. ' +
        'Set some fingerprint keys, or tick "Show skipped surfaces".</div>');
    return;
  }

  // Group by the schema's functional groups, same as the Config pane, so a
  // failure reads in context (a webgl_* row sits with the other webgl_* rows)
  // instead of in an undifferentiated alphabetical list.
  //
  // Within a group, failures first: the pane exists to surface what is wrong.
  // unknown sorts between error and pass: it is not a failure, but it is not
  // confirmed either, so it must not sink below surfaces that genuinely passed.
  const order = { fail: 0, error: 1, unknown: 2, pass: 3, skip: 4 };
  // Same shape the Config pane uses: schema.keys[k].group === group.id.
  const groupsById = new Map();
  for (const g of ((fpSchema && fpSchema.groups) || [])) {
    groupsById.set(g.id, g.label || g.id);
  }
  // TLS groups too, so a TLS row lands under its own heading rather than
  // falling through to "Other" - which is where anything unrecognised goes and
  // where a reader would not think to look for it.
  for (const g of (((fpSchema && fpSchema.tls) ? fpSchema.tls.groups : []) || [])) {
    groupsById.set(g.id, g.label || g.id);
  }
  const buckets = new Map();
  for (const r of visible) {
    const meta = keyMeta(fpSchema || {}, r.key);
    const gid = (meta && meta.group && groupsById.has(meta.group))
      ? meta.group : 'other';
    if (!buckets.has(gid)) {
      buckets.set(gid, { label: groupsById.get(gid) || 'Other', rows: [] });
    }
    buckets.get(gid).rows.push(r);
  }
  for (const b of buckets.values()) {
    b.rows.sort((a, b2) =>
      (order[a.verdict] ?? 9) - (order[b2.verdict] ?? 9) ||
      a.key.localeCompare(b2.key));
  }
  const order2 = [...buckets.values()].sort((a, b) => {
    const aw = Math.min(...a.rows.map((r) => order[r.verdict] ?? 9));
    const bw = Math.min(...b.rows.map((r) => order[r.verdict] ?? 9));
    return aw - bw || a.label.localeCompare(b.label);
  });

  const renderRow = (r) => {
    const badge = '<span class="fp-badge fp-badge-' + r.verdict + '">' +
      r.verdict + '</span>';
    const detail = (r.verdict === 'skip' || r.verdict === 'unknown')
      ? '<span class="fp-st-reason">' + escapeHtml(r.reason || '') + '</span>'
      : '<span class="fp-st-expected">' + escapeHtml(r.expected) + '</span>' +
        '<span class="fp-st-arrow">&rarr;</span>' +
        '<span class="fp-st-got">' + escapeHtml(r.got) + '</span>';
    const hint = (r.verdict === 'fail' || r.verdict === 'error' ||
                  r.verdict === 'unknown') && r.reason
      ? '<div class="fp-st-hint">' + escapeHtml(r.reason) + '</div>'
      : '';
    return '<div class="fp-st-row fp-st-' + r.verdict + '">' +
      '<div class="fp-st-line">' + badge +
      '<span class="fp-st-key">' + escapeHtml(r.key) + '</span>' +
      detail + '</div>' + hint + '</div>';
  };

  const html = order2.map((b) => {
    const worst = Math.min(...b.rows.map((r) => order[r.verdict] ?? 9));
    const worstName = Object.keys(order).find((k) => order[k] === worst) || 'skip';
    return '<div class="fp-st-group">' +
      '<div class="fp-st-group-head">' +
      '<span class="fp-badge fp-badge-' + worstName + '">' + worstName + '</span>' +
      escapeHtml(b.label) +
      '<span class="fp-st-group-count">' + b.rows.length + '</span>' +
      '</div>' + b.rows.map(renderRow).join('') + '</div>';
  }).join('');

  $fpSelfTestResults.innerHTML = tlsError + html;
}

async function runSelfTest() {
  const tid = targetTabId();
  if (!tid) {
    $fpSelfTestSummary.textContent = 'no active tab';
    return;
  }
  $fpSelfTestRun.disabled = true;
  $fpSelfTestSummary.textContent = 'running…';
  $fpSelfTestResults.innerHTML = '<div class="fp-selftest-empty">Probing…</div>';
  try {
    const result = await window.api.runSelfTest(tid);
    lastSelfTest = result;
    renderSelfTest(result);
  } catch (e) {
    $fpSelfTestSummary.textContent = 'error';
    $fpSelfTestResults.innerHTML =
      '<div class="fp-selftest-error">' + escapeHtml(String(e && e.message || e)) + '</div>';
  } finally {
    $fpSelfTestRun.disabled = false;
  }
}

// --- Init ---
async function init() {
  const versions = await window.api.getVersions();
  $statusVersion.textContent = `Electron ${versions.electron} / Chrome ${versions.chrome}`;

  // Prefer the group-aware refresh; fall back to tabs-only on old main.
  if (hasApi('listGroups')) {
    await refreshAll();
    if (!groups.length && hasApi('createGroup')) {
      try { await window.api.createGroup('default'); } catch (e) { /* noop */ }
      await refreshAll();
    }
  } else {
    const tabs = await window.api.listTabs();
    renderTabs(tabs);

    if (tabs.length > 0) {
      const active = tabs.find(t => t.isActive) || tabs[0];
      currentTabId = active.id;
      updateUrlBar(active.url, active.title);
      updateStatusProfile(active.profileName || active.profileId);
    }
  }

  // Open the fingerprint sidebar by default and load the active tab's config
  setPanelState(true);
  await loadUaPresets();
  await loadCurrentUserAgent();
  await renderFpGroups();
  setSelfTestTab('config');
}

// --- Self-test pane wiring ---
$fpTabConfig.addEventListener('click', () => setSelfTestTab('config'));
$fpTabSelfTest.addEventListener('click', () => setSelfTestTab('selftest'));
$fpSelfTestRun.addEventListener('click', runSelfTest);
$fpSelfTestShowSkipped.addEventListener('change', () => {
  if (lastSelfTest) renderSelfTest(lastSelfTest);
});

init();
