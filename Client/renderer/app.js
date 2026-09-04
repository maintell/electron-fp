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
  const ok = await window.api.setUserAgent(currentTabId, ua);
  await window.api.setFingerprint(currentTabId, tryParseJson($fpJsonEditor.value), ua);
  $fpStatus.textContent = ok ? 'UA applied' : 'Failed to apply UA';
  await renderFpGroups();
  setTimeout(() => { $fpStatus.textContent = ''; }, 2000);
});

$fpUaReset.addEventListener('click', async () => {
  if (!currentTabId) return;
  // Resetting the UA means there is nothing to stay consistent with, so drop
  // navigator_platform too rather than leaving a MacIntel override behind.
  const cfg = tryParseJson($fpJsonEditor.value) || {};
  delete cfg.navigator_platform;
  $fpJsonEditor.value = JSON.stringify(cfg, null, 2);
  await window.api.setUserAgent(currentTabId, '');
  await window.api.setFingerprint(currentTabId, cfg, '');
  $fpUaInput.value = '';
  $fpStatus.textContent = 'UA reset to native';
  await renderFpGroups();
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
    // undefined => keep the tab's current UA, so editing the 60 kernel keys
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

  const rows = result.rows || [];
  const s = result.summary || {};
  // All four verdicts, including error. The summary originally showed only
  // pass/fail/skip, so a probe that threw produced a summary reading
  // "0 pass 0 fail 0 skip" with no indication that anything went wrong.
  $fpSelfTestSummary.innerHTML =
    '<span class="fp-badge fp-badge-pass">' + (s.pass || 0) + ' pass</span> ' +
    '<span class="fp-badge fp-badge-fail">' + (s.fail || 0) + ' fail</span> ' +
    '<span class="fp-badge fp-badge-unknown">' + (s.unknown || 0) + ' unknown</span> ' +
    '<span class="fp-badge fp-badge-skip">' + (s.skip || 0) + ' skip</span> ' +
    '<span class="fp-badge fp-badge-error">' + (s.error || 0) + ' error</span>';

  const showSkipped = $fpSelfTestShowSkipped.checked;
  const visible = showSkipped ? rows : rows.filter((r) => r.verdict !== 'skip');

  if (!visible.length) {
    $fpSelfTestResults.innerHTML = showSkipped
      ? '<div class="fp-selftest-empty">No surfaces probed.</div>'
      : '<div class="fp-selftest-empty">No configured surfaces to check. ' +
        'Set some fingerprint keys, or tick "Show skipped surfaces".</div>';
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
  const buckets = new Map();
  for (const r of visible) {
    const meta = fpSchema && fpSchema.keys && fpSchema.keys[r.key];
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

  $fpSelfTestResults.innerHTML = html;
}

async function runSelfTest() {
  if (!currentTabId) {
    $fpSelfTestSummary.textContent = 'no active tab';
    return;
  }
  $fpSelfTestRun.disabled = true;
  $fpSelfTestSummary.textContent = 'running…';
  $fpSelfTestResults.innerHTML = '<div class="fp-selftest-empty">Probing…</div>';
  try {
    const result = await window.api.runSelfTest(currentTabId);
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
