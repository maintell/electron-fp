// ponytail: Electron-side control plane for the live recorder — owns the session/driver/recorder
// per recording session and exposes a live-object-free summary. Session map is in-process only.
'use strict';

const crypto = require('crypto');
const { createElectronSession } = require('./glue');
const { createPageDriver } = require('./page');
const { createLiveRecorder } = require('./recorder');

function notFound(message) {
  const e = new Error(message);
  e.name = 'ProfileError';
  e.code = 'NOT_FOUND';
  return e;
}

// bounded wait for a committed load (page.js precondition for debugger attach)
function waitForLoad(wc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        wc.removeListener('did-finish-load', done);
      } catch (_) {}
      resolve();
    };
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        wc.removeListener('did-finish-load', done);
      } catch (_) {}
      reject(new Error('webContents load timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    try {
      if (typeof wc.isLoading === 'function' && !wc.isLoading() && wc.getURL && wc.getURL() !== '') return done();
      wc.once('did-finish-load', done);
    } catch (e) {
      clearTimeout(t);
      reject(e);
    }
  });
}

function createRecorderController({ resolveWebContents, createWindow, rng, audit, now, broker } = {}) {
  const auditFn = typeof audit === 'function' ? audit : () => {};
  const sessions = new Map();

  function summary(entry) {
    return {
      sessionId: entry.sessionId,
      profileId: entry.profileId,
      url: entry.url,
      nodes: entry.recorder.nodes.length, // count, not live node objects
    };
  }

  async function start(opts = {}) {
    const profileId = opts && opts.profileId;
    const url = opts && opts.url;
    const resolved = typeof resolveWebContents === 'function' ? resolveWebContents({ profileId, url }) : undefined;
    if (!resolved || !resolved.webContents) {
      throw notFound('no live target for recorder' + (profileId ? ' profile: ' + profileId : ''));
    }
    const wc = resolved.webContents;
    if (url) await waitForLoad(wc, 15000);

    const session = createElectronSession({ webContents: wc, profileId: profileId || 'recorder', audit: auditFn, broker });
    await session.start();
    const driver = createPageDriver({ webContents: wc, session: session.session, adapter: session.adapter, rng: session.rng });
    const recorder = createLiveRecorder({
      session: session.session,
      page: driver,
      driver,
      rng: rng || session.rng,
      audit: auditFn,
      now,
      webContents: wc,
    });
    await recorder.start();

    const sessionId = crypto.randomUUID();
    const recUrl = url || (typeof wc.getURL === 'function' ? wc.getURL() : undefined);
    const entry = {
      sessionId,
      profileId: profileId || null,
      url: recUrl,
      recorder,
      session,
      driver,
      cleanup: resolved.cleanup,
    };
    sessions.set(sessionId, entry);
    auditFn({ type: 'recorder-session-start', sessionId, profileId: entry.profileId, url: recUrl });
    return { sessionId, url: recUrl };
  }

  async function drain(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) throw notFound('recorder session not found: ' + sessionId);
    const nodes = await entry.recorder.drain();
    return { nodes, count: nodes.length };
  }

  async function stop(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) throw notFound('recorder session not found: ' + sessionId);
    const ast = await entry.recorder.stop();
    try {
      if (entry.session && typeof entry.session.stop === 'function') await entry.session.stop();
    } catch (_) {}
    try {
      if (typeof entry.cleanup === 'function') entry.cleanup();
    } catch (_) {}
    sessions.delete(sessionId);
    auditFn({ type: 'recorder-session-stop', sessionId });
    return { ast };
  }

  function state(sessionId) {
    if (sessionId !== undefined && sessionId !== null) {
      const entry = sessions.get(sessionId);
      if (!entry) throw notFound('recorder session not found: ' + sessionId);
      return { active: true, sessions: [summary(entry)], nodes: entry.recorder.nodes.length };
    }
    const list = [...sessions.values()].map(summary);
    return {
      active: sessions.size > 0,
      sessions: list,
      nodes: list.reduce((n, s) => n + s.nodes, 0),
    };
  }

  return { start, drain, stop, state };
}

module.exports = { createRecorderController };
