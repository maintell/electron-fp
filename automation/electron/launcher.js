// ponytail: thin real-BrowserWindow launcher over an injected createWindow(partition) — same
// composition pattern as glue.js. No require('electron') here: only the injected window's own
// objects/methods are touched, so the module stays mock-testable outside Electron. It only ever
// runs for real inside Electron (the caller supplies the real window factory).
'use strict';

function createElectronLauncher({ createWindow, audit, broker } = {}) {
  if (typeof createWindow !== 'function') throw new Error('createWindow required');
  const auditFn = typeof audit === 'function' ? audit : () => {};
  const handles = new Map(); // profileId -> { window, webContents, electronSession }
  const held = new Map(); // profileId -> attach-broker handle (P2 lifetime hold), when broker is wired
  const useBroker = !!(broker && typeof broker.acquire === 'function');

  function waitLoaded(win) {
    return new Promise((resolve) => {
      const wc = win.webContents;
      if (typeof wc.isLoading === 'function' && !wc.isLoading() && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000); // bounded — hidden windows still emit did-finish-load for about:blank
    });
  }

  async function start(profile) {
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || profile.id === '') {
      throw new Error('launcher.start requires profile.id');
    }
    const id = profile.id;
    if (handles.has(id)) throw new Error('CONFLICT: profile already launched: ' + id);
    const partition = profile.partition || 'persist:auto-' + id;
    // current-architecture lesson: bare in-memory partition names silently lose cookies/storage
    // on every relaunch — never allow them here.
    if (typeof partition !== 'string' || !partition.startsWith('persist:')) {
      throw new Error('partition must be persistent ("persist:auto-<id>" or "persist:<name>"): ' + String(partition));
    }
    let win;
    try {
      win = await createWindow(partition);
      const wc = win.webContents;
      if (!wc.getURL() && !(typeof wc.isLoading === 'function' && wc.isLoading())) {
        await win.loadURL('about:blank'); // resolves at did-finish-load
      }
      await waitLoaded(win); // no-op if the awaited loadURL already finished / window preloading
    } catch (e) {
      if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch (_) {}
      }
      throw e;
    }
    const entry = { window: win, webContents: win.webContents, electronSession: win.webContents.session };
    // P2 lifetime hold: with a broker wired, acquire ONE shared attach for the profile's
    // lifetime so per-run executor acquires reuse it (no attach churn between runs).
    if (useBroker) {
      try {
        const handle = broker.acquire({ webContents: entry.webContents, consumer: 'launcher:' + id });
        await handle.ready();
        held.set(id, handle);
      } catch (e) {
        try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
        throw e;
      }
    }
    handles.set(id, entry);
    auditFn({ type: 'launcher-start', profileId: id, partition });
    return { inProcess: true }; // plain JSON-safe marker — never hand live handles to callers that persist
  }

  function acquire(profileId) {
    const h = handles.get(profileId);
    if (!h || !h.window || h.window.isDestroyed()) return undefined;
    return h;
  }

  async function stop(profileId) {
    const h = handles.get(profileId);
    if (!h) return; // double-stop is a no-op
    handles.delete(profileId);
    const handle = held.get(profileId);
    held.delete(profileId);
    if (handle) {
      try { await handle.release(); } catch (_) {} // release the lifetime hold before destroying the window
    }
    auditFn({ type: 'launcher-stop', profileId });
    if (h.window && !h.window.isDestroyed()) {
      try { h.window.destroy(); } catch (_) {}
    }
  }

  function list() {
    return Array.from(handles.keys()).filter((id) => {
      const h = handles.get(id);
      return h && h.window && !h.window.isDestroyed();
    });
  }

  return { start, acquire, stop, list };
}

module.exports = { createElectronLauncher };
