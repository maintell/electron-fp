'use strict';
// automation/test-perf.js — PERFORMANCE MEASUREMENT for the automation runtime.
//
// Doc 09 §4 is explicit: "只给测量方法，不编造数据" (measurement methods only, never
// fabricate numbers). This suite therefore MEASURES and REPORTS real numbers on
// the machine it runs on; it asserts only LOOSE SANITY BOUNDS (a phase completes,
// timings are finite/positive, RSS growth is under a generous cap, nothing hangs).
// It does NOT assert performance thresholds — a threshold would be a fabricated
// target, not a measurement.
//
// Covers the real runtime modules:
//   script-runner · automation-manager · script-store · task-queue · scheduler · metrics · audit-log
//
// Run: node automation/test-perf.js   (plain Node, no Electron; exit 0 == green)

const os = require('os');
const path = require('path');
const fs = require('fs');
const { createScriptStore } = require('./runtime/script-store');
const { createScriptRunner } = require('./runtime/script-runner');
const { createAutomationManager } = require('./runtime/automation-manager');
const { createTaskQueue } = require('./runtime/task-queue');
const { createScheduler } = require('./runtime/scheduler');
const { createMetrics } = require('./runtime/metrics');
const { createAuditLog } = require('./runtime/audit-log');

let pass = 0, fail = 0, skip = 0;
function ck(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}
function sk(name, why) { skip++; console.log('SKIP  ' + name + '  (' + why + ')'); }

// --- measurement helpers (no thresholds here) --------------------------------
const NS_PER_MS = 1e6;
const hrMs = (a, b) => Number(b - a) / NS_PER_MS;
const MB = (bytes) => bytes / 1048576;
const ms3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');

function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}
function summarize(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const sum = s.reduce((x, y) => x + y, 0);
  return { n: s.length, min: s[0], mean: sum / s.length, p50: quantile(s, 0.5), p90: quantile(s, 0.9), p99: quantile(s, 0.99), max: s[s.length - 1] };
}

// process.cpuUsage() is quantized to the OS scheduler tick (measured ~16 ms on
// Windows): a workload that burns less than one tick reads as 0. Measure the tick
// here so a 0 CPU reading is REPORTED as "below tick", never mistaken for "no CPU".
function cpuTickMs() {
  const c0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  let d = { user: 0, system: 0 };
  for (;;) {
    const spinUntil = Date.now() + 1;
    while (Date.now() < spinUntil) { /* burn one tick */ }
    d = process.cpuUsage(c0);
    if (d.user + d.system > 0) break;
    if (hrMs(t0, process.hrtime.bigint()) > 500) break; // give up (no accounting)
  }
  return (d.user + d.system) / 1000;
}
const CPU_TICK_MS = cpuTickMs();
const cpuMethod = (base) => base + '; process.cpuUsage() tick~' + CPU_TICK_MS.toFixed(1) + 'ms here (sub-tick deltas read 0)';
const gcNow = () => { if (typeof global.gc === 'function') { try { global.gc(); } catch (_) {} } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-perf-'));
// No browser: a script with every capability OFF runs with browserApi undefined
// (script-runner throws only when permissions.browser is true).
const NO_PERM = { browser: false, cookies: false, storage: false, network: false, filesystem: false, process: false };
const TRIVIAL = 'const x = 1 + 1; return x;';

const perf = []; // [metric, value, methodology]
const record = (metric, value, method) => perf.push([metric, value, method]);

let seq = 0;
function freshStack({ maxConcurrent = 100, maxExecutions = 10000, metrics } = {}) {
  const store = createScriptStore({ file: path.join(TMP, 'store-' + (++seq) + '.json') });
  const audit = createAuditLog({}).fn;
  const runnerFactory = () => createScriptRunner({ browserApi: undefined, audit, timeoutMs: 30000 });
  const manager = createAutomationManager({ store, runnerFactory, audit, maxConcurrent, maxExecutions, metrics });
  return { store, manager, audit };
}
function mkScript(store, code = TRIVIAL) {
  return store.create({ name: 'perf-' + (++seq), code, permissions: { ...NO_PERM } }).id;
}

const startedAt = process.hrtime.bigint();

// Watchdog: a phase that hangs must be reported, not run forever (budget < ~2 min).
// NOT unref'd: an unref'd timer could let a hung, handle-less suite exit 0 (false green).
// process.exit() at the end kills it regardless, so it never delays a normal finish.
const WATCHDOG_MS = 150000;
const wd = setTimeout(() => {
  console.log('FAIL  watchdog: suite exceeded ' + (WATCHDOG_MS / 1000) + 's (a phase hung)');
  process.exit(2);
}, WATCHDOG_MS);
void wd;

(async () => {
  // --- P1: script cold start (first run in a fresh store/manager) -------------
  try {
    const { store, manager } = freshStack();
    const id = mkScript(store);
    const a = process.hrtime.bigint();
    const rec = await manager.runScript(id, { params: {}, profileContext: { id: 'p1' } });
    const b = process.hrtime.bigint();
    const ms = hrMs(a, b);
    ck('P1 cold start: first run SUCCESS', rec.status === 'SUCCESS', rec.status);
    ck('P1 cold start: wall time measured', Number.isFinite(ms) && ms > 0, ms3(ms) + ' ms');
    record('cold start (1st run, fresh store+manager)', ms3(ms) + ' ms',
      'process.hrtime.bigint around 1st manager.runScript (incl. runner build + vm compile)');
  } catch (e) { ck('P1 cold start', false, (e && e.message) || String(e)); }

  // --- P2: hot start (median over N subsequent runs) --------------------------
  const N_HOT = 30;
  try {
    const { store, manager } = freshStack();
    const id = mkScript(store);
    await manager.runScript(id, { params: {}, profileContext: { id: 'p2-warm' } }); // warm-up (excluded)
    const durs = [];
    let bad = 0;
    for (let i = 0; i < N_HOT; i++) {
      const a = process.hrtime.bigint();
      const rec = await manager.runScript(id, { params: {}, profileContext: { id: 'p2' } });
      const b = process.hrtime.bigint();
      durs.push(hrMs(a, b));
      if (rec.status !== 'SUCCESS') bad++;
    }
    const st = summarize(durs);
    ck('P2 hot start: all runs SUCCESS', bad === 0, 'N=' + N_HOT + ' failures=' + bad);
    ck('P2 hot start: p50/p99 measured', Number.isFinite(st.p50) && Number.isFinite(st.p99),
      'p50=' + ms3(st.p50) + ' ms p99=' + ms3(st.p99) + ' ms');
    record('hot start p50 (N=' + N_HOT + ')', ms3(st.p50) + ' ms', 'median hrtime per run after 1 warm-up');
    record('hot start p99 (N=' + N_HOT + ')', ms3(st.p99) + ' ms', 'nearest-rank p99 of the same runs');
    record('hot start mean (N=' + N_HOT + ')', ms3(st.mean) + ' ms', 'arithmetic mean of the same runs');
  } catch (e) { ck('P2 hot start', false, (e && e.message) || String(e)); }

  // --- P3: single-instance overhead (wall + CPU + memory delta) ---------------
  try {
    const { store, manager } = freshStack();
    const id = mkScript(store);
    const cpu0 = process.cpuUsage();
    const m0 = process.memoryUsage();
    const a = process.hrtime.bigint();
    const rec = await manager.runScript(id, { params: {}, profileContext: { id: 'p3' } });
    const b = process.hrtime.bigint();
    const cpu = process.cpuUsage(cpu0); // microseconds
    const m1 = process.memoryUsage();
    const wall = hrMs(a, b);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    ck('P3 single instance: run SUCCESS', rec.status === 'SUCCESS', rec.status);
    ck('P3 single instance: wall + CPU measured', Number.isFinite(wall) && Number.isFinite(cpuMs),
      'wall=' + ms3(wall) + ' ms cpu=' + ms3(cpuMs) + ' ms');
    record('single-instance wall', ms3(wall) + ' ms', 'hrtime around one trivial run');
    record('single-instance CPU (user+sys)', ms3(cpuMs) + ' ms', cpuMethod('process.cpuUsage() delta'));
    record('single-instance RSS delta', ms3(MB(m1.rss - m0.rss)) + ' MB', 'process.memoryUsage().rss delta');
    record('single-instance heapUsed delta', ms3(MB(m1.heapUsed - m0.heapUsed)) + ' MB', 'process.memoryUsage().heapUsed delta');
  } catch (e) { ck('P3 single instance', false, (e && e.message) || String(e)); }

  // --- P4: concurrency K = 1 / 5 / 10 / 25 ------------------------------------
  const KS = [1, 5, 10, 25];
  try {
    for (const K of KS) {
      const { store, manager } = freshStack({ maxConcurrent: 100 });
      const ids = [];
      for (let i = 0; i < K; i++) ids.push(mkScript(store));
      const cpu0 = process.cpuUsage();
      const rss0 = process.memoryUsage().rss;
      const a = process.hrtime.bigint();
      const recs = await Promise.all(ids.map((id) => manager.runScript(id, { params: {}, profileContext: { id: 'p4' } })));
      const b = process.hrtime.bigint();
      const cpu = process.cpuUsage(cpu0);
      const rss1 = process.memoryUsage().rss;
      const ok = recs.every((r) => r && r.status === 'SUCCESS');
      ck('P4 concurrency K=' + K + ': all SUCCESS', ok, 'completed=' + recs.length);
      record('concurrency K=' + K + ' wall', ms3(hrMs(a, b)) + ' ms', 'hrtime around Promise.all of K runs');
      record('concurrency K=' + K + ' CPU', ms3((cpu.user + cpu.system) / 1000) + ' ms', cpuMethod('process.cpuUsage() delta'));
      record('concurrency K=' + K + ' RSS delta', ms3(MB(rss1 - rss0)) + ' MB', 'process.memoryUsage().rss delta');
    }
  } catch (e) { ck('P4 concurrency', false, (e && e.message) || String(e)); }

  // --- P5: log write performance (N console.log lines) ------------------------
  const N_LOGS = 5000;
  try {
    const metrics = createMetrics({});
    const { store, manager } = freshStack({ metrics });
    const code = 'for (let i = 0; i < ' + N_LOGS + '; i++) console.log("line " + i); return "done";';
    const id = mkScript(store, code);
    const a = process.hrtime.bigint();
    const rec = await manager.runScript(id, { params: {}, profileContext: { id: 'p5' } });
    const b = process.hrtime.bigint();
    const ms = hrMs(a, b);
    const retained = (rec.logs || []).length;
    const emittedPerSec = N_LOGS / (ms / 1000);
    const retainedPerSec = retained / (ms / 1000);
    ck('P5 log flood: run SUCCESS', rec.status === 'SUCCESS', rec.status);
    ck('P5 log flood: lines retained (capped by runner)', retained > 0 && retained <= N_LOGS,
      'emitted=' + N_LOGS + ' retained=' + retained);
    ck('P5 log flood: metrics recorded the execution', metrics.summary().total >= 1,
      'metrics total=' + metrics.summary().total);
    record('log write: ' + N_LOGS + ' console.log lines', ms3(ms) + ' ms', 'hrtime around one log-flood run');
    record('log write throughput (emitted)', Math.round(emittedPerSec) + ' lines/sec', N_LOGS + ' emitted / wall');
    record('log write throughput (retained)', Math.round(retainedPerSec) + ' lines/sec',
      retained + ' retained / wall (script-runner MAX_LOGS cap = 1000)');
  } catch (e) { ck('P5 log flood', false, (e && e.message) || String(e)); }

  // --- P6: task scheduling latency (enqueue -> claim) -------------------------
  const N_QUEUE = 2000;
  try {
    const queue = createTaskQueue({});
    const lat = [];
    let misses = 0;
    for (let i = 0; i < N_QUEUE; i++) {
      const a = process.hrtime.bigint();
      const item = queue.enqueue({ scriptId: 's' });
      const claimed = queue.claim();
      const b = process.hrtime.bigint();
      lat.push(hrMs(a, b));
      if (!claimed || claimed.id !== item.id) misses++;
    }
    const st = summarize(lat);
    ck('P6 queue: every item claimed (no miss)', misses === 0, 'N=' + N_QUEUE + ' misses=' + misses);
    ck('P6 queue: p50/p99 measured', Number.isFinite(st.p50) && Number.isFinite(st.p99),
      'p50=' + ms3(st.p50) + ' ms p99=' + ms3(st.p99) + ' ms');
    record('enqueue->claim p50 (N=' + N_QUEUE + ')', ms3(st.p50) + ' ms', 'hrtime per enqueue+claim on one task-queue');
    record('enqueue->claim p99 (N=' + N_QUEUE + ')', ms3(st.p99) + ' ms', 'nearest-rank p99 (claim() scans the in-memory map, so tail grows with depth)');
    record('enqueue->claim mean (N=' + N_QUEUE + ')', ms3(st.mean) + ' ms', 'arithmetic mean');
  } catch (e) { ck('P6 task queue', false, (e && e.message) || String(e)); }

  // --- P7: long-run memory (bounded registry) ---------------------------------
  // The default executions cap is 10000 (automation-manager.js:12). Running 10000+
  // here would blow the time budget, so the loop uses a SMALL cap to actually
  // exercise eviction; the default-cap behaviour is covered by test-executions-cap.js.
  const M_LONG = 2000, CAP_LONG = 500, SAMPLE_EVERY = 250;
  try {
    const { store, manager } = freshStack({ maxConcurrent: 100, maxExecutions: CAP_LONG });
    const id = mkScript(store);
    const samples = [MB(process.memoryUsage().rss)];
    let bad = 0;
    for (let i = 0; i < M_LONG; i++) {
      const rec = await manager.runScript(id, { params: {}, profileContext: { id: 'p7' } });
      if (rec.status !== 'SUCCESS') bad++;
      if ((i + 1) % SAMPLE_EVERY === 0) samples.push(MB(process.memoryUsage().rss));
    }
    const st = manager.stats();
    const start = samples[0];
    gcNow(); // only effective under --expose-gc; isolates collected vs retained RSS
    const end = MB(process.memoryUsage().rss);
    samples.push(end);
    const max = Math.max(...samples);
    const growth = end - start;
    ck('P7 long run: all runs SUCCESS', bad === 0, M_LONG + ' runs, failures=' + bad);
    ck('P7 long run: registry bounded by cap', st.total <= CAP_LONG, 'executions kept=' + st.total + ' cap=' + CAP_LONG);
    ck('P7 long run: RSS growth bounded (< 512 MB)', growth < 512, 'growth=' + ms3(growth) + ' MB');
    record('long-run RSS growth (' + M_LONG + ' runs, cap=' + CAP_LONG + ')', ms3(growth) + ' MB',
      'rss start->end; sampled every ' + SAMPLE_EVERY + ' runs; end sample after optional gc (--expose-gc)');
    record('long-run RSS start/end/max', ms3(start) + ' / ' + ms3(end) + ' / ' + ms3(max) + ' MB',
      'process.memoryUsage().rss (gc forced at end only if --expose-gc)');
    record('long-run registry total', String(st.total) + ' (cap ' + CAP_LONG + ')',
      'manager.stats().total after ' + M_LONG + ' runs - bounded, not growing');
  } catch (e) { ck('P7 long run', false, (e && e.message) || String(e)); }

  // --- P8: scheduler cost (doc 09 §4 lists 调度延迟; item 6 covers the queue-side
  // latency. Here we measure the scheduler's real compute paths: tick() scan and
  // the fire path. Wall-clock fire lateness is a production metric read off the
  // schedule-fire audit, not reproducible deterministically in-process.)
  const N_SCHED = 500;
  try {
    const sched = createScheduler({ audit: () => {}, onFire: () => {} });
    const ids = [];
    for (let i = 0; i < N_SCHED; i++) {
      ids.push(sched.add({ scriptId: 's', type: 'interval', everyMs: 1000, profileContexts: [{ id: 'p' }] }).id);
    }
    const a = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) sched.tick(); // none due: pure scan cost
    const b = process.hrtime.bigint();
    const tickMs = hrMs(a, b) / 100;
    const c = process.hrtime.bigint();
    for (const id of ids) sched.triggerNow(id); // fire + reschedule + audit
    const d = process.hrtime.bigint();
    const fireMs = hrMs(c, d) / N_SCHED;
    ck('P8 scheduler: tick scan measured', Number.isFinite(tickMs) && tickMs >= 0,
      'tick=' + ms3(tickMs) + ' ms/scan over ' + N_SCHED + ' schedules');
    ck('P8 scheduler: fire path measured', Number.isFinite(fireMs) && fireMs >= 0, 'fire=' + ms3(fireMs) + ' ms/fire');
    record('scheduler tick() scan (N=' + N_SCHED + ')', ms3(tickMs) + ' ms',
      'hrtime per tick() with N active schedules, none due (100 scans averaged)');
    record('scheduler fire path (N=' + N_SCHED + ')', ms3(fireMs) + ' ms',
      'hrtime per triggerNow = fire + reschedule + audit');
  } catch (e) { ck('P8 scheduler', false, (e && e.message) || String(e)); }

  // --- summary ----------------------------------------------------------------
  const elapsedMs = hrMs(startedAt, process.hrtime.bigint());
  const pad = (s, n) => String(s).padEnd(n);
  const mw = Math.max(4, ...perf.map((r) => r[0].length));
  const vw = Math.max(5, ...perf.map((r) => r[1].length));
  console.log('');
  console.log('=== PERF SUMMARY (measured on this machine; never fabricated) ===');
  console.log(pad('metric', mw) + ' | ' + pad('value', vw) + ' | methodology');
  console.log('-'.repeat(mw) + '-+-' + '-'.repeat(vw) + '-+-----------------------------------------');
  for (const [m, v, d] of perf) console.log(pad(m, mw) + ' | ' + pad(v, vw) + ' | ' + d);
  console.log('');
  console.log('env: node ' + process.version + ' | ' + process.platform + '/' + process.arch +
    ' | cpus=' + os.cpus().length + ' | cpuUsage tick~' + CPU_TICK_MS.toFixed(1) + 'ms' +
    ' | suite wall=' + ms3(elapsedMs) + ' ms');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('');
  console.log(fail === 0
    ? 'PASS: ' + pass + ' checks, ' + skip + ' skipped'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL  suite threw :: ' + ((e && e.stack) || e));
  process.exit(1);
});
