'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge: the address bar sends a URL to the main process.
contextBridge.exposeInMainWorld('mini', {
  navigate: (url) => ipcRenderer.send('nav', url),
});
