// ponytail: webContents.debugger glue over core.js; coarse Network/Runtime method filtering left to caller sessions
'use strict';

const { createSessionStateMachine, gateCdpMethod, createPendingMap } = require('./core');

const FP_EVAL_MARKERS = ['--fingerprint-config', 'FP_CONFIG_DATA', 'FP_CONFIG='];
const FP_CARRIER_RE = /--fingerprint-config=|FP_CONFIG_DATA|FP_CONFIG=|\bFP_[a-z][a-z0-9_]*/g;
// stale isolated-world context after cross-document navigation
const STALE_CONTEXT_RE = /cannot find context|context with specified id|execution context was destroyed/i;

function redactParams(params) {
  if (!params || typeof params !== 'object') return params;
  const out = Array.isArray(params) ? [] : {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    out[k] = typeof v === 'string' ? v.replace(FP_CARRIER_RE, '[scrubbed]') : v;
  }
  return out;
}

function createBrowserSession({ webContents, audit }) {
  const state = createSessionStateMachine();
  const pending = createPendingMap();
  let seq = 0;
  const dbg = webContents.debugger;
  let worldContextId = null;
  let worldSeq = 0;

  async function ensureIsolatedWorld() {
    if (worldContextId != null) return worldContextId;
    const worldName = 'fp-auto-' + ++worldSeq;
    // ponytail: try createIsolatedWorld WITHOUT frameId first (defaults to main
    // frame in most CDP versions); on error fall back to Page.getFrameTree -> frame.id -> retry once.
    let res;
    try {
      res = await dbg.sendCommand('Page.createIsolatedWorld', { worldName });
    } catch (e) {
      const tree = await dbg.sendCommand('Page.getFrameTree', {});
      const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
      res = await dbg.sendCommand('Page.createIsolatedWorld', { frameId, worldName });
    }
    worldContextId = res.executionContextId != null ? res.executionContextId : res.contextId;
    return worldContextId;
  }

  dbg.on('message', (_e, method) => {
    if ((method === 'Inspector.targetCrashed' || method === 'targetCrashed') && state.getState() === 'attached') {
      state.transition('crashed');
    } else if (
      method === 'Page.frameNavigated' ||
      method === 'Runtime.executionContextsCleared' ||
      method === 'Runtime.executionContextDestroyed'
    ) {
      // navigation destroyed the old document's isolated world; next eval recreates it.
      worldContextId = null;
    }
  });
  dbg.on('detach', () => {
    if (state.getState() === 'attached') state.transition('crashed');
  });

  function markReady() {
    // caller finished view creation; bootstrap created→starting if needed
    if (state.getState() === 'created') state.transition('starting');
    if (state.getState() === 'starting') {
      state.transition('ready');
      return;
    }
    throw new Error('illegal transition: markReady from ' + state.getState());
  }

  async function attach(version = '1.1') {
    if (!state.canTransition('attached')) {
      throw new Error('illegal transition: ' + state.getState() + '->attached');
    }
    await dbg.attach(version);
    state.transition('attached');
  }

  async function sendCommand(method, params = {}) {
    if (state.getState() !== 'attached') throw new Error('not attached');
    if (!gateCdpMethod(method)) {
      if (typeof audit === 'function') audit({ type: 'cdp-deny', method });
      throw new Error('cdp method denied: ' + method);
    }
    params = params || {};
    if (
      (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') &&
      typeof params.expression === 'string' &&
      FP_EVAL_MARKERS.some((m) => params.expression.includes(m))
    ) {
      if (typeof audit === 'function') audit({ type: 'cdp-deny', method, reason: 'fp carrier scrub' });
      throw new Error('fp carrier scrub');
    }
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
      let world = 'isolated';
      if (params.__world === 'main') {
        world = 'main';
        const { __world, ...rest } = params;
        params = rest;
        if (typeof audit === 'function') audit({ type: 'cdp-main-world', method });
      } else {
        const { __world, ...rest } = params;
        params = { ...rest, contextId: await ensureIsolatedWorld() };
      }
      if (typeof audit === 'function') audit({ type: 'cdp-call', method, world });
      const id = ++seq;
      pending.add(id);
      try {
        return await dbg.sendCommand(method, redactParams(params));
      } catch (e) {
        // Cached isolated context died with the old document. Event-based invalidation is
        // best-effort (Page/Runtime domains may not be enabled), so self-heal: recreate
        // once, patch contextId, retry once. Other errors surface unchanged.
        if (world !== 'isolated' || !STALE_CONTEXT_RE.test(String((e && e.message) || e))) throw e;
        worldContextId = null;
        params = { ...params, contextId: await ensureIsolatedWorld() };
        return dbg.sendCommand(method, redactParams(params));
      } finally {
        pending.resolve(id);
      }
    }
    if (typeof audit === 'function') audit({ type: 'cdp-call', method });
    const id = ++seq;
    pending.add(id);
    return dbg.sendCommand(method, redactParams(params)).finally(() => {
      pending.resolve(id);
    });
  }

  async function detach() {
    // CDP has no destroy-world; isolated world dies with target. Best-effort detach only.
    const s = state.getState();
    if (s === 'closed') return;
    if (s === 'attached') {
      state.transition('detaching');
      await dbg.detach();
      state.transition('closed');
      return;
    }
    if (s === 'ready') {
      state.transition('detaching');
      state.transition('closed');
      return;
    }
    if (state.canTransition('closed')) {
      state.transition('closed');
      return;
    }
    throw new Error('illegal transition: detach from ' + s);
  }

  function recover() {
    if (state.getState() !== 'crashed') {
      throw new Error('illegal transition: recover from ' + state.getState());
    }
    state.transition('ready');
  }

  // ponytail: adapter-first policy lives in input-adapter; this is the send transport.
  function inputSend(event) {
    if (!webContents || typeof webContents.sendInputEvent !== 'function') {
      throw new Error('NO_SEND_BACKEND');
    }
    const out = webContents.sendInputEvent(event);
    if (typeof audit === 'function') audit({ type: 'input-event', backend: 'send' });
    return out;
  }

  return {
    markReady,
    attach,
    sendCommand,
    detach,
    close: detach,
    recover,
    getState: state.getState,
    input: { send: inputSend },
  };
}

module.exports = { createBrowserSession };
