'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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

  // User-Agent per-tab (Electron-level surface, not one of the kernel's 56 keys)
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
  // Fingerprint schema (56 keys in 14 functional groups) + coverage report
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
  }
});
