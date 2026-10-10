'use strict';
// @fp-automation/browser — the browser capability layer for the automation SDK.
//   const { createBrowserLayer, recordTransport } = require('@fp-automation/browser');
//   const layer = createBrowserLayer({ transport: recordTransport() });
//   await layer.page.goto('https://example.com');
// Real execution goes through a transport: recordTransport (tests) or the script
// composer + @fp-automation/core (loopback). The layer holds no browser logic.
const { createBrowserLayer, createNamespace, METHODS, methodCount } = require('./lib/facade');
const { recordTransport } = require('./lib/record');
const { createComposer, submitVia } = require('./lib/compose');

module.exports = {
  createBrowserLayer,
  createNamespace,
  recordTransport,
  createComposer,
  submitVia,
  METHODS,
  methodCount,
};
