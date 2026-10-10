// ponytail: single-process execution registry; SQLite swap when database.md lands; worker queue is Phase 4 — here only inline run + bookkeeping.
'use strict';

const { randomUUID } = require('crypto');
const { ScriptError } = require('./script-runner');

function createAutomationManager({ store, runnerFactory, audit, now, maxConcurrent = 5, maxExecutions = 10000, metrics, trustResolver } = {}) {
  const nowFn = typeof now === 'function' ? now : () => new Date().toISOString();
  const metricsRecord = metrics && typeof metrics.record === 'function' ? metrics.record.bind(metrics) : null;
  // ponytail: retention cap mirrors the metrics/audit rings (default 10000). Map keeps
  // insertion order (oldest-first), so the cap costs O(1) — no separate order[] index.
  const cap = Number.isFinite(Number(maxExecutions)) && Number(maxExecutions) > 0 ? Math.floor(Number(maxExecutions)) : 10000;
  const executions = new Map(); // executionId -> { record, cancelFn }; insertion order = oldest-first
  let runningCount = 0; // O(1) RUNNING tally; scanning the map per start was O(n^2) at scale

  function countRunning() {
    return runningCount; // maxConcurrent counts RUNNING only
  }

  function start(scriptId, { version, params = {}, profileContext, onLog } = {}) {
    const script = store.get(scriptId);
    if (!script) throw new ScriptError('script not found');
    const check = store.validateParameters(scriptId, params);
    if (!check.ok) throw new ScriptError(check.errors.map((e) => (e.name ? e.name + ': ' : '') + e.message).join('; '));
    // Phase 4 queue replaces this fail-fast; upgrade path: enqueue instead of throw
    if (countRunning() >= maxConcurrent) throw new ScriptError('concurrency limit ' + maxConcurrent);
    const ver = store.getVersion(scriptId, version);
    if (!ver) throw new ScriptError(version ? 'script version not found: ' + version : 'script has no versions');
    // ponytail: caller must pass real profile in Phase 4
    const profile = profileContext && profileContext.id ? profileContext : { id: 'ctx-unknown' };

    const executionId = randomUUID();
    const record = {
      executionId,
      scriptId,
      scriptVersion: ver.version,
      profileId: profile.id || null,
      status: 'QUEUED',
      createdAt: nowFn(),
      startTime: null,
      endTime: null,
      durationMs: null,
      error: null,
      currentStep: null,
      currentUrl: null,
      logs: [],
      result: undefined,
    };

    let settled = false;
    const entry = { record, cancelFn: null, abortFn: null };
    executions.set(executionId, entry);
    // O(1) eviction: the oldest key is first in Map insertion order. cap >> maxConcurrent,
    // so a still-RUNNING record is never the eviction target in practice.
    while (executions.size > cap) executions.delete(executions.keys().next().value);

    function finish(partial) {
      if (settled) return record;
      settled = true;
      if (record.status === 'RUNNING') runningCount--; // leaving RUNNING (eviction never changes this)
      Object.assign(record, partial, { executionId }); // adopt runner terminal status; keep manager id
      if (record.endTime == null) record.endTime = Date.now();
      if (record.durationMs == null && record.startTime != null) {
        record.durationMs = Math.max(1, record.endTime - record.startTime);
      }
      // §35 observability: one record per terminal execution; never let metrics break a run.
      if (metricsRecord) {
        try {
          metricsRecord(record);
        } catch (_) {}
      }
      if (typeof audit === 'function') {
        audit({ type: 'execution', scriptId: record.scriptId, profileId: record.profileId, status: record.status });
      }
      return record;
    }

    let releaseCancel;
    const cancelPromise = new Promise((resolve) => {
      releaseCancel = resolve;
    });
    const controller = new AbortController();
    entry.abortFn = () => {
      try {
        controller.abort();
      } catch (_) {}
    };
    // Profile-aware factory: pass the resolved context so an executor-backed
    // factory can bind the right live session. No-arg factories ignore the extra arg.
    const runner = runnerFactory({ profileContext: profile });
    // ponytail: stamp manager executionId at the source so live lines route without a join.
    const forwardLog = typeof onLog === 'function' ? (line) => onLog({ executionId, line }) : undefined;
    entry.cancelFn = () => {
      if (typeof runner.cancel === 'function') runner.cancel(); // pre-start path inside runner
      if (!settled) {
        // best-effort immediate settle; runner abort (signal) settles authoritatively when it lands first
        const t = Date.now();
        releaseCancel(
          finish({
            status: 'CANCELLED',
            endTime: t,
            durationMs: Math.max(1, t - (record.startTime || t)),
            error: { name: 'CancelledError', message: 'execution cancelled' },
          })
        );
      }
    };

    record.status = 'RUNNING'; // QUEUED -> RUNNING just before runner.run
    runningCount++;
    record.startTime = Date.now();
    // runner may hang forever (vm await never settles); abandoned promise = Phase 4 worker-kill territory
    const runPromise = Promise.resolve()
      .then(() =>
        runner.run(
          {
            id: script.id,
            name: script.name,
            version: ver.version,
            code: ver.code,
            parameters: script.parameters,
            permissions: script.permissions,
            profileContext: profile,
            // trustResolver wins over spec.trusted when wired (production trust gate);
            // falls back to store.trusted lookup so the executor path needs no extra plumbing.
            trustResolver:
              typeof trustResolver === 'function'
                ? trustResolver
                : store
                  ? async (sid) => {
                      try {
                        const s = store.get(sid);
                        return !!(s && s.trusted === true);
                      } catch (_) {
                        return false;
                      }
                    }
                  : undefined,
          },
          check.values,
          { signal: controller.signal, onLog: forwardLog }
        )
      )
      .then(
        (rec) => finish(rec),
        (err) =>
          finish({
            status: 'FAILED',
            error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err), stack: (err && err.stack) || null },
            endTime: Date.now(),
          })
      );

    const promise = Promise.race([runPromise, cancelPromise]);
    return { executionId, promise, abort: entry.abortFn };
  }

  async function runScript(scriptId, options) {
    const { promise } = start(scriptId, options);
    return promise;
  }

  function runScriptCancellable(scriptId, options) {
    const { executionId, promise, abort } = start(scriptId, options);
    return { executionId, promise, abort };
  }

  function cancel(executionId) {
    const entry = executions.get(executionId);
    if (!entry) return false;
    const s = entry.record.status;
    if (s !== 'QUEUED' && s !== 'RUNNING') return false; // terminal: no-op
    if (typeof entry.abortFn === 'function') entry.abortFn(); // signal → runner settles CANCELLED
    if (typeof entry.cancelFn === 'function') entry.cancelFn();
    return true;
  }

  function getExecution(id) {
    const entry = executions.get(id);
    return entry ? entry.record : undefined;
  }

  function listExecutions({ scriptId, status, limit = 50, offset = 0 } = {}) {
    const out = [];
    // newest-first: Map iteration is oldest-first, so walk it backwards (identical to
    // the old order.unshift list, minus the O(n) insert).
    const entries = [...executions.values()];
    for (let i = entries.length - 1; i >= 0; i--) {
      const r = entries[i].record;
      if (scriptId !== undefined && r.scriptId !== scriptId) continue;
      if (status !== undefined && r.status !== status) continue;
      out.push(r);
    }
    // api.md §5 pagination: total first, then the window — callers stop paging on total.
    return { total: out.length, rows: out.slice(offset, offset + limit) };
  }

  function getLogs(executionId) {
    const entry = executions.get(executionId);
    return entry ? entry.record.logs : undefined;
  }

  function stats() {
    const byStatus = {};
    let running = 0;
    for (const { record } of executions.values()) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      if (record.status === 'RUNNING') running++;
    }
    return { total: executions.size, byStatus, running };
  }

  return { runScript, runScriptCancellable, cancel, getExecution, listExecutions, getLogs, stats };
}

module.exports = { createAutomationManager };
