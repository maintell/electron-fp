'use strict';

// Templates API surface: service -> ipc-bridge -> http-api (same harness style as test-http-api.js).

const http = require('http');
const { createScriptStore } = require('./runtime/script-store');
const { createScriptRunner } = require('./runtime/script-runner');
const { createAutomationManager } = require('./runtime/automation-manager');
const { createTaskQueue } = require('./runtime/task-queue');
const { createScheduler } = require('./runtime/scheduler');
const { createAutomationService } = require('./runtime/automation-service');
const { createIpcBridge } = require('./runtime/ipc-bridge');
const { createHttpApi } = require('./runtime/http-api');
const { TEMPLATES } = require('./runtime/script-templates');

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

function req({ port, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) {
      const buf = Buffer.from(body);
      r.setHeader('Content-Length', buf.length);
      if (!headers['Content-Type'] && !headers['content-type']) r.setHeader('Content-Type', 'application/json');
      r.write(buf);
    }
    r.end();
  });
}

const mockSender = () => ({ getType: () => 'window', getURL: () => 'file:///test' });
const mockEvent = () => ({ sender: mockSender() });

(async () => {
  const TOKEN = 'test-token-templates-123';
  const audits = [];
  const audit = (ev) => audits.push(ev);

  const store = createScriptStore();
  const manager = createAutomationManager({
    store,
    runnerFactory: () =>
      createScriptRunner({
        browserApi: { browser: { goto: async () => {} } },
        timeoutMs: 2000,
      }),
    audit,
  });
  const queue = createTaskQueue({ audit });
  const scheduler = createScheduler({ audit, onFire: () => {} });
  const service = createAutomationService({ store, manager, queue, scheduler });
  const bridge = createIpcBridge({ service, audit });

  await t('service install first run installs all templates', async () => {
    const r = service.templates.install();
    assert(r.ok === true, 'envelope ok: ' + JSON.stringify(r));
    assert(r.data.installed.length === TEMPLATES.length, 'installed ' + r.data.installed.length);
    assert(r.data.skipped === 0, 'skipped 0, got ' + r.data.skipped);
  });

  await t('service install re-run is idempotent (all skipped)', async () => {
    const r = service.templates.install();
    assert(r.ok === true, 'envelope ok');
    assert(r.data.installed.length === 0, 'installed 0, got ' + r.data.installed.length);
    assert(r.data.skipped === TEMPLATES.length, 'skipped all, got ' + r.data.skipped);
  });

  await t('service list returns template metas with code', async () => {
    const r = service.templates.list();
    assert(r.ok === true, 'envelope ok');
    assert(Array.isArray(r.data), 'array');
    assert(r.data.length === TEMPLATES.length, 'count ' + r.data.length);
    for (const m of r.data) {
      assert(typeof m.key === 'string' && m.key, 'key');
      assert(typeof m.name === 'string' && m.name, 'name');
      assert(typeof m.description === 'string', 'description');
      assert(typeof m.category === 'string', 'category');
      assert(m.permissions && typeof m.permissions === 'object', 'permissions');
      assert(Array.isArray(m.parameters), 'parameters');
      assert(typeof m.code === 'string' && m.code.length > 0, 'code for ' + m.key);
    }
  });

  await t('bridge roundtrip install+list through handle()', async () => {
    const ins = await bridge.handle('automation:templates:install', mockEvent());
    assert(ins.ok === true, 'install ok: ' + JSON.stringify(ins));
    assert(typeof ins.data.skipped === 'number', 'skipped number');
    const list = await bridge.handle('automation:templates:list', mockEvent());
    assert(list.ok === true, 'list ok');
    assert(Array.isArray(list.data) && list.data.length === TEMPLATES.length, 'count ' + (list.data && list.data.length));
    assert(list.data.every((m) => typeof m.code === 'string'), 'all have code');
  });

  const api = createHttpApi({ service, token: TOKEN, audit, rateLimit: { max: 1000, windowMs: 60000 } });
  let srv;
  try {
    srv = await api.start();
    const port = srv.port;
    const auth = { Authorization: 'Bearer ' + TOKEN };

    await t('HTTP GET /api/templates -> 200 envelope', async () => {
      const r = await req({ port, path: '/api/templates', headers: auth });
      assert(r.status === 200, 'status ' + r.status);
      assert(r.json && r.json.ok === true, 'ok envelope');
      assert(Array.isArray(r.json.data) && r.json.data.length === TEMPLATES.length, 'count');
    });

    await t('HTTP POST /api/templates/install -> 200/201 envelope', async () => {
      const r = await req({ port, method: 'POST', path: '/api/templates/install', headers: auth, body: '{}' });
      assert(r.status === 200 || r.status === 201, 'status ' + r.status);
      assert(r.json && r.json.ok === true, 'ok envelope');
      assert(typeof r.json.data.skipped === 'number', 'skipped number');
    });

    await t('HTTP templates without token -> 401', async () => {
      const r = await req({ port, path: '/api/templates' });
      assert(r.status === 401, 'status ' + r.status);
      assert(r.json && r.json.error.code === 'UNAUTHORIZED', 'code');
    });
  } finally {
    if (srv) await srv.close();
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
