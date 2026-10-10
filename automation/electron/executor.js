// ponytail: launcher→script-runner bridge for one profile context. Manager calls runnerFactory()
// with no args, so context is bound by .for(ctx) and the live handle is acquired per run (fresh
// session after a launcher restart). Live handles that already carry a glue session/adapter/rng
// (superset of the shared {window, webContents, electronSession} contract) are reused as-is.
'use strict';

const { createBrowserSession } = require('../runtime/browser-session');
const { createAttachBroker } = require('../runtime/attach-broker');
const { createInputAdapter } = require('../runtime/input-adapter');
const { createRng } = require('../runtime/seeded-rng');
const { createScriptRunner, ProfileError } = require('../runtime/script-runner');
const { createPageDriver } = require('./page');
const { createBrowserApi } = require('./browser-api');

function createElectronExecutor({ launcher, createWindow, audit, timeoutMs = 30000, fences, broker } = {}) {
  if (!launcher || typeof launcher.acquire !== 'function') throw new Error('launcher.acquire required');
  void createWindow; // launcher owns window creation; param kept for wiring symmetry
  const attachBroker =
    broker && typeof broker.acquire === 'function'
      ? broker
      : createAttachBroker({ createSession: createBrowserSession, audit });

  function forContext(profileContext) {
    const ctx =
      profileContext && typeof profileContext.id === 'string' && profileContext.id
        ? profileContext
        : { id: 'ctx-unknown' };
    // launcher/profile lifecycle hold: one shared attach per context/webContents, reused across runs
    // (avoids run-to-run attach churn; doc 17 B.6).
    let held = null;

    return function runnerFactory() {
      const live = launcher.acquire(ctx.id);
      if (!live) throw new ProfileError('no live session for profile; launcher.start first');
      const wc = live.webContents;
      if (!wc) throw new ProfileError('live session for profile has no webContents: ' + ctx.id);

      let session = live.session;
      let adapter = live.adapter;
      let rng = live.rng;
      let ready = null;
      if (!session) {
        if (!held || held.wc !== wc) {
          held = { wc, handle: attachBroker.acquire({ webContents: wc, consumer: 'executor:' + ctx.id }) };
        }
        session = held.handle;
        ready = held.handle.ready(); // async CDP attach; gated on first run below
      }
      if (!rng) rng = createRng('electron:' + ctx.id);
      if (!adapter) {
        adapter = createInputAdapter({
          send: (ev) => wc.sendInputEvent(ev),
          dispatch: (m, p) => session.sendCommand(m, p),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          rng,
        });
      }

      const page = createPageDriver({ webContents: wc, session, adapter, rng });
      // upload/download fence: per-profile authorized dir (os.tmpdir/fp-<id> default);
      // host override via fences. Absent = fail-closed deny in browser-api.
      const os = require('os');
      const path = require('path');
      const fenceDirs =
        fences && Array.isArray(fences.dirs) && fences.dirs.length
          ? fences.dirs
          : [path.join(os.tmpdir(), 'fp-' + String(ctx.id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_'))];
      const browserApi = createBrowserApi({ page, adapter, electronSession: live.electronSession, profileContext: ctx, fences: { dirs: fenceDirs } });
      const runner = createScriptRunner({ browserApi, timeoutMs, audit });
      if (!ready) return runner;
      const run = runner.run;
      return Object.assign({}, runner, {
        run: (spec, params, opts) => Promise.resolve(ready).then(() => run.call(runner, spec, params, opts)),
      });
    };
  }

  return { for: forContext };
}

module.exports = { createElectronExecutor };
