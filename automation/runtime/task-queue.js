// ponytail: in-memory FIFO queue + state machine; SQLite/remote worker swap at database.md — interface must allow worker injection for Remote Worker later.
'use strict';

const { randomUUID } = require('crypto');
const { createRng } = require('./seeded-rng');

// Task item states (user spec §34). Terminal: SUCCESS|FAILED|CANCELLED|TIMEOUT|CRASHED.
// TIMEOUT/CRASHED may auto-retry ->QUEUED while attempts remain; other terminals
// re-enter only via retryNow (terminal ->QUEUED edge below).
const TRANSITIONS = {
  CREATED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'RETRYING', 'FAILED', 'CANCELLED', 'TIMEOUT', 'CRASHED', 'STOPPING'],
  RUNNING: ['PAUSED', 'STOPPING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'CRASHED', 'RETRYING'],
  PAUSED: ['RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'CRASHED', 'RETRYING'],
  STOPPING: ['SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'CRASHED', 'RETRYING'],
  RETRYING: ['QUEUED', 'CANCELLED'],
  SUCCESS: ['QUEUED'],
  FAILED: ['QUEUED'],
  CANCELLED: ['QUEUED'],
  TIMEOUT: ['QUEUED', 'RETRYING'],
  CRASHED: ['QUEUED', 'RETRYING'],
};

// script-sdk.md §6 taxonomy default; err.retriable===true always wins into retry.
const RETRIABLE_NAMES = new Set(['NetworkError', 'BrowserError', 'TimeoutError', 'DownloadError', 'UploadError']);

function createTaskQueue({ now, audit, defaultRetry, rng } = {}) {
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const auditFn = typeof audit === 'function' ? audit : () => {};
  // ponytail: production passes profile-scoped rng via worker; default keeps legacy behavior shape (non-deterministic seed).
  const rngFn = rng && typeof rng.jitter === 'function' ? rng : createRng(Date.now() & 0xffffffff);
  const retry = { max: 3, baseMs: 5000, mult: 3, jitter: 0.2, ...(defaultRetry || {}) };
  const items = new Map(); // insertion order = FIFO tie-break
  let shutDown = false;

  // exponential backoff, cap 300s pre-jitter: baseMs*mult^(attempt-1) * (1 ± jitter)
  function backoff(attempt) {
    const base = Math.min(retry.baseMs * retry.mult ** (attempt - 1), 300000);
    return rngFn.jitter(base, retry.jitter);
  }

  function mustGet(id) {
    const item = items.get(id);
    if (!item) throw new Error('unknown task item: ' + id);
    return item;
  }

  function moveTo(item, to) {
    const from = item.status;
    if (!(TRANSITIONS[from] || []).includes(to)) {
      auditFn({ action: 'state-deny', id: item.id, from, to, at: nowFn() });
      throw new Error('illegal transition: ' + from + '->' + to);
    }
    item.status = to;
    item.updatedAt = nowFn();
    auditFn({ action: 'state', id: item.id, from, to, at: item.updatedAt });
  }

  function classify(err) {
    const name = (err && err.name) || 'Error';
    const message = String(err && err.message !== undefined ? err.message : err);
    const retriable = !!(err && err.retriable === true) || RETRIABLE_NAMES.has(name);
    return { name, message, retriable };
  }

  // attempts counts retries scheduled (incremented here, not at claim); exhausted => caller leaves terminal.
  function scheduleRetry(item, error) {
    item.attempts += 1;
    item.lastError = error;
    item.nextRunAt = nowFn() + backoff(item.attempts);
    moveTo(item, 'RETRYING');
    moveTo(item, 'QUEUED');
  }

  function enqueue({ scriptId, version, params, profileContext, maxAttempts, priority, taskPlanId } = {}) {
    if (!scriptId) throw new Error('scriptId required');
    const t = nowFn();
    const item = {
      id: randomUUID(),
      taskPlanId,
      scriptId,
      version,
      params: params || {},
      profileContext,
      status: 'CREATED',
      attempts: 0,
      maxAttempts: maxAttempts != null ? maxAttempts : retry.max,
      nextRunAt: t,
      lastError: null,
      createdAt: t,
      updatedAt: t,
      priority,
      claimedAt: null,
      result: undefined,
    };
    items.set(item.id, item);
    moveTo(item, 'QUEUED'); // CREATED -> QUEUED immediately, nextRunAt = now
    return item;
  }

  // opts.skip(item) → true means "not claimable now" (e.g. profile already running).
  // ponytail: order-preserving only — skipped items stay QUEUED at their position and are
  // re-examined every claim(); no anti-starvation guarantee beyond that (worker.md §3 step 3).
  function claim(opts = {}) {
    if (shutDown) throw new Error('queue shut down');
    const skip = opts && typeof opts.skip === 'function' ? opts.skip : null;
    const t = nowFn();
    let pick = null;
    for (const item of items.values()) {
      if (item.status !== 'QUEUED' || item.nextRunAt > t) continue;
      if (skip && skip(item)) continue; // skip may throw — propagates (no silent catch)
      // stable iteration => FIFO among equal priority; higher priority first
      if (!pick || (item.priority ?? 0) > (pick.priority ?? 0)) pick = item;
    }
    if (!pick) return null;
    moveTo(pick, 'STARTING');
    moveTo(pick, 'RUNNING'); // two-step: returned item is already RUNNING
    pick.claimedAt = nowFn();
    return pick;
  }

  function complete(id, result) {
    const item = mustGet(id);
    item.result = result;
    moveTo(item, 'SUCCESS');
    return item;
  }

  function fail(id, err) {
    const item = mustGet(id);
    const error = classify(err);
    if (error.retriable && item.attempts < item.maxAttempts) {
      scheduleRetry(item, error); // RETRYING -> QUEUED, attempts++, backoff
    } else {
      item.lastError = error;
      moveTo(item, 'FAILED');
    }
    return item;
  }

  function timeout(id) {
    const item = mustGet(id);
    const error = { name: 'TimeoutError', message: 'task timed out', retriable: true };
    item.lastError = error;
    moveTo(item, 'TIMEOUT');
    if (item.attempts < item.maxAttempts) scheduleRetry(item, error);
    return item;
  }

  function crash(id) {
    const item = mustGet(id);
    const error = { name: 'CrashError', message: 'task crashed', retriable: true };
    item.lastError = error;
    moveTo(item, 'CRASHED');
    if (item.attempts < item.maxAttempts) scheduleRetry(item, error);
    return item;
  }

  function pause(id) {
    const item = mustGet(id);
    moveTo(item, 'PAUSED'); // status only; worker keeps running
    return item;
  }

  function resume(id) {
    const item = mustGet(id);
    moveTo(item, 'RUNNING');
    return item;
  }

  function cancel(id) {
    const item = mustGet(id);
    moveTo(item, 'CANCELLED');
    return item;
  }

  function stop(id) {
    const item = mustGet(id);
    moveTo(item, 'STOPPING'); // worker aborts, then calls fail/cancel
    return item;
  }

  function retryNow(id, { resetAttempts = false } = {}) {
    const item = mustGet(id);
    moveTo(item, 'QUEUED'); // terminal/failed -> QUEUED
    item.nextRunAt = nowFn();
    if (resetAttempts) item.attempts = 0;
    return item;
  }

  function tick() {
    // heartbeat: count of claimable items (nextRunAt gate lives in claim())
    const t = nowFn();
    let n = 0;
    for (const item of items.values()) if (item.status === 'QUEUED' && item.nextRunAt <= t) n++;
    return n;
  }

  function list({ status, scriptId, limit = 50, offset = 0 } = {}) {
    const out = [];
    for (const item of items.values()) {
      if (status !== undefined && item.status !== status) continue;
      if (scriptId !== undefined && item.scriptId !== scriptId) continue;
      out.push(item);
    }
    return { total: out.length, rows: out.slice(offset, offset + limit) };
  }

  function get(id) {
    return items.get(id);
  }

  function stats() {
    const byStatus = {};
    let depth = 0;
    for (const item of items.values()) {
      byStatus[item.status] = (byStatus[item.status] || 0) + 1;
      if (item.status === 'QUEUED') depth++;
    }
    return { total: items.size, byStatus, depth };
  }

  function shutdown() {
    shutDown = true;
    auditFn({ action: 'shutdown', at: nowFn() });
  }

  return {
    enqueue, claim, complete, fail, timeout, crash,
    pause, resume, cancel, stop, retryNow,
    tick, list, get, stats, shutdown,
  };
}

module.exports = { createTaskQueue };
