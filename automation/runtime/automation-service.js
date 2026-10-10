// ponytail: one Service both HTTP and CLI call — no duplicated business logic.
'use strict';

const { TEMPLATES, installTemplates } = require('./script-templates');

const ok = (data) => ({ ok: true, data });
const err = (code, message) => ({ ok: false, error: { code, message: String(message) } });

const KNOWN_CODES = new Set(['NOT_FOUND', 'VALIDATION', 'CONFLICT', 'LIMIT', 'INTERNAL', 'NOT_IMPLEMENTED']);

// not-found sniff BEFORE ScriptError name: manager throws ScriptError('script not found')
// ProfileError carries .code (CONFLICT/VALIDATION/NOT_FOUND/LIMIT) — trust it first:
// message-prefix sniff would miss 'CONFLICT: ...' and 'launcher not wired' has no 'limit' in it
function mapError(e) {
  const message = String((e && e.message) || e);
  if (e && e.code && KNOWN_CODES.has(e.code)) return err(e.code, message);
  if (/not found|unknown /i.test(message)) return err('NOT_FOUND', message);
  if (e && e.name === 'ScriptError') return err('VALIDATION', message);
  if (/illegal transition|already exists/i.test(message)) return err('CONFLICT', message);
  if (/limit/i.test(message)) return err('LIMIT', message);
  if (e instanceof TypeError || e instanceof RangeError) return err('INTERNAL', message);
  return err('VALIDATION', message); // store/scheduler validation fails throw plain Error
}

function createAutomationService({ store, manager, queue, scheduler, profileManager, worker, metrics, trustConfig } = {}) {
  const startedAt = Date.now();

  const call = (fn, ...args) => {
    try {
      return ok(fn(...args));
    } catch (e) {
      return mapError(e);
    }
  };
  const callAsync = async (fn, ...args) => {
    try {
      return ok(await fn(...args));
    } catch (e) {
      return mapError(e);
    }
  };
  // store/scheduler getters return undefined instead of throwing
  const callGet = (fn, ...args) => {
    try {
      const v = fn(...args);
      return v === undefined ? err('NOT_FOUND', 'not found') : ok(v);
    } catch (e) {
      return mapError(e);
    }
  };

  // §35: metrics group mirrors metrics.js 1:1; unwired collaborator -> honest NOT_IMPLEMENTED.
  const metricsStub = () => err('NOT_IMPLEMENTED', 'metrics not wired');
  const metricsCall = (method, ...args) => {
    if (!metrics || typeof metrics[method] !== 'function') return metricsStub();
    try {
      return ok(metrics[method](...args));
    } catch (e) {
      return mapError(e);
    }
  };

  const service = {
    scripts: {
      list: (opts) => call((o) => store.list(o), opts),
      get: (id) => callGet((x) => store.get(x), id),
      create: (meta) => call((m) => store.create(m), meta),
      update: (id, patch) => {
        try {
          const v = store.update(id, patch);
          return v === undefined ? err('NOT_FOUND', 'script not found: ' + id) : ok(v);
        } catch (e) {
          return mapError(e);
        }
      },
      remove: (id) => {
        try {
          const v = store.remove(id);
          return v === undefined ? err('NOT_FOUND', 'script not found: ' + id) : ok(v);
        } catch (e) {
          return mapError(e);
        }
      },
      saveVersion: (id, code, version) => {
        try {
          const v = store.addVersion(id, code, version);
          return v === undefined ? err('NOT_FOUND', 'script not found: ' + id) : ok(v);
        } catch (e) {
          return mapError(e);
        }
      },
      // Admin-only trust gate (script-sandbox.md §7). trustSecret comes from
      // trustConfig (serve.js env) — never from the request body. The service
      // layer is the ONLY writer of the trust bit; store.create/update/import
      // all refuse trusted:true (script-store.js). Audit logs every grant/revoke.
      trust: (id, body) => {
        try {
          if (!trustConfig || !trustConfig.secret) return err('NOT_IMPLEMENTED', 'trust gate not configured (no trust secret)');
          if (!store || typeof store.trust !== 'function') return err('NOT_IMPLEMENTED', 'store has no trust()');
          const out = store.trust(id, {
            signature: body && body.signature,
            trustSecret: trustConfig.secret,
            actor: body && body.actor,
          });
          if (out === undefined) return err('NOT_FOUND', 'script not found: ' + id);
          if (typeof trustConfig.audit === 'function') {
            try {
              trustConfig.audit({ type: 'script-trust', id, trusted: true, version: out.trustedVersion, actor: body && body.actor });
            } catch (_) {}
          }
          return ok({ id: out.id, trusted: out.trusted, trustedVersion: out.trustedVersion });
        } catch (e) {
          return mapError(e);
        }
      },
      untrust: (id) => {
        try {
          if (!store || typeof store.untrust !== 'function') return err('NOT_IMPLEMENTED', 'store has no untrust()');
          const out = store.untrust(id);
          if (out === undefined) return err('NOT_FOUND', 'script not found: ' + id);
          if (trustConfig && typeof trustConfig.audit === 'function') {
            try {
              trustConfig.audit({ type: 'script-untrust', id });
            } catch (_) {}
          }
          return ok({ id: out.id, trusted: false });
        } catch (e) {
          return mapError(e);
        }
      },
      exportOne: (id) => {
        try {
          const v = store.exportScript(id);
          return v === undefined ? err('NOT_FOUND', 'script not found: ' + id) : ok(v);
        } catch (e) {
          return mapError(e);
        }
      },
      importOne: (json) => call((j) => store.importScript(j), json),
      validateParams: (id, params) => call((i, p) => store.validateParameters(i, p), id, params),
    },

    run: {
      runScript: (scriptId, opts) => callAsync((i, o) => manager.runScript(i, o), scriptId, opts),
      runCancellable: (scriptId, opts) => {
        try {
          const { executionId, promise } = manager.runScriptCancellable(scriptId, opts);
          return ok({ executionId, promise });
        } catch (e) {
          return mapError(e);
        }
      },
      stop: (executionId) => {
        if (!manager.getExecution(executionId)) return err('NOT_FOUND', 'execution not found: ' + executionId);
        if (!manager.cancel(executionId)) return err('CONFLICT', 'execution not cancellable: ' + executionId);
        return ok({ executionId, cancelled: true });
      },
      getExecution: (id) => callGet((x) => manager.getExecution(x), id),
      listExecutions: (opts) => call((o) => manager.listExecutions(o), opts),
      getLogs: (id) => callGet((x) => manager.getLogs(x), id),
      stats: () => call(() => manager.stats()),
    },

    tasks: {
      enqueue: (spec) => call((s) => queue.enqueue(s), spec),
      listTasks: (opts) => call((o) => queue.list(o), opts),
      getTask: (id) => callGet((x) => queue.get(x), id),
      cancelTask: (id) => call((x) => queue.cancel(x), id),
      // Mid-run pause (§41 #7): queue.pause is RUNNING->PAUSED (legal, status
      // only); with {interrupt:true} and an attached worker the running item is
      // additionally aborted — runner settles CANCELLED, queue converges
      // PAUSED->CANCELLED promptly instead of waiting out the timeout.
      pauseTask: (id, opts) => {
        const r = call((x) => queue.pause(x), id);
        if (!r.ok) return r;
        let interrupted = false;
        if (opts && opts.interrupt && worker && typeof worker.abortItem === 'function') {
          interrupted = worker.abortItem(id);
        }
        return ok({ id: r.data.id, status: r.data.status, interrupted });
      },
      resumeTask: (id) => call((x) => queue.resume(x), id),
      retryTask: (id, opts) => call((x, o) => queue.retryNow(x, o), id, opts),
      taskStats: () => call(() => queue.stats()),
    },

    schedules: {
      addSchedule: (spec) => call((s) => scheduler.add(s), spec),
      listSchedules: (opts) => call((o) => scheduler.list(o), opts),
      pauseSchedule: (id) => call((x) => scheduler.pause(x), id),
      resumeSchedule: (id) => call((x) => scheduler.resume(x), id),
      triggerSchedule: (id) => call((x) => scheduler.triggerNow(x), id),
      removeSchedule: (id) => call((x) => scheduler.remove(x), id),
      scheduleStats: () => call(() => scheduler.stats()),
    },

    status: () =>
      ok({
        service: 'automation',
        components: {
          store: !!store,
          queueDepth: queue ? queue.stats().depth : 0,
          running: manager ? manager.stats().running : 0,
          schedules: scheduler ? scheduler.stats() : null,
          profiles: !!profileManager,
        },
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      }),

    // P8: thin delegation over profileManager; honest NOT_IMPLEMENTED stub when unwired
    profiles: {
      list: (opts) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : call((o) => profileManager.list(o), opts),
      get: (id) => {
        if (!profileManager) return err('NOT_IMPLEMENTED', 'Profile Manager P8');
        try {
          const v = profileManager.get(id);
          return v === undefined ? err('NOT_FOUND', 'profile not found: ' + id) : ok(v);
        } catch (e) {
          return mapError(e);
        }
      },
      create: (spec) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : call((s) => profileManager.create(s), spec),
      update: (id, patch) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : call((a, b) => profileManager.update(a, b), id, patch),
      remove: (id) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : call((x) => profileManager.remove(x), id),
      start: (id) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : callAsync((x) => profileManager.start(x), id),
      stop: (id) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : callAsync((x) => profileManager.stop(x), id),
      status: (id) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : call((x) => profileManager.status(x), id),
      bulkStart: (ids, opts) =>
        !profileManager
          ? err('NOT_IMPLEMENTED', 'Profile Manager P8')
          : callAsync((a, o) => profileManager.bulkStart(a, o), ids, opts),
      // FingerprintBroker entry (architecture.md §4): the only sanctioned path
      // for changing fingerprint planes. Service forwards id/config/opts; the
      // manager enforces the five gates (validate/permission/lifecycle/restart/log).
      fingerprintUpdate: (id, body) => {
        if (!profileManager) return err('NOT_IMPLEMENTED', 'Profile Manager P8');
        if (typeof profileManager.fingerprintUpdate !== 'function') {
          return err('NOT_IMPLEMENTED', 'fingerprint broker not wired');
        }
        try {
          const v = profileManager.fingerprintUpdate(id, body && body.config, {
            bearerToken: body && body.bearerToken,
          });
          if (v && typeof v.then === 'function') {
            return v.then(
              (data) => ok(data),
              (e) => mapError(e)
            );
          }
          return ok(v);
        } catch (e) {
          return mapError(e);
        }
      },
      // Broker rotation: stop → update → start in one call (live profiles).
      fingerprintRotate: (id, body) => {
        if (!profileManager) return err('NOT_IMPLEMENTED', 'Profile Manager P8');
        if (typeof profileManager.fingerprintRotate !== 'function') {
          return err('NOT_IMPLEMENTED', 'fingerprint broker rotate not wired');
        }
        try {
          const v = profileManager.fingerprintRotate(id, body && body.config, {
            bearerToken: body && body.bearerToken,
          });
          if (v && typeof v.then === 'function') {
            return v.then(
              (data) => ok(data),
              (e) => mapError(e)
            );
          }
          return ok(v);
        } catch (e) {
          return mapError(e);
        }
      },
    },

    // templates: read-only catalog + idempotent copy into the store (reuses installTemplates, no reimpl)
    // list() includes code so the panel can preview without a second roundtrip (11 small strings)
    templates: {
      list: () => call(() => TEMPLATES.map((t) => ({ ...t }))),
      install: (opts) => call((o) => installTemplates(store, o), opts),
    },

    // §35 observability aggregates (metrics.js 1:1)
    metrics: {
      summary: (opts) => metricsCall('summary', opts),
      failureRate: (opts) => metricsCall('failureRate', opts),
      topFailures: (kind, limit, opts) => metricsCall('topFailures', kind, limit, opts),
      durationStats: (opts) => metricsCall('durationStats', opts),
      crashRate: (opts) => metricsCall('crashRate', opts),
      hotSteps: (limit, opts) => metricsCall('hotSteps', limit, opts),
      volume: (opts) => metricsCall('volume', opts),
    },
  };

  return service;
}

// ponytail: queue<->manager translator so a worker can execute queue items.
// Returns the worker execute shape {promise, abort} synchronously; terminal
// records map to worker-settled outcomes (SUCCESS resolves, everything else
// throws a classified error for queue.timeout/cancel/fail routing).
function createTaskExecutor({ manager } = {}) {
  if (!manager || typeof manager.runScriptCancellable !== 'function') {
    throw new TypeError('manager.runScriptCancellable required');
  }
  function execute(item) {
    const h = manager.runScriptCancellable(item.scriptId, {
      version: item.version,
      params: item.params,
      profileContext: item.profileContext,
    });
    const promise = h.promise.then((rec) => {
      const st = rec && rec.status;
      if (st === 'SUCCESS') return { result: rec.result, executionId: rec.executionId };
      if (st === 'CANCELLED') throw Object.assign(new Error('task cancelled: ' + item.id), { name: 'CancelledError' });
      if (st === 'TIMEOUT') throw Object.assign(new Error('task timeout: ' + item.id), { name: 'TimeoutError', retriable: true });
      const e = new Error('task ' + st + ': ' + ((rec && rec.error && rec.error.message) || st));
      e.name = (rec && rec.error && rec.error.name) || 'ScriptError';
      e.retriable = false;
      throw e;
    });
    return { promise, abort: h.abort };
  }
  return { execute };
}

module.exports = { createAutomationService, createTaskExecutor };
