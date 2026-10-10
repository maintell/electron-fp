// ponytail: real-webContents wiring over mock-tested core; unit logic stays in runtime/ (mock-tested), this file is thin composition + real smoke below.
// NOTE: this module only ever runs inside Electron (it receives a live webContents).
// It needs no 'electron' APIs itself — only the injected webContents object — so there
// is deliberately no require('electron') here at all. Keep it that way; thin stays thin.
'use strict';

const { createBrowserSession } = require('../runtime/browser-session');
const { createInputAdapter } = require('../runtime/input-adapter');
const { createRng } = require('../runtime/seeded-rng');

function createElectronSession({ webContents, profileId = 'probe', audit, broker } = {}) {
  if (!webContents) throw new Error('webContents required');
  // When a broker is injected, join the shared single attach instead of create+attach (doc 17 B);
  // the handle is session-like (sendCommand/getState/input) so downstream code is unchanged.
  const shared = broker && typeof broker.acquire === 'function';
  const handle = shared ? broker.acquire({ webContents, consumer: 'glue:' + profileId }) : null;
  const session = shared ? handle : createBrowserSession({ webContents, audit });
  const rng = createRng('electron:' + profileId);
  const adapter = createInputAdapter({
    send: (ev) => webContents.sendInputEvent(ev),
    dispatch: (m, p) => session.sendCommand(m, p),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rng,
  });
  const api = {
    session,
    adapter,
    rng,
    async start() {
      if (shared) {
        await handle.ready();
        return this;
      }
      session.markReady();
      await session.attach();
      return this;
    },
    async screenshot() {
      const res = await session.sendCommand('Page.captureScreenshot', {});
      const data = res && res.data;
      if (!data) throw new Error('empty screenshot');
      const rec = { ts: Date.now(), bytes: Buffer.from(data, 'base64').length };
      this.artifacts = this.artifacts || [];
      this.artifacts.push(rec);
      return { data, bytes: rec.bytes };
    },
    async stop() {
      if (shared) {
        try {
          await handle.release();
        } catch (_) {}
        return;
      }
      try {
        await session.detach();
      } catch (_) {}
    },
  };
  return api;
}

async function restartSession(api, createWindow, { profileId, audit, broker } = {}) {
  if (!api || !api.session) throw new Error('api required');
  if (typeof createWindow !== 'function') throw new Error('createWindow required');
  const pid = (api && api.profileId) || profileId || 'probe';
  const ad = (api && api.audit) || audit;
  await api.stop();
  // Caller parks the owning window on api._win; without it we skip destroy
  // (the old webContents simply detaches) — no hidden global window tracking here.
  if (api._win && !api._win.isDestroyed()) {
    try {
      api._win.destroy();
    } catch (_) {}
  }
  const win = await createWindow();
  const next = createElectronSession({ webContents: win.webContents, profileId: pid, audit: ad, broker });
  next._win = win;
  await next.start();
  return next;
}

module.exports = { createElectronSession, restartSession };
