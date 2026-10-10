'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, minimal API to the renderer process.
// All operations go through IPC — no direct Node.js access.
contextBridge.exposeInMainWorld('api', {
  // Group operations (top-level tab = isolated profile browser)
  createGroup: (profileId) => ipcRenderer.invoke('group:create', profileId),
  closeGroup: (groupId) => ipcRenderer.invoke('group:close', groupId),
  activateGroup: (groupId) => ipcRenderer.invoke('group:activate', groupId),
  listGroups: () => ipcRenderer.invoke('group:list'),
  getActiveGroup: () => ipcRenderer.invoke('group:get-active'),
  setGroupProfile: (groupId, config, userAgent) => ipcRenderer.invoke('group:set-profile', { groupId, config, userAgent }),

  // Group proxy (single profile per group).
  // setGroupProxy semantics for the UI: a full proxy URL may be pasted with
  // mode left on direct/system — main auto-upgrades to fixed (pacScript to
  // pac) and says so in result.note. Empty password KEEPS the stored one;
  // only bare direct + empty rules clears the proxy AND deletes the saved
  // password. getGroupProxy never returns the password (hasPassword only).
  getGroupProxy: (groupId) => ipcRenderer.invoke('group:get-proxy', groupId),
  setGroupProxy: (groupId, proxy) => ipcRenderer.invoke('group:set-proxy', { groupId, proxy }),

  // Tab operations (sub-tab inside a group; groupId shares the session)
  createTab: (arg) => ipcRenderer.invoke('tab:create', arg),
  closeTab: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  activateTab: (tabId) => ipcRenderer.invoke('tab:activate', tabId),
  navigateTab: (tabId, url) => ipcRenderer.invoke('tab:navigate', { tabId, url }),
  listTabs: () => ipcRenderer.invoke('tab:list'),
  getActiveTab: () => ipcRenderer.invoke('tab:get-active'),
  toggleDevtools: (tabId) => ipcRenderer.invoke('tab:toggle-devtools', tabId),

  // Fingerprint per-tab
  getFingerprint: (tabId) => ipcRenderer.invoke('tab:get-fingerprint', tabId),
  setFingerprint: (tabId, config, userAgent) => ipcRenderer.invoke('tab:set-fingerprint', { tabId, config, userAgent }),

  // Self-test: runs the shared probe (Client/fp-probe.js, the same one
  // fingerprint/scripts/smoke.js uses) inside the live tab and compares each
  // surface against that tab's own config.
  runSelfTest: (tabId) => ipcRenderer.invoke('selftest:run', tabId),

  // User-Agent per-tab (Electron-level surface, not one of the kernel's 63 keys)
  getUserAgent: (tabId) => ipcRenderer.invoke('tab:get-ua', tabId),
  setUserAgent: (tabId, userAgent) => ipcRenderer.invoke('tab:set-ua', { tabId, userAgent }),
  listUaPresets: () => ipcRenderer.invoke('ua:presets'),
  // Resolved in the main process so the UA->platform mapping has one copy.
  platformForUserAgent: (ua) => ipcRenderer.invoke('ua:platform-for', ua),

  // Fingerprint panel open/close
  setPanelOpen: (isOpen) => ipcRenderer.invoke('panel:set-open', isOpen),

  // Profiles
  listProfiles: () => ipcRenderer.invoke('profile:list'),
  getProfile: (id) => ipcRenderer.invoke('profile:get', id),
  createProfile: (profile) => ipcRenderer.invoke('profile:create', profile),
  updateProfile: (profile) => ipcRenderer.invoke('profile:update', profile),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  randomizeProfile: () => ipcRenderer.invoke('profile:randomize'),

  // AI agent (main-process run loop; progress via on('agent:event'))
  agentStart: (goal) => ipcRenderer.invoke('agent:start', { goal }),
  agentStop: () => ipcRenderer.invoke('agent:stop'),
  agentGetConfig: () => ipcRenderer.invoke('agent:config:get'),
  agentSetConfig: (cfg) => ipcRenderer.invoke('agent:config:set', cfg),
  agentApprove: (runId, approved) => ipcRenderer.invoke('agent:approve', { runId, approved }),

  // App info
  getVersions: () => ipcRenderer.invoke('app:versions'),
  // Fingerprint schema (63 keys in 15 functional groups) + coverage report
  getFpSchema: () => ipcRenderer.invoke('fp:schema'),
  getFpCoverage: (cfg) => ipcRenderer.invoke('fp:coverage', cfg),

  // Event listeners (main → renderer)
  on: (channel, callback) => {
    const validChannels = [
      'tab:created', 'tab:closed', 'tab:activated',
      'tab:title-updated', 'tab:navigated', 'tab:profile-changed',
      'group:created', 'group:closed', 'group:activated', 'group:profile-changed',
      'agent:event'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  }
});

// --- Automation bridge facade (mirrors Client/preload.js automationApi) -------
// The main process wires the bridge via wireAutomation() (main.js) ->
// automation/electron/wire.js attachAutomation. Least-privilege script create:
// MClient runs have no browser backend here, so pure scripts run and browser
// touches fail with a named PermissionError rather than a backend error.
async function autoCall(ch, ...args) {
  const res = await ipcRenderer.invoke(ch, ...args);
  if (res && res.ok === false) {
    const e = res.error || {};
    throw new Error((e.code ? e.code + ' ' : '') + (e.message || 'request failed'));
  }
  return res && res.ok === true ? res.data : res;
}
const automationApi = {
  status: () => autoCall('automation:status'),
  getScripts: () => autoCall('automation:scripts:list'),
  getScript: (id) => autoCall('automation:scripts:get', id),
  saveScript: async (d) => {
    if (d.id) {
      await autoCall('automation:scripts:update', d.id, { name: d.name });
      return autoCall('automation:scripts:saveVersion', d.id, d.code);
    }
    return autoCall('automation:scripts:create', {
      name: d.name,
      code: d.code,
      permissions: { browser: false, cookies: false, storage: false, network: false, filesystem: false, process: false },
      parameters: d.params || [],
    });
  },
  // profileContext.id is the target GROUP id: the run drives that group's live
  // active tab. Omitted => the 'mclient' sentinel (no group), which fails with a
  // named ProfileError rather than touching an arbitrary tab.
  runScript: (scriptId, values, profileContext) =>
    autoCall('automation:run', scriptId, { params: values || {}, profileContext: profileContext || { id: 'mclient' } }),
  stopScript: (execId) => autoCall('automation:executions:cancel', execId),
  getExecutions: (scriptId) => autoCall('automation:executions:list', { scriptId }),
  getExecution: (execId) => autoCall('automation:executions:get', execId),
  getLogs: (execId) => autoCall('automation:executions:logs', execId),
  templates: {
    list: () => autoCall('automation:templates:list'),
    install: () => autoCall('automation:templates:install'),
  },
  tasks: {
    list: (opts) => autoCall('automation:tasks:list', opts),
    get: (id) => autoCall('automation:tasks:get', id),
    enqueue: (spec) => autoCall('automation:tasks:enqueue', spec),
    cancel: (id) => autoCall('automation:tasks:cancel', id),
    pause: (id, opts) => autoCall('automation:tasks:pause', id, opts),
    resume: (id) => autoCall('automation:tasks:resume', id),
    retry: (id, opts) => autoCall('automation:tasks:retry', id, opts),
  },
  schedules: {
    list: (opts) => autoCall('automation:schedules:list', opts),
    add: (spec) => autoCall('automation:schedules:add', spec),
    remove: (id) => autoCall('automation:schedules:remove', id),
    pause: (id) => autoCall('automation:schedules:pause', id),
    resume: (id) => autoCall('automation:schedules:resume', id),
    trigger: (id) => autoCall('automation:schedules:trigger', id),
  },
  // Live RPA recorder control plane (§13): main-side Electron recorder sessions.
  // start opts = { profileId?, url? } (profileId = target group); drain/stop take
  // a sessionId. Parity with Client/preload.js automationApi.recorder.
  recorder: {
    start: (opts) => autoCall('automation:recorder:start', opts),
    drain: (sessionId) => autoCall('automation:recorder:drain', sessionId),
    stop: (sessionId) => autoCall('automation:recorder:stop', sessionId),
    state: (sessionId) => autoCall('automation:recorder:state', sessionId),
  },
  onEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('automation:event', h);
    return () => ipcRenderer.removeListener('automation:event', h);
  },
};
contextBridge.exposeInMainWorld('automationApi', automationApi);

// RPA visual builder bridge (window.rpaApi) — parity with Client/preload.js.
// profileContext.id is the target GROUP id (the run drives that group's tab).
contextBridge.exposeInMainWorld('rpaApi', {
  validate: (flow) => autoCall('automation:rpa:validate', flow),
  save: (flow) => autoCall('automation:rpa:save', flow),
  load: () => autoCall('automation:rpa:load'),
  replay: (flow, profileContext) => autoCall('automation:rpa:replay', flow, { profileContext }),
  subscribeLog: (key, cb) => automationApi.onEvent((ev) => { const l = (ev && ev.line) || {}; const text = Array.isArray(l.args) ? l.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') : String(l.args == null ? '' : l.args); cb({ ts: l.ts, level: l.level, text }); }),
  recorder: automationApi.recorder,
});
