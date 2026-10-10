'use strict';

// finger-sdk entry: re-exports the copied modules so consumers need one require.
// Copies are byte-identical to MClient/ (do not edit here; edit upstream).
// Note: tls/test-parser.js self-runs its checks on require (prints TAP lines),
// so it is exposed lazily via loadTestParser() instead of at the top level.

const schema = require('./fp-schema.js');
const probe = require('./fp-probe.js');
const tlsProbe = require('./tls-probe.js');
const browserProfile = require('./browser-profile.js');
const clienthello = require('./tls/clienthello.js');
const tlsDirProbe = require('./tls/tls-probe.js');

module.exports = {
  schema,
  probe,
  tlsProbe,
  browserProfile,
  clienthello,
  tlsDirProbe,
  loadTestParser: () => require('./tls/test-parser.js'),
};
