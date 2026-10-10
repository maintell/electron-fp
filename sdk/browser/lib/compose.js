'use strict';
// Script composer: the real "loopback" path. Browser-layer calls are recorded as
// ops, then compiled to a script that uses the runtime's injected-API surface
// (the same names as automation.d.ts), and submitted through @fp-automation/core.
// The composer never executes browser logic itself — the runtime does.
function createComposer() {
  const ops = [];
  return {
    ops,
    invoke(ns, method, args) {
      ops.push({ ns, method, args });
      return Promise.resolve({ queued: ops.length });
    },
    toScript() {
      // The runtime wraps code as `(async () => { 'use strict'; <code> })()`
      // (script-runner.js), so the composer emits bare statements that use the
      // injected-API names (browser/page/...). Not `module.exports = ...`.
      const lines = ops.map((o) => {
        const a = o.args.map((x) => JSON.stringify(x)).join(', ');
        return 'await ' + o.ns + '.' + o.method + '(' + a + ');';
      });
      return lines.join('\n') + '\n';
    },
  };
}

// Submit a composed script through a @fp-automation/core client (loopback API):
// create -> save a version -> read it back. Returns the persisted code so the
// caller can assert the round-trip.
async function submitVia(client, composer, { name = 'sdk-browser-composed' } = {}) {
  const code = composer.toScript();
  const created = await client.scripts.create({ name });
  await client.scripts.saveVersion(created.id, code);
  const stored = await client.scripts.get(created.id);
  return { scriptId: created.id, code, stored };
}

module.exports = { createComposer, submitVia };
