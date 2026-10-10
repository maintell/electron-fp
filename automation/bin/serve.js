#!/usr/bin/env node
// ponytail: production startup entry for the automation stack — HTTP + WS (same port) and an
// OPTIONAL CDP-over-WS listener. Reuses buildLocalStack (wire), createTaskExecutor (terminal
// record -> throw mapping) and the existing APIs; no new deps.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildLocalStack } = require('../electron/wire');
const { createWorker } = require('../runtime/worker');
const { createTaskExecutor } = require('../runtime/automation-service');
const { createHttpApi } = require('../runtime/http-api');
const { createWsApi } = require('../runtime/ws-api');
const { createCdpWs } = require('../runtime/cdp-ws');
const { createMetrics } = require('../runtime/metrics');
const { resolveTokenStore } = require('../runtime/token-store');

function createAutomationServer({
  port = 0,
  host = '127.0.0.1',
  token,
  readToken,
  jwtSecret,
  trustSecret,
  storeFile,
  concurrency = 3,
  schedulerTickMs = 1000,
  executionsCapacity, // FP_AUTOMATION_EXECUTIONS_CAPACITY -> manager maxExecutions (doc 17 §A.4)
  graceMs, // FP_AUTOMATION_TOKEN_GRACE_MS -> rotation grace window (doc 17 Part C)
  dataDir, // credentials-file dir (default: storeFile's dir)
  credentialFile, // explicit credentials path override
  audit,
  auditFile, // central audit JSONL path (or FP_AUTOMATION_AUDIT_FILE); absent = memory ring only
  metrics,
  metricsCapacity,
  cdp, // optional { resolve(profileId) -> { webContents } | undefined }
} = {}) {
  // Token rotation store (doc 17 Part C): precedence env > file > generated. Env-set
  // tokens stay authoritative and memory-only; a generated token is persisted (sha256)
  // and returned once below so the operator can copy it.
  const credFileDir = dataDir || (storeFile ? path.dirname(storeFile) : os.tmpdir());
  const resolved = resolveTokenStore({ token, readToken, jwtSecret, graceMs, dataDir: credFileDir, credentialFile });
  const creds = resolved.store;
  // §35: metrics on by default; pass `metrics: false` to disable, or an explicit instance.
  const metricsFn = metrics === false ? null : metrics || createMetrics(metricsCapacity ? { capacity: Number(metricsCapacity) } : {});

  const { store, manager, queue, scheduler, service } = buildLocalStack({
    file: storeFile,
    audit,
    auditFile: auditFile || process.env.FP_AUTOMATION_AUDIT_FILE, // central audit JSONL (database.md §12 until SQLite P9)
    metrics: metricsFn,
    executionsCapacity,
    trustSecret, // trust gate (script-sandbox.md §7); absent => trust() answers NOT_IMPLEMENTED
    fingerprint:
      process.env.FP_FINGERPRINT_TOKEN || process.env.FP_AUTOMATION_FP_TOKEN
        ? { token: process.env.FP_FINGERPRINT_TOKEN || process.env.FP_AUTOMATION_FP_TOKEN }
        : undefined, // FingerprintBroker bearer (architecture.md §4); absent => no bearer gate
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

  // createTaskExecutor maps terminal records to resolve/throw so worker marks tasks
  // FAILED/TIMEOUT/CANCELLED correctly (plain manager.runScript resolves on failure too),
  // and its {promise, abort} shape gives the worker cooperative cancellation.
  const worker = createWorker({ queue, concurrency, audit, execute: createTaskExecutor({ manager }).execute });

  // NOTE on the composite-upgrade idea: createHttpApi accepts a single `upgradeHandler`,
  // so the CDP WS upgrade COULD ride the HTTP port. But it exposes no request-handler hook,
  // so /json/version + /json/list discovery cannot be mounted there — an external CDP client
  // needs discovery, so cdp-ws keeps its own listener (start() below) instead.
  const ws = createWsApi({ service, creds, audit });
  // Node's server.closeAllConnections() does not cover upgraded sockets, and ws-api exposes
  // no close(); track upgraded sockets here so stop() can force them down (and await close).
  const wsSockets = new Set();
  function trackUpgrade(handler) {
    return (req, socket, head) => {
      wsSockets.add(socket);
      socket.once('close', () => wsSockets.delete(socket));
      return handler(req, socket, head);
    };
  }
  const httpApi = createHttpApi({
    service,
    creds,
    port,
    host,
    audit,
    upgradeHandler: trackUpgrade(ws.upgradeHandler),
  });
  const cdpApi = cdp && typeof cdp.resolve === 'function' ? createCdpWs({ resolve: cdp.resolve, creds, host, port: 0, audit }) : null;

  let httpListener = null;
  let cdpListener = null;
  let tickTimer = null;
  let started = false;

  async function start() {
    if (started) return null;
    started = true;
    httpListener = await httpApi.start();
    worker.start();
    tickTimer = setInterval(() => {
      try {
        scheduler.tick();
      } catch (e) {
        if (typeof audit === 'function') audit({ type: 'scheduler-tick-error', error: String((e && e.message) || e) });
      }
    }, Math.max(10, Number(schedulerTickMs) || 1000));
    if (cdpApi) cdpListener = await cdpApi.start();
    const base = 'http://' + host + ':' + httpListener.port;
    return {
      port: httpListener.port,
      url: base,
      token: creds.rawToken(), // null after a file-loaded restart (raw is never stored)
      credentials: { source: resolved.source, generated: resolved.generated },
      wsUrl: base.replace(/^http/, 'ws') + '/api/ws?token=' + encodeURIComponent(creds.rawToken() || ''),
      cdpUrl: cdpListener ? cdpListener.url : null,
      metrics: !!metricsFn,
    };
  }

  async function stop() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    try {
      await worker.stop();
    } catch (_) {}
    if (cdpListener) {
      try {
        await cdpListener.close();
      } catch (_) {}
      cdpListener = null;
    }
    if (httpListener) {
      for (const s of wsSockets) {
        try {
          s.destroy();
        } catch (_) {}
      }
      wsSockets.clear();
      try {
        await httpListener.close();
      } catch (_) {}
      httpListener = null;
    }
    started = false;
  }

  return { start, stop, service, httpApi, ws, worker, scheduler, metrics: metricsFn };
}

if (require.main === module) {
  const env = process.env;
  const port = Number(env.FP_AUTOMATION_PORT || 0);
  const storeFile = env.FP_AUTOMATION_STORE || path.join(os.tmpdir(), 'fp-automation-store.json');
  const concurrency = Number(env.FP_AUTOMATION_CONCURRENCY || 3);
  const schedulerTickMs = Number(env.FP_AUTOMATION_SCHEDULER_TICK_MS || 1000);
  const metricsCapacity = Number(env.FP_AUTOMATION_METRICS_CAPACITY) || undefined;
  const executionsCapacity = Number(env.FP_AUTOMATION_EXECUTIONS_CAPACITY) || undefined;
  const graceMs = Number(env.FP_AUTOMATION_TOKEN_GRACE_MS) || undefined;
  const dataDir = env.FP_AUTOMATION_DATA_DIR || undefined;
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  } catch (_) {}

  const srv = createAutomationServer({
    port,
    token: env.FP_AUTOMATION_TOKEN,
    readToken: env.FP_AUTOMATION_READ_TOKEN,
    jwtSecret: env.FP_AUTOMATION_JWT_SECRET,
    trustSecret: env.FP_AUTOMATION_TRUST_SECRET, // trust gate (script-sandbox.md §7)
    storeFile,
    concurrency,
    schedulerTickMs,
    executionsCapacity,
    graceMs,
    dataDir,
    metricsCapacity,
  });

  srv
    .start()
    .then(async (s) => {
      console.log('automation server listening: ' + s.url);
      console.log('ws:   ' + s.wsUrl);
      if (s.cdpUrl) console.log('cdp-ws: ' + s.cdpUrl);
      console.log('store: ' + storeFile);
      if (s.credentials && s.credentials.generated) {
        console.log('token: ' + s.token + '  (generated once — save it; only its sha256 is stored)');
      }
      console.log('worker concurrency: ' + concurrency + ' (scheduler tick ' + schedulerTickMs + 'ms)');
      if (executionsCapacity) console.log('executions capacity: ' + executionsCapacity);
      console.log('metrics: ' + (s.metrics ? 'on' : 'off'));
      let closing = false;
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        try {
          await srv.stop();
        } catch (_) {}
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((e) => {
      console.error('error: ' + ((e && e.message) || e));
      process.exit(1);
    });
}

module.exports = { createAutomationServer };
