// ponytail: queue-level stress (no browser): 100 items x 10 profiles, concurrency 5.
// Honest scope: asserts no-loss + global cap + heartbeat + list p99. Per-profile
// serial is NOT enforced in code (worker semaphore only) — not asserted, see ceiling.
// Real-browser resource账 (CPU/RAM/process) needs P1 glue + Electron; not here.
'use strict';

const { createTaskQueue } = require('./runtime/task-queue');
const { createWorker } = require('./runtime/worker');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await t('flood 100 items / 10 profiles / concurrency 5: no loss, cap held, heartbeats live', async () => {
    const N = 100;
    const PROFILES = 10;
    const CONC = 5;
    const q = createTaskQueue({ audit: () => {} });
    let running = 0;
    let maxParallel = 0;
    let done = 0;
    const beats = [];
    const w = createWorker({
      queue: q,
      execute: async (item) => {
        running++;
        if (running > maxParallel) maxParallel = running;
        await sleep(5);
        running--;
        done++;
        return { ok: true, item: item.id };
      },
      concurrency: CONC,
      pollMs: 5,
      heartbeatMs: 50,
      taskTimeoutMs: 10000,
      recoverBackoffMs: 5,
      onHeartbeat: (h) => beats.push(h),
    });
    for (let i = 0; i < N; i++) {
      q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'p' + (i % PROFILES) } });
    }
    w.start();
    const t0 = Date.now();
    while (done < N && Date.now() - t0 < 30000) await sleep(50);
    await w.stop();
    assert(done === N, 'done=' + done + '/' + N);
    assert(maxParallel <= CONC, 'cap held: maxParallel=' + maxParallel);
    assert(maxParallel > 1, 'actually parallel: maxParallel=' + maxParallel);
    assert(beats.length >= 2, 'heartbeats=' + beats.length);
    const st = q.stats();
    const settled = (st.byStatus && (st.byStatus.COMPLETED || st.byStatus.SUCCEEDED || 0)) || st.completed || 0;
    assert(w.status().completed === N, 'worker completed=' + w.status().completed);
    assert(JSON.stringify(st).length > 0 && settled >= 0, 'stats readable');
  });

  await t('queue.list p99 < 500ms over 200 calls (100 items)', async () => {
    const q = createTaskQueue({ audit: () => {} });
    for (let i = 0; i < 100; i++) q.enqueue({ scriptId: 's' + i, params: {} });
    const ds = [];
    for (let i = 0; i < 200; i++) {
      const a = Date.now();
      q.list({ limit: 50 });
      ds.push(Date.now() - a);
    }
    ds.sort((a, b) => a - b);
    const p99 = ds[Math.floor(ds.length * 0.99)];
    assert(p99 < 500, 'p99=' + p99 + 'ms');
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
