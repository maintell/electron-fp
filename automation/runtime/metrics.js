// ponytail: in-memory ring of execution records + O(n) aggregates; SQL rollups when database.md lands.
'use strict';

const TERMINAL = new Set(['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED', 'CRASHED']);
const FAILED_SET = new Set(['FAILED', 'TIMEOUT', 'CRASHED']);

function createMetrics({ capacity = 10000, now } = {}) {
  const nowFn = typeof now === 'function' ? now : () => (now != null ? now : Date.now());
  let ring = [];

  function startedAtOf(exec) {
    const s = exec.startTime;
    if (Number.isFinite(s)) return s;
    if (typeof s === 'string') {
      const t = Date.parse(s);
      if (Number.isFinite(t)) return t;
    }
    return nowFn();
  }

  function siteOf(exec) {
    if (!exec.currentUrl) return 'unknown';
    try {
      return new URL(exec.currentUrl).hostname || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function record(exec) {
    const rec = Object.assign({}, exec, { startedAt: startedAtOf(exec), site: siteOf(exec) });
    ring.push(rec);
    while (ring.length > capacity) ring.shift(); // drop oldest
    return rec;
  }

  // ponytail: one filter for every query; scriptId lives here so summary/topFailures/volume
  // honour it the same way failureRate/durationStats always did (their own checks stay as no-ops).
  function filtered({ sinceMs, untilMs, scriptId } = {}) {
    if (sinceMs == null && untilMs == null && scriptId == null) return ring;
    return ring.filter(
      (r) =>
        (sinceMs == null || r.startedAt >= sinceMs) &&
        (untilMs == null || r.startedAt <= untilMs) &&
        (scriptId == null || r.scriptId === scriptId)
    );
  }

  function summary(opts = {}) {
    const rows = filtered(opts);
    const byStatus = {};
    let running = 0;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (r.status === 'RUNNING') running++;
    }
    return {
      total: rows.length,
      byStatus,
      running,
      window: { from: opts.sinceMs != null ? opts.sinceMs : null, to: opts.untilMs != null ? opts.untilMs : null },
    };
  }

  function failureRate({ scriptId, sinceMs, untilMs } = {}) {
    let failures = 0;
    let total = 0;
    for (const r of filtered({ sinceMs, untilMs })) {
      if (scriptId != null && r.scriptId !== scriptId) continue;
      if (!TERMINAL.has(r.status)) continue;
      total++;
      if (FAILED_SET.has(r.status)) failures++;
    }
    return { failures, total, rate: total ? failures / total : 0 };
  }

  function topFailures(kind = 'script', limit = 5, opts = {}) {
    const field = kind === 'profile' ? 'profileId' : kind === 'site' ? 'site' : 'scriptId';
    const groups = new Map();
    for (const r of filtered(opts)) {
      if (!TERMINAL.has(r.status)) continue;
      const key = r[field] == null || r[field] === '' ? 'unknown' : String(r[field]);
      let g = groups.get(key);
      if (!g) {
        g = { key, failures: 0, total: 0 };
        groups.set(key, g);
      }
      g.total++;
      if (FAILED_SET.has(r.status)) g.failures++;
    }
    const out = [];
    for (const g of groups.values()) out.push({ key: g.key, failures: g.failures, total: g.total, rate: g.total ? g.failures / g.total : 0 });
    out.sort((a, b) => b.failures - a.failures);
    return out.slice(0, limit);
  }

  function durationStats({ scriptId, sinceMs, untilMs } = {}) {
    const arr = [];
    for (const r of filtered({ sinceMs, untilMs })) {
      if (scriptId != null && r.scriptId !== scriptId) continue;
      if (r.status !== 'SUCCESS') continue;
      arr.push(Number(r.durationMs) || 0);
    }
    if (!arr.length) return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
    arr.sort((a, b) => a - b);
    const n = arr.length;
    let sum = 0;
    for (const v of arr) sum += v;
    const at = (p) => arr[Math.ceil(p * n) - 1]; // nearest-rank
    return { count: n, avgMs: sum / n, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: arr[n - 1] };
  }

  function crashRate(opts = {}) {
    // terminal-only denominator (observability.md §2 ceiling closed): CRASHED /
    // TERMINAL. Non-terminal rows (RUNNING/QUEUED) never inflate the denominator.
    let crashes = 0;
    let total = 0;
    for (const r of filtered(opts)) {
      if (!TERMINAL.has(r.status)) continue;
      total++;
      if (r.status === 'CRASHED') crashes++;
    }
    if (!total) return 0;
    return crashes / total;
  }

  function hotSteps(limit = 5, opts = {}) {
    const counts = new Map();
    for (const r of filtered(opts)) {
      if (r.status !== 'FAILED' && r.status !== 'TIMEOUT') continue;
      if (r.currentStep == null || r.currentStep === '') continue;
      counts.set(r.currentStep, (counts.get(r.currentStep) || 0) + 1);
    }
    const out = [];
    for (const [step, count] of counts) out.push({ step, count });
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, limit);
  }

  function volume({ bucketsMs = 3600000, lastMs = 86400000, sinceMs, untilMs } = {}) {
    // end = max(now, latest startedAt): fixed-clock tests inject records "in the future"
    let end = nowFn();
    for (const r of filtered({ sinceMs, untilMs })) if (r.startedAt > end) end = r.startedAt;
    const start = end - lastMs;
    const map = new Map(); // aligned ts -> counts
    for (const r of filtered({ sinceMs, untilMs })) {
      if (r.startedAt < start || r.startedAt > end) continue;
      const ts = Math.floor(r.startedAt / bucketsMs) * bucketsMs;
      let b = map.get(ts);
      if (!b) {
        b = { ts, started: 0, succeeded: 0, failed: 0 };
        map.set(ts, b);
      }
      b.started++;
      if (r.status === 'SUCCESS') b.succeeded++;
      if (FAILED_SET.has(r.status)) b.failed++;
    }
    const buckets = [...map.values()].sort((a, b) => a.ts - b.ts);
    // ponytail: non-empty buckets only; full zero-filled 24h grid when a chart needs it
    return { bucketMs: bucketsMs, buckets };
  }

  function reset() {
    ring = [];
  }

  return { record, summary, failureRate, topFailures, durationStats, crashRate, hotSteps, volume, reset };
}

module.exports = { createMetrics };
