// ponytail: single local worker loop; Remote Worker = same class pointed at message-transport queue later.
'use strict';

function createWorker({
  queue,
  execute,
  concurrency = 3,
  pollMs = 250,
  heartbeatMs = 5000,
  taskTimeoutMs = 60000,
  now,
  audit,
  onHeartbeat,
  // ponytail: injectable so tests skip 4s of 1s-backoff waits; prod default = spec 'backoff 1s'
  recoverBackoffMs = 1000,
  // ponytail: profile-scoped rng (seed=hash(profileId)) jitters idle poll only; heartbeat/timeout exact.
  rng,
  // ponytail: P1 glue recovery seam. Called (awaited, best-effort) on
  // BROWSER_CRASH before queue.crash re-queues, so the retry lands on a live
  // session. Production passes glue.restartSession bound to a window factory;
  // tests pass a spy. Throw → audit + crash proceeds (never blocks retry).
  relaunch,
} = {}) {
  if (!queue || typeof queue.claim !== 'function') throw new TypeError('queue.claim required');
  if (typeof execute !== 'function') throw new TypeError('execute required');

  const nowFn = typeof now === 'function' ? now : Date.now;
  const doAudit = typeof audit === 'function' ? audit : () => {};

  let state = 'stopped'; // 'running' | 'paused' | 'stopped'
  let stopped = false;
  let paused = false;
  let started = false;
  let running = 0;
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  let lastHeartbeatAt = null;
  let consecutiveFailures = 0;
  let pollTimer = null;
  let hbTimer = null;
  const cancelFns = new Map(); // item.id -> cancelFn ({promise,cancel} execute shape only)
  const runningProfiles = new Set(); // profile keys in flight — enforces "same profile never parallel" (worker.md §3 step 3)
  const stopWaiters = [];

  // ponytail: paused = no new claims only; pause({interrupt:true}) cooperatively aborts
  // mid-run items via runner AbortSignal (script-runner race → CancelledError → queue.cancel).

  // ponytail: profile identity key for serial claims. No identity (null) → no serial constraint.
  function profileKey(item) {
    if (item && item.profileContext && item.profileContext.id) return item.profileContext.id;
    if (item && item.profileId) return item.profileId;
    return null;
  }

  function clearTimers() {
    if (pollTimer) clearTimeout(pollTimer);
    if (hbTimer) clearTimeout(hbTimer);
    pollTimer = null;
    hbTimer = null;
  }

  function scheduleTick(delay) {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, delay);
  }

  function drainStop() {
    if (!stopped || running !== 0 || stopWaiters.length === 0) return;
    const ws = stopWaiters.splice(0);
    for (const w of ws) w();
  }

  function abort() {
    stopped = true;
    state = 'stopped';
    doAudit({ type: 'worker-abort' });
    clearTimers();
    drainStop();
  }

  function scheduleHeartbeat() {
    if (stopped) return;
    hbTimer = setTimeout(() => {
      if (stopped) return;
      lastHeartbeatAt = nowFn();
      if (typeof onHeartbeat === 'function') {
        onHeartbeat({ running, claimed, completed, failed, ts: lastHeartbeatAt });
      }
      scheduleHeartbeat();
    }, heartbeatMs);
  }

  async function executeItem(item) {
    const id = item && item.id;
    let cancelFn = null;
    let status = 'completed';
    try {
      // execute → Promise<{result}> OR sync {promise, cancel} (automation-manager shape)
      const raw = execute(item);
      let p;
      if (raw && typeof raw.then === 'function') {
        p = raw;
      } else if (raw && typeof raw === 'object' && raw.promise) {
        p = raw.promise;
        // ponytail: cancel shape first (worker contract), abort = manager handle shape
        if (typeof raw.cancel === 'function') {
          cancelFn = raw.cancel;
          cancelFns.set(id, cancelFn);
        } else if (typeof raw.abort === 'function') {
          cancelFn = raw.abort;
          cancelFns.set(id, cancelFn);
        }
      } else {
        p = Promise.resolve(raw);
      }
      let timer = null;
      const timeoutPromise = new Promise((_r, rej) => {
        timer = setTimeout(
          () => rej(Object.assign(new Error('task timed out after ' + taskTimeoutMs + 'ms'), { code: 'TASK_TIMEOUT' })),
          taskTimeoutMs
        );
      });
      let out;
      try {
        out = await Promise.race([p, timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
      const result = out && typeof out === 'object' && 'result' in out ? out.result : out;
      queue.complete(id, result);
      completed++;
    } catch (e) {
      const code = e && e.code;
      const name = e && e.name;
      if (code === 'TASK_TIMEOUT') {
        status = 'timeout';
        failed++;
        if (cancelFn) {
          try {
            cancelFn();
          } catch (_) {}
        }
        queue.timeout(id);
      } else if (code === 'BROWSER_CRASH' || name === 'BrowserCrashError') {
        status = 'crash';
        failed++;
        if (typeof relaunch === 'function') {
          try {
            await relaunch({ item, error: e });
            doAudit({ type: 'worker-relaunch', id });
          } catch (re) {
            doAudit({ type: 'worker-relaunch-fail', id, error: String((re && re.message) || re) });
          }
        }
        queue.crash(id);
      } else if (name === 'CancelledError' || name === 'AbortError') {
        // task-queue TRANSITIONS: CANCELLED reachable from RUNNING/STARTING/PAUSED/STOPPING
        // (claimed items sit at RUNNING) → queue.cancel legal; no queue.cancel → queue.fail fallback.
        status = 'cancelled';
        try {
          if (typeof queue.cancel === 'function') queue.cancel(id);
          else queue.fail(id, e);
        } catch (_) {} // already settled via timeout race — terminal state stands
      } else {
        status = 'failed';
        failed++;
        queue.fail(id, e);
        if (code === 'RECOVERABLE_SESSION' || name === 'RecoverableSessionError') {
          doAudit({ type: 'worker-recover', id, error: String((e && e.message) || e) });
          consecutiveFailures++;
          if (consecutiveFailures >= 5) abort();
          else scheduleTick(recoverBackoffMs);
        }
      }
    } finally {
      if (cancelFns.get(id) === cancelFn) cancelFns.delete(id);
      const key = profileKey(item);
      if (key !== null) runningProfiles.delete(key); // claim is serial per key → at most one in flight
      running--;
      doAudit({ type: 'worker-exec', id, status });
      drainStop();
    }
  }

  function tick() {
    pollTimer = null;
    if (stopped) return;
    if (!paused) {
      while (!paused && !stopped && running < concurrency) {
        let item;
        try {
          // per-identity skip: same profile with an in-flight item stays QUEUED (global semaphore unchanged)
          item = queue.claim({ skip: (it) => runningProfiles.has(profileKey(it)) });
          consecutiveFailures = 0;
        } catch (e) {
          doAudit({ type: 'worker-recover', error: String((e && e.message) || e) });
          consecutiveFailures++;
          if (consecutiveFailures >= 5) {
            abort();
            return;
          }
          scheduleTick(recoverBackoffMs);
          return;
        }
        if (!item) break;
        running++;
        claimed++;
        const key = profileKey(item);
        if (key !== null) runningProfiles.add(key);
        // microtask: keeps recoverable-backoff scheduling after this tick's own scheduleTick
        queueMicrotask(() => {
          executeItem(item);
        });
      }
    }
    scheduleTick(pollMs);
  }

  function start() {
    if (started) return; // idempotent
    started = true;
    stopped = false;
    paused = false;
    state = 'running';
    scheduleHeartbeat();
    tick();
  }

  async function stop() {
    stopped = true;
    state = 'stopped';
    clearTimers();
    for (const fn of cancelFns.values()) {
      try {
        fn();
      } catch (_) {}
    }
    // ponytail: stop waits on running drain; cancel that never settles its promise hangs stop — runner must settle.
    if (running === 0) return;
    return new Promise((resolve) => stopWaiters.push(resolve));
  }

  function pause({ interrupt = false } = {}) {
    if (stopped) return;
    paused = true;
    state = 'paused';
    if (interrupt) {
      // cooperative mid-run abort (worker.md §6 upgrade): cancelFn → manager abort →
      // runner race rejects CancelledError → executeItem settles via queue.cancel (CANCELLED).
      for (const fn of cancelFns.values()) {
        try {
          fn();
        } catch (_) {}
      }
    }
  }

  function resume() {
    if (stopped) return;
    paused = false;
    state = 'running';
  }

  // Single-item cooperative abort (service pauseTask interrupt path). Returns
  // true when a running item was signalled; false when the id isn't running.
  function abortItem(id) {
    const fn = cancelFns.get(id);
    if (typeof fn !== 'function') return false;
    try {
      fn();
    } catch (_) {}
    return true;
  }

  function status() {
    return { state, running, claimed, completed, failed, lastHeartbeatAt };
  }

  return { start, stop, pause, resume, abortItem, status };
}

module.exports = { createWorker };
