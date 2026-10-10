'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Automation panel facade (renderer → main). Translates the panel's UI
// shape to the automation:* IPC channels (same Service envelopes as
// HTTP/CLI); envelopes unwrapped, errors thrown for panel banners.
// Statuses normalized to panel vocabulary (SUCCESS -> SUCCEEDED);
// subscribeLog intentionally absent — panel falls back to 1s poll,
// live lines arrive via onAutomationEvent below.
async function autoCall(ch, ...args) {
  const res = await ipcRenderer.invoke(ch, ...args);
  if (res && res.ok === false) {
    const e = res.error || {};
    throw new Error((e.code ? e.code + ' ' : '') + (e.message || 'request failed'));
  }
  return res && res.ok === true ? res.data : res;
}
function autoText(args) {
  return (Array.isArray(args) ? args : [args])
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}
function autoScriptShape(s) {
  const v0 = (s && s.versions && s.versions[0]) || {};
  return {
    id: s.id, name: s.name, code: v0.code || '',
    version: v0.version || 0, status: 'saved', folder: 'main',
    params: s.parameters || [], updatedAt: s.updatedAt,
  };
}
function autoExecShape(e) {
  return {
    id: e.executionId, scriptId: e.scriptId, scriptVersion: e.scriptVersion,
    profileId: e.profileId, startTime: e.startTime, endTime: e.endTime,
    duration: e.durationMs, status: e.status === 'SUCCESS' ? 'SUCCEEDED' : e.status,
    error: e.error, currentUrl: e.currentUrl, currentStep: e.currentStep,
    // failure-only captures (script-runner §41 #10); list rows and the detail pane
    artifacts: Array.isArray(e.artifacts) ? e.artifacts : null,
  };
}
const automationApi = {
  // store.list strips versions[].code (HTTP shape) — the panel edits code,
  // so hydrate each row with a full get (local IPC, script counts are small).
  getScripts: async () => {
    const rows = await autoCall('automation:scripts:list');
    const full = await Promise.all(rows.map((r) => autoCall('automation:scripts:get', r.id)));
    return full.map(autoScriptShape);
  },
  saveScript: async (d) => {
    if (d.id) {
      await autoCall('automation:scripts:update', d.id, { name: d.name });
      await autoCall('automation:scripts:saveVersion', d.id, d.code);
    } else {
      const created = await autoCall('automation:scripts:create', {
        // Least privilege: the panel has no permission UI and Client runs have
        // no browser backend — pure scripts run, browser touches fail with a
        // named PermissionError instead of a backend error. store.create would
        // otherwise merge DEFAULT_PERMISSIONS (browser:true) over {}.
        name: d.name, code: d.code,
        permissions: { browser: false, cookies: false, storage: false, network: false, filesystem: false, process: false },
        parameters: d.params || [],
      });
      d.id = created.id;
    }
    return autoScriptShape(await autoCall('automation:scripts:get', d.id));
  },
  runScript: async (scriptId, values) => {
    const rec = await autoCall('automation:run', scriptId, { params: values || {}, profileContext: { id: 'panel' } });
    return { executionId: rec.executionId };
  },
  stopScript: async (execId) => autoCall('automation:executions:cancel', execId),
  getExecutions: async (scriptId) => (await autoCall('automation:executions:list', { scriptId })).map(autoExecShape),
  // Single record — the only shape that carries artifacts (list mapping is
  // row-shaped); panel's Detail pane prefers it and falls back to the list.
  getExecution: async (execId) => autoExecShape(await autoCall('automation:executions:get', execId)),
  getLogs: async (execId, opts) => {
    const after = (opts && opts.afterSeq) || 0;
    const lines = await autoCall('automation:executions:logs', execId);
    return lines
      .map((l, i) => ({ seq: i + 1, ts: l.ts, level: l.level, text: autoText(l.args) }))
      .filter((l) => l.seq > after);
  },
  // Templates catalog (service templates.list/install; install is idempotent).
  // Consumed by the panel-templates.js fragment via panel.js mount.
  templates: {
    list: () => autoCall('automation:templates:list'),
    install: () => autoCall('automation:templates:install'),
  },
  // Live RPA recorder control plane (§13): main-side Electron recorder sessions.
  // start opts = { profileId?, url? }; drain/stop take a sessionId.
  recorder: {
    start: (opts) => autoCall('automation:recorder:start', opts),
    drain: (sessionId) => autoCall('automation:recorder:drain', sessionId),
    stop: (sessionId) => autoCall('automation:recorder:stop', sessionId),
    state: (sessionId) => autoCall('automation:recorder:state', sessionId),
  },
  // Task queue (§4.4). list opts = { status?, scriptId?, limit?, offset? };
  // pause takes { interrupt? } (interrupt aborts a RUNNING item when a worker
  // is attached — acceptance #7); retry = retryNow({ resetAttempts? }).
  tasks: {
    list: (opts) => autoCall('automation:tasks:list', opts),
    get: (id) => autoCall('automation:tasks:get', id),
    cancel: (id) => autoCall('automation:tasks:cancel', id),
    pause: (id, opts) => autoCall('automation:tasks:pause', id, opts),
    resume: (id) => autoCall('automation:tasks:resume', id),
    retry: (id, opts) => autoCall('automation:tasks:retry', id, opts),
    enqueue: (spec) => autoCall('automation:tasks:enqueue', spec),
  },
  // Schedules (§4.5). list opts = { enabled?, limit?, offset? }; add spec =
  // scheduler.md §2 ({ type, scriptId, profileContexts, atMs|everyMs|cron, … }).
  schedules: {
    list: (opts) => autoCall('automation:schedules:list', opts),
    add: (spec) => autoCall('automation:schedules:add', spec),
    pause: (id) => autoCall('automation:schedules:pause', id),
    resume: (id) => autoCall('automation:schedules:resume', id),
    trigger: (id) => autoCall('automation:schedules:trigger', id),
    remove: (id) => autoCall('automation:schedules:remove', id),
  },
  // Live-log subscription alias consumed by the RPA builder's subscribeLog.
  onEvent: onAutomationEvent,
};
function onAutomationEvent(callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on('automation:event', listener);
  return () => ipcRenderer.removeListener('automation:event', listener);
}

// Expose a safe, minimal API to the renderer process.
// All operations go through IPC — no direct Node.js access.
contextBridge.exposeInMainWorld('api', {
  // Tab operations
  createTab: (profileId) => ipcRenderer.invoke('tab:create', profileId),
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

  // App info
  getVersions: () => ipcRenderer.invoke('app:versions'),
  // Fingerprint schema (63 keys in 15 functional groups) + coverage report
  getFpSchema: () => ipcRenderer.invoke('fp:schema'),
  getFpCoverage: (cfg) => ipcRenderer.invoke('fp:coverage', cfg),

  // Event listeners (main → renderer)
  on: (channel, callback) => {
    const validChannels = [
      'tab:created', 'tab:closed', 'tab:activated',
      'tab:title-updated', 'tab:navigated', 'tab:profile-changed'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },

  // Automation live-log push (main → renderer). Main emits 'automation:event'
  // per log line when wired; panel filters by executionId. No-op until then.
  onAutomationEvent,
  automationApi,
});

// Panel contract lives at window.automationApi (panel.js reads it directly);
// window.api keeps the same reference for the invoke-only style.
contextBridge.exposeInMainWorld('automationApi', Object.assign({ onAutomationEvent }, automationApi));

// RPA visual builder bridge (window.rpaApi). rpa.js reads it directly on mount;
// absent = builder degrades to local editing with Save/Replay/Record disabled.
// recorder reuses automationApi.recorder (main-side Electron recorder sessions);
// subscribeLog reuses the automation:event push (panel filters by executionId).
contextBridge.exposeInMainWorld('rpaApi', {
  validate: (flow) => autoCall('automation:rpa:validate', flow),
  save: (flow) => autoCall('automation:rpa:save', flow),
  load: () => autoCall('automation:rpa:load'),
  replay: (flow, profileContext) => autoCall('automation:rpa:replay', flow, { profileContext }),
  subscribeLog: (key, cb) => automationApi.onEvent((ev) => { const l = (ev && ev.line) || {}; const text = Array.isArray(l.args) ? l.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') : String(l.args == null ? '' : l.args); cb({ ts: l.ts, level: l.level, text }); }),
  recorder: automationApi.recorder,
});
