// ponytail: one-call Client/main.js integration for the automation IPC bridge.
// The call-site one-liner lives in docs (api.md §bridge-wire); everything around it
// lives here so Client/main.js itself stays untouched (acceptance #34 fingerprint invariant).
'use strict';

const { createScriptStore } = require('../runtime/script-store');
const { createScriptRunner } = require('../runtime/script-runner');
const { createAutomationManager } = require('../runtime/automation-manager');
const { createTaskQueue } = require('../runtime/task-queue');
const { createScheduler } = require('../runtime/scheduler');
const { createAutomationService } = require('../runtime/automation-service');
const { createIpcBridge } = require('../runtime/ipc-bridge');
const { createRecorderService } = require('../runtime/recorder-service');
const { createRpaService } = require('../runtime/rpa-service');
const { createAuditLog } = require('../runtime/audit-log');

// runnerFactory (optional) takes precedence over the no-API default; pass
// `createElectronExecutor({ launcher, audit }).for(profileContext)` (executor.js)
// to run scripts against a live launcher session with the real page driver.
// buildLocalStack returns the full in-process stack (serve.js wires worker/timers);
// buildLocalService keeps the original single-service export, unchanged.
function buildLocalStack({ file, profileManager, runnerFactory, onFire, recorderController, metrics, audit, auditFile, trustSecret, fingerprint, executionsCapacity } = {}) {
  // Central audit collector (database.md §12 shape, JSONL until SQLite P9):
  // when the caller passes no audit fn, ALL stack modules funnel into this one
  // collector (queryable via stack.auditLog); an explicit audit fn keeps working
  // and additionally fans out into the collector (belt: no event source is lost).
  const auditLog = createAuditLog({ file: auditFile });
  const auditFn =
    typeof audit === 'function'
      ? (ev, detail) => {
          try { audit(ev, detail); } catch (_) {}
          try { auditLog.fn(ev, detail); } catch (_) {}
        }
      : auditLog.fn;
  const store = createScriptStore({ file });
  const rf =
    typeof runnerFactory === 'function'
      ? runnerFactory
      : () => createScriptRunner({ browserApi: undefined, audit: auditFn, timeoutMs: 30000 });
  // maxExecutions: FP_AUTOMATION_EXECUTIONS_CAPACITY (doc 17 §A.4) -> executions ring cap;
  // absent => createAutomationManager default (10000).
  const manager = createAutomationManager({ store, runnerFactory: rf, audit: auditFn, metrics, maxExecutions: executionsCapacity });
  const queue = createTaskQueue({ audit: auditFn });
  const scheduler = createScheduler({ audit: auditFn, onFire: typeof onFire === 'function' ? onFire : () => {} });
  // trust gate wiring (script-sandbox.md §7): trustSecret from env (serve.js),
  // never from request bodies. Absent => trust()/untrust() answer NOT_IMPLEMENTED.
  // FingerprintBroker wiring (architecture.md §4): pass through an optional
  // { token, validate } — token becomes the broker bearer, validate the fpValidate
  // hook; both land on the internally-built profileManager below.
  const fpBrokerCfg = fingerprint && typeof fingerprint === 'object' ? fingerprint : undefined;
  // profileManager may be injected (tests) or built here. When built here and
  // fingerprint config is present, wire fpBroker + fpValidate into it; when an
  // external manager is injected, the caller owns broker wiring.
  const { createProfileManager } = require('../runtime/profile-manager');
  const pm =
    profileManager ||
    (fpBrokerCfg
      ? createProfileManager({
          audit: auditFn,
          fpBroker: fpBrokerCfg.token ? { token: fpBrokerCfg.token } : undefined,
          fpValidate: fpBrokerCfg.validate,
        })
      : undefined);
  const service = createAutomationService({
    store,
    manager,
    queue,
    scheduler,
    profileManager: pm,
    metrics,
    trustConfig: trustSecret ? { secret: trustSecret, audit: auditFn } : undefined,
  });
  // audit query surface (database.md §12): service.audit.query/stats read the
  // central collector; the bridge also logs ipc-call/ipc-deny into it.
  service.audit = {
    query: (opts) => ({ ok: true, data: auditLog.query(opts) }),
    stats: () => ({ ok: true, data: auditLog.stats() }),
  };
  // smallest diff: merge the recorder group here rather than adding a collaborator slot to
  // automation-service.js (which the bridge's CHANNEL_MAP resolves generically anyway).
  // Always mounted: without a controller every recorder method answers an honest
  // NOT_IMPLEMENTED (wired == absent would surface as INTERNAL "service method missing").
  service.recorder = createRecorderService({ controller: recorderController }).recorder;
  // RPA visual builder (rpa.md): flow save/load/validate/replay over the SAME
  // script store+manager — the flow rides in a header comment, replay compiles via
  // astToScript and runs through the normal executor path (no second runtime).
  service.rpa = createRpaService({ store, manager }).rpa;
  return { store, manager, queue, scheduler, service, profileManager: pm, auditLog };
}

function buildLocalService(opts = {}) {
  return buildLocalStack(opts).service;
}

function attachAutomation({ ipcMain, service, audit, allowedSenders, channels, push } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('ipcMain-like required');
  if (!service) throw new Error('service required — pass buildLocalService() output or your own');
  const bridge = createIpcBridge({ service, audit, allowedSenders });
  const registered = bridge.register(ipcMain, channels);
  // ponytail: panel subscribes via preload onAutomationEvent; poll remains fallback.
  function emit(channel, payload) {
    if (typeof push !== 'function') return false;
    try {
      push(channel, payload);
      return true;
    } catch {
      return false;
    }
  }
  // ponytail: live-log source. Injects onLog into run entry points so script
  // console lines stream as {executionId, line} via emit; idempotent, keeps the
  // caller's own onLog, never alters the {ok,data,error} envelope.
  if (service && service.run && typeof push === 'function') {
    for (const key of ['runScript', 'runCancellable']) {
      const fn = service.run[key];
      if (typeof fn !== 'function' || fn.__liveWrapped) continue;
      const wrapped = async function (id, opts) {
        const callerLog = opts && typeof opts.onLog === 'function' ? opts.onLog : null;
        return fn.call(
          this,
          id,
          Object.assign({}, opts, {
            onLog: (ev) => {
              emit('automation:event', ev);
              if (callerLog) callerLog(ev);
            },
          })
        );
      };
      wrapped.__liveWrapped = true;
      service.run[key] = wrapped;
    }
  }
  return { bridge, registered, emit };
}

module.exports = { buildLocalService, buildLocalStack, attachAutomation };
