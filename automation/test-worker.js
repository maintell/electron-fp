'use strict';

const { createWorker } = require('./runtime/worker');

let pass = 0;
let fail = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log('PASS ' + name);
    })
    .catch((err) => {
      fail++;
      console.log('FAIL ' + name + ' :: ' + err.message);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 2000, step = 5) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(step);
  }
  throw new Error('waitFor timeout: ' + fn.toString());
}

function makeQueue(seed = []) {
  const pending = seed.slice();
  const calls = { complete: [], fail: [], timeout: [], crash: [] };
  let claimCount = 0;
  let throwing = false;
  return {
    pending,
    calls,
    get claimCount() {
      return claimCount;
    },
    setThrowing(v) {
      throwing = v;
    },
    push(...items) {
      for (const i of items) pending.push(typeof i === 'object' ? i : { id: i });
    },
    claim() {
      claimCount++;
      if (throwing) throw new Error('queue corrupted');
      return pending.shift() || null;
    },
    complete(id, result) {
      calls.complete.push({ id, result });
    },
    fail(id, err) {
      calls.fail.push({ id, err });
    },
    timeout(id) {
      calls.timeout.push(id);
    },
    crash(id) {
      calls.crash.push(id);
    },
    // queue contract surface — worker does not call these (paused = no new claims only)
    pause() {},
    resume() {},
    stop() {},
    stats() {
      return {};
    },
  };
}

async function main() {
  await check('processes 2 items concurrency=2, both complete, running back to 0, status counts', async () => {
    const q = makeQueue([{ id: 'a' }, { id: 'b' }]);
    const w = createWorker({
      queue: q,
      execute: async (item) => ({ result: item.id + '-ok' }),
      concurrency: 2,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    w.start(); // idempotent
    await waitFor(() => q.calls.complete.length === 2);
    await waitFor(() => w.status().running === 0);
    const st = w.status();
    assert(st.state === 'running', 'state: ' + st.state);
    assert(st.running === 0, 'running: ' + st.running);
    assert(st.claimed === 2, 'claimed: ' + st.claimed);
    assert(st.completed === 2, 'completed: ' + st.completed);
    assert(st.failed === 0, 'failed: ' + st.failed);
    const ids = q.calls.complete.map((c) => c.id).sort().join(',');
    assert(ids === 'a,b', 'completed ids: ' + ids);
    assert(q.calls.complete.every((c) => /-ok$/.test(c.result)), 'results: ' + JSON.stringify(q.calls.complete));
    await w.stop();
    assert(w.status().state === 'stopped', 'state after stop');
  });

  await check('concurrency=1 serializes (maxParallel stays 1)', async () => {
    const q = makeQueue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    let cur = 0;
    let maxParallel = 0;
    const w = createWorker({
      queue: q,
      execute: async () => {
        cur++;
        maxParallel = Math.max(maxParallel, cur);
        await sleep(30);
        cur--;
        return { result: 1 };
      },
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => q.calls.complete.length === 3);
    assert(maxParallel === 1, 'maxParallel: ' + maxParallel);
    assert(w.status().completed === 3, 'completed: ' + w.status().completed);
    await w.stop();
  });

  await check('taskTimeoutMs=100 + hanging execute → queue.timeout, cancelFn called, running drains', async () => {
    const q = makeQueue([{ id: 't1' }]);
    let cancelCalled = false;
    const w = createWorker({
      queue: q,
      execute: () => ({
        promise: new Promise(() => {}),
        cancel: () => {
          cancelCalled = true;
        },
      }),
      concurrency: 1,
      pollMs: 10,
      taskTimeoutMs: 100,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => q.calls.timeout.includes('t1'));
    assert(cancelCalled, 'cancelFn not called');
    await waitFor(() => w.status().running === 0);
    assert(w.status().failed === 1, 'failed count: ' + w.status().failed);
    await w.stop();
  });

  await check('execute throws NetworkError → queue.fail called with err', async () => {
    const q = makeQueue([{ id: 'n1' }]);
    const w = createWorker({
      queue: q,
      execute: async () => {
        const e = new Error('net down');
        e.name = 'NetworkError';
        throw e;
      },
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => q.calls.fail.length === 1);
    assert(q.calls.fail[0].id === 'n1', 'id: ' + q.calls.fail[0].id);
    assert(q.calls.fail[0].err && q.calls.fail[0].err.name === 'NetworkError', 'err: ' + q.calls.fail[0].err);
    await waitFor(() => w.status().running === 0);
    await w.stop();
  });

  await check('execute throws {code:BROWSER_CRASH} → queue.crash', async () => {
    const q = makeQueue([{ id: 'c1' }]);
    const w = createWorker({
      queue: q,
      execute: async () => {
        throw Object.assign(new Error('renderer died'), { code: 'BROWSER_CRASH' });
      },
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => q.calls.crash.includes('c1'));
    assert(q.calls.fail.length === 0, 'should not also fail');
    await waitFor(() => w.status().running === 0);
    await w.stop();
  });

  await check('pause stops claiming, resume continues', async () => {
    const q = makeQueue();
    const w = createWorker({
      queue: q,
      execute: async () => ({ result: 'ok' }),
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await sleep(30); // empty queue, claims return null
    w.pause();
    assert(w.status().state === 'paused', 'state: ' + w.status().state);
    q.push({ id: 'p1' });
    const before = q.claimCount;
    await sleep(60);
    assert(q.claimCount === before, 'claimed while paused: ' + before + '→' + q.claimCount);
    w.resume();
    assert(w.status().state === 'running', 'state after resume');
    await waitFor(() => q.calls.complete.some((c) => c.id === 'p1'));
    await w.stop();
  });

  await check('heartbeat fired ≥1 with correct running count (heartbeatMs=50, wait ~200ms)', async () => {
    const beats = [];
    const q = makeQueue([{ id: 'h1' }]);
    let release;
    const p = new Promise((resolve, reject) => {
      release = { resolve, reject };
    });
    const w = createWorker({
      queue: q,
      execute: () => ({
        promise: p,
        cancel: () => release.reject(new Error('cancelled')),
      }),
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 50,
      onHeartbeat: (s) => beats.push(s),
    });
    w.start();
    await waitFor(() => w.status().running === 1);
    await sleep(200);
    assert(beats.length >= 1, 'beats: ' + beats.length);
    const beat = beats.find((b) => b.running === 1);
    assert(beat, 'no beat with running=1: ' + JSON.stringify(beats));
    assert(beat.claimed >= 1 && beat.completed === 0 && beat.failed === 0, 'beat payload: ' + JSON.stringify(beat));
    assert(typeof beat.ts === 'number', 'ts missing');
    await w.stop(); // cancel rejects p → queue.fail → running drains
    await waitFor(() => w.status().running === 0);
  });

  await check('stop() drains: long execute, stop immediately → resolves after item settles', async () => {
    const q = makeQueue([{ id: 'l1' }]);
    const w = createWorker({
      queue: q,
      execute: async () => {
        await sleep(100);
        return { result: 'done' };
      },
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => w.status().running === 1); // claimed + executing
    const stopPromise = w.stop(); // immediate
    await stopPromise;
    assert(w.status().running === 0, 'running after stop: ' + w.status().running);
    assert(q.calls.complete.some((c) => c.id === 'l1'), 'item did not settle before stop resolved: ' + JSON.stringify(q.calls));
    assert(w.status().state === 'stopped', 'state');
  });

  await check('consecutive queue.claim throw ×5 → worker-abort, status stopped', async () => {
    const q = makeQueue();
    q.setThrowing(true);
    const audits = [];
    const w = createWorker({
      queue: q,
      execute: async () => ({ result: 1 }),
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
      audit: (row) => audits.push(row),
      recoverBackoffMs: 5, // keep total test <5s (prod default 1000ms)
    });
    w.start();
    await waitFor(() => w.status().state === 'stopped', 1000);
    const recovers = audits.filter((a) => a.type === 'worker-recover');
    assert(recovers.length >= 5, 'worker-recover count: ' + recovers.length);
    assert(audits.some((a) => a.type === 'worker-abort'), 'missing worker-abort: ' + JSON.stringify(audits));
    await w.stop();
    assert(w.status().state === 'stopped', 'state stays stopped');
  });

  await check('pause() legacy: running untouched, no new claims, no cancel', async () => {
    const q = makeQueue();
    let cancelCalls = 0;
    let release;
    const gate = new Promise((res) => {
      release = res;
    });
    const w = createWorker({
      queue: q,
      execute: (item) =>
        item.id === 'run1'
          ? {
              promise: gate,
              cancel: () => {
                cancelCalls++;
              },
            }
          : { result: 'ok' },
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    q.push({ id: 'run1' });
    w.start();
    await waitFor(() => w.status().running === 1);
    w.pause();
    assert(w.status().state === 'paused', 'state: ' + w.status().state);
    q.push({ id: 'later' });
    const before = q.claimCount;
    await sleep(60);
    assert(q.claimCount === before, 'claimed while paused: ' + before + '→' + q.claimCount);
    assert(w.status().running === 1, 'running item disturbed');
    assert(cancelCalls === 0, 'cancel called on legacy pause');
    release({ result: 'run1-done' });
    await waitFor(() => q.calls.complete.some((c) => c.id === 'run1'));
    await waitFor(() => w.status().running === 0);
    await w.stop();
  });

  await check('pause({interrupt:true}) aborts running item → queue CANCELLED', async () => {
    const { createTaskQueue } = require('./runtime/task-queue');
    const q = createTaskQueue();
    const item = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'p' } });
    let cancelSpy = 0;
    let rejectRun;
    const w = createWorker({
      queue: q,
      execute: () => ({
        promise: new Promise((_res, rej) => {
          rejectRun = rej;
        }),
        cancel: () => {
          cancelSpy++;
          const e = new Error('interrupted');
          e.name = 'CancelledError';
          rejectRun(e);
        },
      }),
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => w.status().running === 1);
    w.pause({ interrupt: true });
    assert(cancelSpy === 1, 'cancelFn not called once: ' + cancelSpy);
    await waitFor(() => q.get(item.id).status === 'CANCELLED');
    await waitFor(() => w.status().running === 0);
    assert(w.status().state === 'paused', 'state: ' + w.status().state);
    await w.stop();
  });

  await check('abortItem(id) aborts one running item, other untouched', async () => {
    const { createTaskQueue } = require('./runtime/task-queue');
    const q = createTaskQueue();
    const a = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'p' } });
    const b = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'p2' } });
    const rejects = {};
    const w = createWorker({
      queue: q,
      execute: (item) => ({
        promise: new Promise((_res, rej) => {
          rejects[item.id] = rej;
        }),
        abort: () => {
          const e = new Error('interrupted');
          e.name = 'CancelledError';
          rejects[item.id](e);
        },
      }),
      concurrency: 2,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => w.status().running === 2);
    assert(w.abortItem('nope') === false, 'unknown id should be false');
    // cancelFns populates in a post-claim microtask — poll the real call (false
    // is side-effect-free) instead of assuming microtask order.
    await waitFor(() => w.abortItem(a.id) === true);
    await waitFor(() => q.get(a.id).status === 'CANCELLED');
    assert(q.get(b.id).status === 'RUNNING', 'sibling disturbed: ' + q.get(b.id).status);
    await w.stop(); // aborts b -> CANCELLED, drain resolves
    assert(q.get(b.id).status === 'CANCELLED', 'stop settles sibling: ' + q.get(b.id).status);
  });

  await check('BROWSER_CRASH with relaunch hook: hook runs, item requeued, retry succeeds', async () => {
    const { createTaskQueue } = require('./runtime/task-queue');
    const q = createTaskQueue({ defaultRetry: { max: 3, baseMs: 50, mult: 1, jitter: 0 } });
    const item = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'p' } });
    const relaunched = [];
    let runs = 0;
    const w = createWorker({
      queue: q,
      execute: async () => {
        runs++;
        if (runs === 1) {
          const e = new Error('renderer gone');
          e.name = 'BrowserCrashError';
          throw e;
        }
        return { result: 'recovered' };
      },
      relaunch: async ({ item: it, error }) => {
        relaunched.push({ id: it.id, error: String((error && error.message) || error) });
      },
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => relaunched.length === 1, 5000);
    assert(relaunched[0].id === item.id, 'hook got item id');
    await waitFor(() => q.get(item.id).status === 'SUCCESS', 10000);
    assert(runs === 2, 'retried on live session: runs=' + runs);
    await w.stop();
  });

  await check('relaunch throw -> audit worker-relaunch-fail, crash still proceeds', async () => {
    const { createTaskQueue } = require('./runtime/task-queue');
    const q = createTaskQueue({ defaultRetry: { max: 1, baseMs: 50, mult: 1, jitter: 0 } });
    const audits = [];
    const item = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'p' } });
    const w = createWorker({
      queue: q,
      execute: async () => {
        const e = new Error('renderer gone');
        e.name = 'BrowserCrashError';
        throw e;
      },
      relaunch: async () => {
        throw new Error('no window factory');
      },
      audit: (a) => audits.push(a),
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => audits.some((a) => a.type === 'worker-relaunch-fail'), 5000);
    await waitFor(() => q.get(item.id).status === 'CRASHED', 10000);
    await w.stop();
  });

  await check('resume() resumes claiming after interrupt-pause', async () => {
    const q = makeQueue();
    const w = createWorker({
      queue: q,
      execute: async () => ({ result: 'ok' }),
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    w.pause({ interrupt: true }); // nothing running — abort loop no-op
    assert(w.status().state === 'paused', 'state: ' + w.status().state);
    q.push({ id: 'r1' });
    await sleep(40);
    assert(!q.calls.complete.some((c) => c.id === 'r1'), 'claimed while paused');
    w.resume();
    assert(w.status().state === 'running', 'state after resume');
    await waitFor(() => q.calls.complete.some((c) => c.id === 'r1'));
    await w.stop();
  });

  await check('same profile never parallel: concurrency=2, same-profile items serialize (maxActive=1)', async () => {
    const { createTaskQueue } = require('./runtime/task-queue');
    const q = createTaskQueue();
    q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'same' } });
    q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'same' } });
    let active = 0;
    let maxActive = 0;
    const w = createWorker({
      queue: q,
      execute: async () => {
        active++;
        if (active > maxActive) maxActive = active;
        await sleep(50);
        active--;
        return { result: 'ok' };
      },
      concurrency: 2,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => w.status().completed === 2, 5000);
    assert(maxActive === 1, 'same-profile overlap: maxActive=' + maxActive);
    await w.stop();
  });

  await check('different profiles overlap with concurrency=2 (maxParallel=2)', async () => {
    const { createTaskQueue } = require('./runtime/task-queue');
    const q = createTaskQueue();
    q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'd1' } });
    q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'd2' } });
    let active = 0;
    let maxActive = 0;
    const w = createWorker({
      queue: q,
      execute: async () => {
        active++;
        if (active > maxActive) maxActive = active;
        await sleep(60);
        active--;
        return { result: 'ok' };
      },
      concurrency: 2,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => maxActive === 2, 3000);
    assert(w.status().running === 2, 'expected 2 running, got ' + w.status().running);
    await waitFor(() => w.status().completed === 2, 5000);
    await w.stop();
  });

  await check('serialized profile: no starvation (second runs after first); runningProfiles frees for later item', async () => {
    const { createTaskQueue } = require('./runtime/task-queue');
    const q = createTaskQueue();
    const aId = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'drain' } }).id;
    const bId = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'drain' } }).id;
    const order = [];
    const w = createWorker({
      queue: q,
      execute: async (item) => {
        order.push(item.id);
        await sleep(30);
        return { result: item.id };
      },
      concurrency: 2,
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await waitFor(() => w.status().completed === 2, 5000);
    assert(order.length === 2 && order[0] === aId && order[1] === bId, 'FIFO serialization: ' + order.join(','));
    const cId = q.enqueue({ scriptId: 's', version: '1', params: {}, profileContext: { id: 'drain' } }).id;
    await waitFor(() => q.get(cId).status === 'SUCCESS', 5000);
    await w.stop();
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + e.message);
  process.exit(1);
});
