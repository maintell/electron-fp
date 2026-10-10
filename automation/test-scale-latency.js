// R9 (OQ-21 residual): measured list latency + ring-drop at current capacities.
// Seeding is bounded so the run finishes; counts are reported honestly.
// New file only; no source changes. Output lines start with PASS/FAIL/SKIP.
'use strict';

const { createMetrics } = require('./runtime/metrics');
const { createAuditLog } = require('./runtime/audit-log');
const { createAutomationManager } = require('./runtime/automation-manager');

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : err));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const ms = (b) => Number(b) / 1e6;

function statLine(label, times) {
  const s = times.slice().sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const p99 = s[Math.min(s.length - 1, Math.ceil(0.99 * s.length) - 1)];
  console.log('EVIDENCE ' + label + ' latency ms: n=' + s.length +
    ' median=' + median.toFixed(3) + ' p99=' + p99.toFixed(3) +
    ' min=' + s[0].toFixed(3) + ' max=' + s[s.length - 1].toFixed(3));
  return { median, p99, max: s[s.length - 1] };
}

const METRICS_N = Number(process.env.METRICS_N || 100000);
const AUDIT_N = Number(process.env.AUDIT_N || 1000000);
const EXEC_N = Number(process.env.EXEC_N || 100000);
const CALLS = Number(process.env.LAT_CALLS || 200);

async function main() {
  console.log('EVIDENCE config: metrics.seed=' + METRICS_N + ' audit.seed=' + AUDIT_N +
    ' executions.seed=' + EXEC_N + ' latencyCalls=' + CALLS);

  // ---- metrics.js: default capacity 10000 ring ----
  await check('metrics ring: seed ' + METRICS_N + ' -> retains 10000, summary p99 < 500ms', () => {
    const metrics = createMetrics({ capacity: 10000, now: () => Date.now() });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < METRICS_N; i++) {
      metrics.record({
        status: 'SUCCESS',
        scriptId: 's1',
        profileId: 'p1',
        startTime: Date.now(),
        durationMs: 10,
        currentUrl: 'https://site' + (i % 10) + '.example/',
      });
    }
    const seedMs = ms(process.hrtime.bigint() - t0);
    const summary = metrics.summary();
    console.log('EVIDENCE metrics: attempted=' + METRICS_N + ' retained=' + summary.total +
      ' dropped=' + (METRICS_N - summary.total) + ' seedMs=' + seedMs.toFixed(1));
    assert(summary.total === 10000, 'metrics retains capacity 10000, got ' + summary.total);

    const times = [];
    for (let i = 0; i < CALLS; i++) {
      const a = process.hrtime.bigint();
      metrics.summary();
      times.push(ms(process.hrtime.bigint() - a));
    }
    const st = statLine('metrics.summary', times);
    assert(st.p99 < 500, 'metrics.summary p99 ' + st.p99.toFixed(3) + 'ms >= 500ms');
  });

  // ---- audit-log.js: default capacity 10000 ring, O(n) filter query ----
  await check('audit ring: seed ' + AUDIT_N + ' -> retains 10000, query p99 < 500ms', () => {
    const audit = createAuditLog({ capacity: 10000, now: () => Date.now() });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < AUDIT_N; i++) {
      audit.append({ type: 'execution', action: 'execution', entity: 'event', entity_id: 'e' + i, scriptId: 's1', profileId: 'p1' });
      if (i > 0 && i % 250000 === 0) console.log('EVIDENCE audit progress: appended=' + i);
    }
    const seedMs = ms(process.hrtime.bigint() - t0);
    const st2 = audit.stats();
    console.log('EVIDENCE audit: attempted=' + AUDIT_N + ' retained(buffered)=' + st2.buffered +
      ' seq(total seen)=' + st2.total + ' dropped=' + (AUDIT_N - st2.buffered) + ' seedMs=' + seedMs.toFixed(1));
    assert(st2.buffered === 10000, 'audit retains capacity 10000, got ' + st2.buffered);
    assert(st2.total === AUDIT_N, 'audit seq counts all appends, got ' + st2.total);

    const times = [];
    for (let i = 0; i < CALLS; i++) {
      const a = process.hrtime.bigint();
      audit.query({ type: 'execution', limit: 100 });
      times.push(ms(process.hrtime.bigint() - a));
    }
    const st = statLine('audit.query(type)', times);
    assert(st.p99 < 500, 'audit.query p99 ' + st.p99.toFixed(3) + 'ms >= 500ms');
  });

  // ---- automation-manager.js: executions Map bounded to cap (O(1) insert/evict) ----
  await check('executions: seed ' + EXEC_N + ' -> bounded to cap 10000, listExecutions p99 < 500ms', async () => {
    const store = {
      get: (id) => ({ id, name: 's', parameters: [], permissions: {}, trusted: false }),
      validateParameters: () => ({ ok: true, values: {} }),
      getVersion: (id, v) => ({ version: v || 1, code: '' }),
    };
    const manager = createAutomationManager({
      store,
      maxConcurrent: EXEC_N + 1, // disable the fail-fast gate so we can seed the registry
      maxExecutions: 10000, // default retention cap, made explicit
      runnerFactory: () => ({
        run: async () => ({
          status: 'SUCCESS',
          scriptId: 's1',
          profileId: 'p1',
          startTime: Date.now() - 5,
          endTime: Date.now(),
          durationMs: 5,
          logs: [],
        }),
      }),
    });

    const t0 = process.hrtime.bigint();
    const promises = [];
    for (let i = 0; i < EXEC_N; i++) {
      promises.push(manager.runScript('s1', { profileContext: { id: 'p1' } }));
    }
    await Promise.all(promises);
    const seedMs = ms(process.hrtime.bigint() - t0);
    const statsM = manager.stats();
    console.log('EVIDENCE executions: attempted=' + EXEC_N + ' retained=' + statsM.total +
      ' dropped=' + (EXEC_N - statsM.total) + ' byStatus=' + JSON.stringify(statsM.byStatus) + ' seedMs=' + seedMs.toFixed(1));
    assert(statsM.total === 10000, 'executions bounded to cap 10000, got ' + statsM.total);

    const times = [];
    for (let i = 0; i < CALLS; i++) {
      const a = process.hrtime.bigint();
      const r = manager.listExecutions({ limit: 50 });
      times.push(ms(process.hrtime.bigint() - a));
      if (i === 0) assert(r.total === 10000, 'listExecutions total=' + r.total);
    }
    const st = statLine('listExecutions', times);
    assert(st.p99 < 500, 'listExecutions p99 ' + st.p99.toFixed(3) + 'ms >= 500ms');
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + (e && e.stack ? e.stack : e));
  console.log('SUMMARY pass=' + pass + ' fail=' + (fail + 1));
  process.exit(1);
});
