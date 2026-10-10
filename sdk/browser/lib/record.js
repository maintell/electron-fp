'use strict';
// Fake/record transport: captures every (namespace, method, args) call and
// returns a canned result. Lets the layer be exercised with zero browser logic
// and zero live server.
function recordTransport() {
  const calls = [];
  return {
    calls,
    invoke(ns, method, args) {
      const call = { ns, method, args };
      calls.push(call);
      return Promise.resolve({ ok: true, ns, method, args });
    },
  };
}

module.exports = { recordTransport };
