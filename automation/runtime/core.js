// ponytail: BrowserSession state machine + CDP gate + pending map; Electron glue lives in browser-session.js
'use strict';

const STATES = ['created', 'starting', 'ready', 'attached', 'detaching', 'closed', 'crashed'];

// legal transitions per docs/automation/runtime.md §1.1
const TRANSITIONS = {
  created: ['starting'],
  starting: ['ready', 'crashed'],
  ready: ['attached', 'detaching', 'crashed'],
  attached: ['detaching', 'crashed'],
  detaching: ['closed', 'crashed'],
  closed: [],
  crashed: ['ready', 'closed'],
};

function createSessionStateMachine() {
  let state = 'created';
  return {
    getState: () => state,
    canTransition(to) {
      return STATES.includes(to) && TRANSITIONS[state].includes(to);
    },
    transition(to) {
      if (!this.canTransition(to)) {
        throw new Error('illegal transition: ' + state + '->' + to);
      }
      state = to;
    },
  };
}

const DENY_EXACT = new Set(['Browser.close', 'Target.createTarget']);
const DENY_PREFIX = ['SystemInfo.', 'FileSystem.', 'Target.closeTarget'];
const ALLOW_PREFIX = [
  // read-only browser-level introspection needed by external CDP clients to discover
  // and attach; control methods (Browser.close, Target.create/closeTarget, SystemInfo.*,
  // FileSystem.*) stay denied above/below.
  'Browser.getVersion',
  'Target.getTargets',
  'Page.',
  'DOM.',
  'Input.',
  'Network.',
  'Runtime.',
  'Target.attachToTarget',
  'Target.setAutoAttach',
  'Target.setDiscoverTargets',
  'Target.getBrowserContexts',
  'Storage.',
];

function gateCdpMethod(method) {
  if (typeof method !== 'string') return false;
  if (DENY_EXACT.has(method)) return false;
  if (DENY_PREFIX.some((p) => method.startsWith(p))) return false;
  // Network/Runtime are coarse-prefix gated here; method-level read/limited
  // filtering + FP scrub happen in the Electron glue (browser-session.js) —
  // ponytail: coarse gate now, refine if abuse seen.
  if (ALLOW_PREFIX.some((p) => method.startsWith(p))) return true;
  return false; // default deny
}

function createPendingMap() {
  const map = new Map();
  return {
    add(id) {
      if (map.has(id)) throw new Error('duplicate pending id: ' + id);
      map.set(id, { resolve: null, reject: null }); // glue attaches callbacks later if needed
    },
    resolve(id, value) {
      const entry = map.get(id);
      if (entry === undefined) return false;
      map.delete(id);
      if (entry && entry.resolve) entry.resolve(value);
      return true;
    },
    reject(id, err) {
      const entry = map.get(id);
      if (entry === undefined) return false;
      map.delete(id);
      if (entry && entry.reject) entry.reject(err);
      return true;
    },
    has: (id) => map.has(id),
    get size() {
      return map.size;
    },
  };
}

module.exports = { createSessionStateMachine, gateCdpMethod, createPendingMap };
