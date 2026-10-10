'use strict';
const assert = require('assert');
const { buildLocalService, attachAutomation } = require('./electron/wire');
const { ALLOWED_CHANNELS } = require('./runtime/ipc-bridge');

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

function mockIpc() {
  const handlers = new Map();
  return {
    handle: (ch, fn) => {
      if (handlers.has(ch)) throw new Error('dup:' + ch);
      handlers.set(ch, fn);
    },
    handlers,
  };
}

const goodEv = { sender: { getType: () => 'window', getURL: () => 'file:///app/index.html' } };

(async () => {
  await t('attachAutomation registers all allowlisted channels on mock ipcMain', async () => {
    const service = buildLocalService({});
    const ipc = mockIpc();
    const { registered } = attachAutomation({ ipcMain: ipc, service });
    assert.strictEqual(registered.length, ALLOWED_CHANNELS.length);
    assert.strictEqual(ipc.handlers.size, ALLOWED_CHANNELS.length);
  });

  await t('registered handler end-to-end: status ok, audit query ok (central collector)', async () => {
    const service = buildLocalService({});
    const ipc = mockIpc();
    attachAutomation({ ipcMain: ipc, service });
    const status = await ipc.handlers.get('automation:status')(goodEv);
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.data.service, 'automation');
    const q = await ipc.handlers.get('automation:audit:query')(goodEv, { limit: 5 });
    assert.strictEqual(q.ok, true);
    assert.strictEqual(typeof q.data.total, 'number');
    assert.ok(Array.isArray(q.data.rows));
  });

  await t('scripts roundtrip through registered handler', async () => {
    const service = buildLocalService({});
    const ipc = mockIpc();
    attachAutomation({ ipcMain: ipc, service });
    const created = await ipc.handlers.get('automation:scripts:create')(goodEv, {
      name: 'wire-1',
      code: "console.log('w')",
      permissions: {},
      parameters: [],
    });
    assert.strictEqual(created.ok, true);
    const got = await ipc.handlers.get('automation:scripts:get')(goodEv, created.data.id);
    assert.strictEqual(got.ok, true);
    assert.strictEqual(got.data.name, 'wire-1');
  });

  await t('attachAutomation throws without ipcMain/service', async () => {
    assert.throws(() => attachAutomation({ service: buildLocalService({}) }), /ipcMain/);
    assert.throws(() => attachAutomation({ ipcMain: mockIpc() }), /service required/);
  });

  await t('emit delivers via mock push (channel+payload passthrough, returns true)', async () => {
    const service = buildLocalService({});
    const ipc = mockIpc();
    const seen = [];
    const { emit } = attachAutomation({ ipcMain: ipc, service, push: (ch, payload) => { seen.push([ch, payload]); } });
    assert.strictEqual(emit('automation:event', { n: 1 }), true);
    assert.deepStrictEqual(seen, [['automation:event', { n: 1 }]]);
  });

  await t('no-push attach: emit returns false', async () => {
    const service = buildLocalService({});
    const { emit } = attachAutomation({ ipcMain: mockIpc(), service });
    assert.strictEqual(emit('automation:event', {}), false);
  });

  await t('push-throws: emit returns false (no throw)', async () => {
    const service = buildLocalService({});
    const { emit } = attachAutomation({ ipcMain: mockIpc(), service, push: () => { throw new Error('dead'); } });
    assert.strictEqual(emit('automation:event', {}), false);
  });

  await t('live-log e2e: run streams {executionId,line} via mock push', async () => {
    const stubRunner = () => ({
      run: async (spec, params, opts) => {
        if (opts && typeof opts.onLog === 'function') opts.onLog({ ts: 1, level: 'info', args: ['hi'] });
        return { status: 'SUCCESS', result: 1, logs: [], endTime: Date.now() };
      },
    });
    const service = buildLocalService({ runnerFactory: stubRunner });
    const ipc = mockIpc();
    const pushed = [];
    attachAutomation({ ipcMain: ipc, service, push: (ch, payload) => { pushed.push([ch, payload]); } });
    const created = await ipc.handlers.get('automation:scripts:create')(goodEv, {
      name: 'wire-live',
      code: "console.log('hi')",
      permissions: {},
      parameters: [],
    });
    assert.strictEqual(created.ok, true);
    const ran = await ipc.handlers.get('automation:run')(goodEv, created.data.id, {});
    assert.strictEqual(ran.ok, true);
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0][0], 'automation:event');
    assert.strictEqual(typeof pushed[0][1].executionId, 'string');
    assert.deepStrictEqual(pushed[0][1].line, { ts: 1, level: 'info', args: ['hi'] });
  });

  await t('main.js hook present (attachAutomation string assert)', async () => {
    const fs = require('fs');
    const path = require('path');
    const text = fs.readFileSync(path.join(__dirname, '..', 'Client', 'main.js'), 'utf8');
    assert.ok(text.includes('attachAutomation'), 'main.js must contain attachAutomation');
  });

  await t('profiles wired over IPC: create/start/status via handlers', async () => {
    const fakePM = {
      list: () => [{ id: 'p1', status: 'stopped' }],
      get: (id) => (id === 'p1' ? { id: 'p1', status: 'stopped' } : undefined),
      create: (s) => ({ id: 'p1', name: (s && s.name) || 'p', status: 'stopped' }),
      update: (id, p) => ({ id, status: 'stopped', ...(p || {}) }),
      remove: (id) => ({ id, removed: true }),
      start: async (id) => ({ id, status: 'running', endpoint: { wsEndpoint: 'ws://ipc' } }),
      stop: async (id) => ({ id, status: 'stopped' }),
      status: (id) => ({ id, status: 'running', endpoint: { wsEndpoint: 'ws://ipc' } }),
      bulkStart: async (ids) => ({ started: ids, failed: [] }),
    };
    const service = buildLocalService({ profileManager: fakePM });
    const ipc = mockIpc();
    attachAutomation({ ipcMain: ipc, service });
    const created = await ipc.handlers.get('automation:profiles:create')(goodEv, { name: 'p' });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.data.id, 'p1');
    const started = await ipc.handlers.get('automation:profiles:start')(goodEv, 'p1');
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.data.status, 'running');
    assert.strictEqual(started.data.endpoint.wsEndpoint, 'ws://ipc');
    const st = await ipc.handlers.get('automation:profiles:status')(goodEv, 'p1');
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.data.endpoint.wsEndpoint, 'ws://ipc');
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
