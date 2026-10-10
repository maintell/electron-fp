'use strict';
// The browser capability surface — namespace -> method names, mirrored 1:1 from
// automation/automation.d.ts (the runtime's permission surface). The facade does
// NOT implement any browser behavior; it forwards each call to a transport, so
// the same layer works over a record transport (tests), a script composer
// (loopback), or a CDP bridge.
const METHODS = {
  browser: ['goto', 'back', 'forward', 'reload', 'close', 'screenshot', 'getCurrentUrl', 'getTitle'],
  page: [
    'locator',
    'click',
    'fill',
    'type',
    'press',
    'getText',
    'getAttribute',
    'waitForSelector',
    'waitForTimeout',
    'evaluate',
    'waitForVisible',
  ],
  cookies: ['get', 'set', 'delete', 'clear'],
  'storage.local': ['get', 'set'],
  'storage.session': ['get', 'set'],
  network: ['intercept', 'waitForRequest', 'waitForResponse'],
  download: ['wait', 'save'],
  upload: ['setFiles'],
  dialog: ['accept', 'dismiss'],
};

function createNamespace(ns, transport) {
  const o = {};
  for (const m of METHODS[ns]) {
    o[m] = (...args) => transport.invoke(ns, m, args);
  }
  return o;
}

function createBrowserLayer({ transport } = {}) {
  if (!transport || typeof transport.invoke !== 'function') {
    throw new Error('createBrowserLayer: transport with invoke() required');
  }
  const layer = { transport };
  for (const ns of Object.keys(METHODS)) {
    if (ns.indexOf('.') !== -1) continue; // nested (storage.*) handled below
    layer[ns] = createNamespace(ns, transport);
  }
  layer.storage = {
    local: createNamespace('storage.local', transport),
    session: createNamespace('storage.session', transport),
  };
  return layer;
}

function methodCount() {
  return Object.keys(METHODS).reduce((n, k) => n + METHODS[k].length, 0);
}

module.exports = { createBrowserLayer, createNamespace, METHODS, methodCount };
