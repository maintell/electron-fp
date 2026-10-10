#!/usr/bin/env node
// ponytail: wires real single-process stack behind runCli; JSON file store via FP_AUTOMATION_STORE; no HTTP — CLI trusts host side.
// ponytail: worker is for API/HTTP async queue mode; CLI `script run` awaits manager.runScript directly — built but never started.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createScriptStore } = require('../runtime/script-store');
const { createScriptRunner } = require('../runtime/script-runner');
const { createAutomationManager } = require('../runtime/automation-manager');
const { createTaskQueue } = require('../runtime/task-queue');
const { createScheduler } = require('../runtime/scheduler');
const { createWorker } = require('../runtime/worker');
const { createAutomationService } = require('../runtime/automation-service');
const { runCli } = require('../runtime/cli');

async function main() {
  const storeFile =
    process.env.FP_AUTOMATION_STORE || path.join(os.tmpdir(), 'fp-automation-store.json');
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });

  const store = createScriptStore({ file: storeFile });
  const audit =
    process.env.FP_AUTOMATION_AUDIT === '1' ? (...a) => console.debug(...a) : undefined;
  const runnerFactory = () =>
    createScriptRunner({
      browserApi: {
        browser: { goto: async () => {}, screenshot: async () => Buffer.alloc(0) },
        page: { evaluate: async () => null, click: async () => {}, fill: async () => {} },
      },
      timeoutMs: 30000,
    });
  const manager = createAutomationManager({ store, runnerFactory, audit });

  // ponytail: metrics.js absent in this lane — wrap only if it ever lands
  try {
    const { createMetrics } = require('../runtime/metrics');
    if (typeof createMetrics === 'function') {
      const metrics = createMetrics();
      const run = manager.runScript.bind(manager);
      manager.runScript = async (id, opts) => {
        const rec = await run(id, opts);
        metrics.record(rec);
        return rec;
      };
    }
  } catch (_) {}

  const queue = createTaskQueue({});
  const scheduler = createScheduler({
    onFire: (s, ctx) =>
      queue.enqueue({
        scriptId: s.scriptId,
        version: s.version,
        params: s.params,
        profileContext: ctx,
        maxAttempts: s.maxAttempts,
        priority: s.priority,
      }),
  });
  const worker = createWorker({
    queue,
    execute: async (item) =>
      manager.runScript(item.scriptId, {
        version: item.version,
        params: item.params,
        profileContext: item.profileContext,
      }),
    concurrency: Number(process.env.FP_AUTOMATION_CONCURRENCY || 3),
  });
  void worker; // no worker.start(): CLI is sync-inline (see header comment)

  const svc = createAutomationService({
    store,
    manager,
    queue,
    scheduler,
    trustConfig: process.env.FP_AUTOMATION_TRUST_SECRET
      ? { secret: process.env.FP_AUTOMATION_TRUST_SECRET, audit }
      : undefined,
  });
  // flat façade cli.js/tests call; svc is the nested HTTP shape — same business logic, no duplication (cli.md §1)
  const service = {
    listScripts: () => svc.scripts.list(),
    getScript: (id) => svc.scripts.get(id),
    runScript: (id, opts = {}) =>
      svc.run.runScript(id, {
        version: opts.version,
        params: opts.params,
        profileContext: opts.profile !== undefined ? { id: opts.profile } : undefined,
      }),
    cancel: (executionId) => svc.run.stop(executionId),
    exportScript: (id) => svc.scripts.exportOne(id),
    importScript: (payload) => svc.scripts.importOne(payload),
    listTasks: (opts) => svc.tasks.listTasks(opts),
    enqueueTask: (spec) => svc.tasks.enqueue(spec),
    cancelTask: (id) => svc.tasks.cancelTask(id),
    retryTask: (id) => svc.tasks.retryTask(id),
    trustScript: (id, body) => svc.scripts.trust(id, body),
    untrustScript: (id) => svc.scripts.untrust(id),
    profiles: {
      list: (o) => svc.profiles.list(o),
      start: (id) => svc.profiles.start(id),
      stop: (id) => svc.profiles.stop(id),
      fingerprintUpdate: (id, body) => svc.profiles.fingerprintUpdate(id, body),
      fingerprintRotate: (id, body) => svc.profiles.fingerprintRotate(id, body),
    },
    status: () => svc.status(),
  };

  return runCli(process.argv.slice(2), service);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('error: ' + ((e && e.message) || e));
    process.exit(1);
  }
);
