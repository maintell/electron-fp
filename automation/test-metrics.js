'use strict';
const assert = require('assert');
const { createMetrics } = require('./runtime/metrics');

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

const t0 = 1_700_000_000_000;

function rec(over = {}) {
  return Object.assign(
    {
      executionId: 'e-' + Math.random().toString(36).slice(2),
      scriptId: 's1',
      scriptVersion: '1.0.0',
      profileId: 'p1',
      status: 'SUCCESS',
      startTime: t0,
      endTime: t0 + 1,
      durationMs: 1,
      error: null,
      currentStep: null,
      currentUrl: null,
    },
    over
  );
}

(async () => {
  await t('summary counts byStatus + running; window filter excludes outside', () => {
    const m = createMetrics({ now: () => t0 });
    m.record(rec({ status: 'SUCCESS', startTime: t0 }));
    m.record(rec({ status: 'FAILED', startTime: t0 + 1000 }));
    m.record(rec({ status: 'RUNNING', startTime: t0 + 5000 }));
    const s = m.summary();
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.byStatus.SUCCESS, 1);
    assert.strictEqual(s.byStatus.FAILED, 1);
    assert.strictEqual(s.byStatus.RUNNING, 1);
    assert.strictEqual(s.running, 1);
    const w = m.summary({ sinceMs: t0, untilMs: t0 + 2000 });
    assert.strictEqual(w.total, 2, 'window excludes t0+5000');
    assert.strictEqual(w.running, 0);
    assert.strictEqual(w.byStatus.RUNNING, undefined);
    assert.deepStrictEqual(w.window, { from: t0, to: t0 + 2000 });
  });

  await t('failureRate 2 FAILED + 1 TIMEOUT / 5 terminal = 0.6; scriptId filter', () => {
    const m = createMetrics({ now: () => t0 });
    m.record(rec({ scriptId: 'sA', status: 'FAILED' }));
    m.record(rec({ scriptId: 'sA', status: 'FAILED' }));
    m.record(rec({ scriptId: 'sA', status: 'SUCCESS' }));
    m.record(rec({ scriptId: 'sB', status: 'TIMEOUT' }));
    m.record(rec({ scriptId: 'sB', status: 'SUCCESS' }));
    m.record(rec({ scriptId: 'sB', status: 'RUNNING' })); // non-terminal: excluded
    const r = m.failureRate();
    assert.strictEqual(r.failures, 3);
    assert.strictEqual(r.total, 5);
    assert.strictEqual(r.rate, 0.6);
    const a = m.failureRate({ scriptId: 'sA' });
    assert.strictEqual(a.failures, 2);
    assert.strictEqual(a.total, 3);
    assert.ok(Math.abs(a.rate - 2 / 3) < 1e-12);
  });

  await t('topFailures script ordering + rate; profile; site hostname/unknown', () => {
    const m = createMetrics({ now: () => t0 });
    // scripts: s1 3 fail/4 total, s2 1 fail/4 total
    for (let i = 0; i < 3; i++) m.record(rec({ scriptId: 's1', status: 'FAILED' }));
    m.record(rec({ scriptId: 's1', status: 'SUCCESS' }));
    m.record(rec({ scriptId: 's2', status: 'FAILED' }));
    for (let i = 0; i < 3; i++) m.record(rec({ scriptId: 's2', status: 'SUCCESS' }));
    const top = m.topFailures('script');
    assert.strictEqual(top[0].key, 's1');
    assert.strictEqual(top[0].failures, 3);
    assert.strictEqual(top[0].total, 4);
    assert.strictEqual(top[0].rate, 0.75);
    assert.strictEqual(top[1].key, 's2');
    assert.strictEqual(top[1].failures, 1);

    // profile: pA fails more
    const m2 = createMetrics({ now: () => t0 });
    m2.record(rec({ profileId: 'pA', status: 'FAILED' }));
    m2.record(rec({ profileId: 'pA', status: 'FAILED' }));
    m2.record(rec({ profileId: 'pB', status: 'FAILED' }));
    m2.record(rec({ profileId: 'pB', status: 'SUCCESS' }));
    const tp = m2.topFailures('profile');
    assert.strictEqual(tp[0].key, 'pA');
    assert.strictEqual(tp[0].failures, 2);

    // site from currentUrl hostname; no url -> unknown
    const m3 = createMetrics({ now: () => t0 });
    m3.record(rec({ status: 'FAILED', currentUrl: 'https://a.example/x' }));
    m3.record(rec({ status: 'FAILED', currentUrl: 'https://a.example/y' }));
    m3.record(rec({ status: 'FAILED' })); // no url
    const ts = m3.topFailures('site');
    assert.strictEqual(ts[0].key, 'a.example');
    assert.strictEqual(ts[0].failures, 2);
    const unknown = ts.find((x) => x.key === 'unknown');
    assert.ok(unknown, 'unknown bucket present');
    assert.strictEqual(unknown.failures, 1);
  });

  await t('durationStats SUCCESS only, exact avg/p50/p95/max; empty zeros', () => {
    const m = createMetrics({ now: () => t0 });
    const durs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const d of durs) m.record(rec({ status: 'SUCCESS', durationMs: d }));
    m.record(rec({ status: 'FAILED', durationMs: 999 })); // ignored
    const s = m.durationStats();
    assert.strictEqual(s.count, 10);
    assert.strictEqual(s.avgMs, 55);
    assert.strictEqual(s.p50Ms, 50); // ceil(0.5*10)-1 = 4
    assert.strictEqual(s.p95Ms, 100); // ceil(0.95*10)-1 = 9
    assert.strictEqual(s.maxMs, 100);
    const e = createMetrics({ now: () => t0 }).durationStats();
    assert.deepStrictEqual(e, { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  });

  await t('crashRate 1/10 = 0.1; terminal-only denominator (RUNNING excluded)', () => {
    const m = createMetrics({ now: () => t0 });
    for (let i = 0; i < 9; i++) m.record(rec({ status: 'SUCCESS', startTime: t0 + i }));
    m.record(rec({ status: 'CRASHED', startTime: t0 + 9 }));
    assert.strictEqual(m.crashRate(), 0.1);
    assert.strictEqual(createMetrics({ now: () => t0 }).crashRate(), 0);
    // non-terminal rows never inflate the denominator
    const m2 = createMetrics({ now: () => t0 });
    m2.record(rec({ status: 'SUCCESS', startTime: t0 }));
    m2.record(rec({ status: 'CRASHED', startTime: t0 + 1 }));
    m2.record(rec({ status: 'RUNNING', startTime: t0 + 2 }));
    m2.record(rec({ status: 'QUEUED', startTime: t0 + 3 }));
    assert.strictEqual(m2.crashRate(), 0.5);
  });

  await t('hotSteps: login rank1 (3), checkout (1)', () => {
    const m = createMetrics({ now: () => t0 });
    for (let i = 0; i < 3; i++) m.record(rec({ status: 'FAILED', currentStep: 'login' }));
    m.record(rec({ status: 'TIMEOUT', currentStep: 'checkout' }));
    m.record(rec({ status: 'SUCCESS', currentStep: 'done' })); // not counted
    const h = m.hotSteps();
    assert.strictEqual(h[0].step, 'login');
    assert.strictEqual(h[0].count, 3);
    assert.strictEqual(h[1].step, 'checkout');
    assert.strictEqual(h[1].count, 1);
    assert.strictEqual(h.length, 2);
  });

  await t('volume: t0+10m and t0+70m -> 2 aligned hour buckets, counts correct', () => {
    const m = createMetrics({ now: () => t0 });
    m.record(rec({ status: 'SUCCESS', startTime: t0 + 10 * 60000 }));
    m.record(rec({ status: 'FAILED', startTime: t0 + 70 * 60000 }));
    const v = m.volume();
    assert.strictEqual(v.bucketMs, 3600000);
    assert.strictEqual(v.buckets.length, 2);
    const [b1, b2] = v.buckets;
    assert.strictEqual(b1.ts % 3600000, 0, 'aligned');
    assert.strictEqual(b1.started, 1);
    assert.strictEqual(b1.succeeded, 1);
    assert.strictEqual(b1.failed, 0);
    assert.strictEqual(b2.ts % 3600000, 0);
    assert.strictEqual(b2.started, 1);
    assert.strictEqual(b2.succeeded, 0);
    assert.strictEqual(b2.failed, 1);
    assert.ok(b2.ts - b1.ts === 3600000, 'adjacent hours');
  });

  await t('capacity ring: capacity=3, push 5 -> total 3, oldest dropped', () => {
    const m = createMetrics({ capacity: 3, now: () => t0 });
    const statuses = ['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED', 'CRASHED'];
    statuses.forEach((status, i) => m.record(rec({ status, startTime: t0 + i, scriptId: 's' + i })));
    const s = m.summary();
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.byStatus.TIMEOUT, 1);
    assert.strictEqual(s.byStatus.CANCELLED, 1);
    assert.strictEqual(s.byStatus.CRASHED, 1);
    assert.strictEqual(s.byStatus.SUCCESS, undefined, 'oldest dropped');
    assert.strictEqual(s.byStatus.FAILED, undefined, '2nd oldest dropped');
  });

  await t('reset clears ring', () => {
    const m = createMetrics({ now: () => t0 });
    m.record(rec());
    m.reset();
    assert.strictEqual(m.summary().total, 0);
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
