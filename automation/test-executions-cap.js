// Regression for OQ-21: bounded execution registry — cap enforced, oldest-first eviction,
// O(1) insert/evict (no O(n^2) order.unshift). Output lines start with PASS/FAIL.
// Run: node automation/test-executions-cap.js
'use strict';

const { createAutomationManager } = require('./runtime/automation-manager');

let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' :: ' + ((e && e.stack) || e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function mkManager({ maxConcurrent = 100000, maxExecutions } = {}) {
  const store = {
    get: (id) => ({ id, name: 's', parameters: [], permissions: {}, trusted: false }),
    validateParameters: () => ({ ok: true, values: {} }),
    getVersion: (id, v) => ({ version: v || 1, code: '' }),
  };
  const opts = {
    store,
    maxConcurrent,
    runnerFactory: () => ({
      run: async () => ({
        status: 'SUCCESS',
        scriptId: 's1',
        profileId: 'p1',
        startTime: Date.now() - 2,
        endTime: Date.now(),
        durationMs: 2,
        logs: [],
      }),
    }),
  };
  if (maxExecutions !== undefined) opts.maxExecutions = maxExecutions;
  return createAutomationManager(opts);
}

(async () => {
  await t('cap enforced: attempt 250, cap 100 -> retained 100', async () => {
    const m = mkManager({ maxExecutions: 100 });
    const promises = [];
    for (let i = 0; i < 250; i++) promises.push(m.runScript('s1', { profileContext: { id: 'p1' } }));
    await Promise.all(promises);
    assert(m.stats().total === 100, 'stats.total=' + m.stats().total);
    assert(m.listExecutions({ limit: 500 }).total === 100, 'list.total=' + m.listExecutions({ limit: 500 }).total);
  });

  await t('eviction oldest-first + newest-first list order preserved', async () => {
    const m = mkManager({ maxExecutions: 100 });
    const handles = [];
    for (let i = 0; i < 250; i++) handles.push(m.runScriptCancellable('s1', { profileContext: { id: 'p1' } }));
    await Promise.all(handles.map((h) => h.promise));
    const ids = handles.map((h) => h.executionId); // creation order == Map insertion order
    assert(ids.length === 250, 'ids=' + ids.length);
    assert(m.getExecution(ids[149]) === undefined, 'oldest (149) should be evicted');
    assert(m.getExecution(ids[150]) !== undefined, 'boundary (150) should be retained');
    assert(m.getExecution(ids[249]) !== undefined, 'newest (249) should be retained');
    const rows = m.listExecutions({ limit: 200 }).rows;
    assert(rows.length === 100, 'rows=' + rows.length);
    assert(rows[0].executionId === ids[249], 'row0=' + rows[0].executionId + ' expected=' + ids[249]);
    assert(rows[99].executionId === ids[150], 'row99=' + rows[99].executionId + ' expected=' + ids[150]);
    assert(m.listExecutions({ status: 'SUCCESS', limit: 500 }).total === 100, 'filtered SUCCESS total');
    assert(m.listExecutions({ status: 'FAILED', limit: 500 }).total === 0, 'filtered FAILED total');
  });

  await t('default cap is 10000 when maxExecutions omitted', async () => {
    const m = mkManager();
    const promises = [];
    for (let i = 0; i < 10001; i++) promises.push(m.runScript('s1', { profileContext: { id: 'p1' } }));
    await Promise.all(promises);
    assert(m.stats().total === 10000, 'stats.total=' + m.stats().total);
  });

  await t('seed 100000 with cap 10000 is fast (no O(n^2) unshift)', async () => {
    const m = mkManager({ maxExecutions: 10000 });
    const t0 = process.hrtime.bigint();
    const promises = [];
    for (let i = 0; i < 100000; i++) promises.push(m.runScript('s1', { profileContext: { id: 'p1' } }));
    await Promise.all(promises);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('EVIDENCE seed100k: elapsedMs=' + elapsedMs.toFixed(1) + ' retained=' + m.stats().total);
    assert(m.stats().total === 10000, 'retained=' + m.stats().total);
    assert(elapsedMs < 15000, 'seed 100k took ' + elapsedMs.toFixed(1) + 'ms (>= 15000ms, likely O(n^2))');
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
