'use strict';
const assert = require('assert');
const { createIpcBridge, ALLOWED_CHANNELS, isSenderAllowed } = require('./runtime/ipc-bridge');

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

function goodSender(url) {
  return { getType: () => 'window', getURL: () => url || 'file:///app/index.html', id: 1 };
}
const evilSender = { getType: () => 'window', getURL: () => 'https://evil.com/', id: 2 };
const webviewSender = { getType: () => 'webview', getURL: () => 'file:///app/index.html', id: 3 };
const localhostSender = { getType: () => 'window', getURL: () => 'http://localhost:3000/app', id: 4 };
const exampleSender = { getType: () => 'window', getURL: () => 'http://example.com/', id: 5 };

function mkAudit() {
  const entries = [];
  const fn = (event, detail) => entries.push(Object.assign({ event }, detail));
  fn.entries = entries;
  fn.json = () => JSON.stringify(entries);
  return fn;
}

function mkService(overrides) {
  return Object.assign(
    {
      status: () => ({ ok: true, data: { service: 'automation' } }),
      scripts: {
        list: () => ({ ok: true, data: [] }),
        get: (id) => ({ ok: true, data: { id } }),
      },
      run: {
        runScript: (id) => ({ ok: true, data: { executionId: 'e1', status: 'SUCCESS', scriptId: id } }),
      },
      tasks: {
        listTasks: () => ({ ok: true, data: [] }),
      },
      schedules: {
        addSchedule: (spec) => ({ ok: true, data: spec }),
      },
    },
    overrides || {}
  );
}

function mockIpc() {
  const handlers = new Map();
  return {
    handle: (ch, fn) => {
      if (handlers.has(ch)) throw new Error('duplicate handler: ' + ch);
      handlers.set(ch, fn);
    },
    handlers,
  };
}

(async () => {
  await t('allowed sender + automation:status -> ok envelope', async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({ service: mkService(), audit });
    const res = await bridge.handle('automation:status', { sender: goodSender() });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.service, 'automation');
    assert.ok(audit.entries.some((e) => e.event === 'ipc-call' && e.channel === 'automation:status' && e.status === 'ok'));
  });

  await t('evil URL sender -> DENY + audit ipc-deny reason sender', async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({ service: mkService(), audit });
    const res = await bridge.handle('automation:status', { sender: evilSender });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'DENY');
    assert.strictEqual(res.error.message, 'sender not allowed'); // no leak
    const d = audit.entries.find((e) => e.event === 'ipc-deny');
    assert.ok(d, 'missing ipc-deny');
    assert.strictEqual(d.reason, 'sender');
    assert.strictEqual(d.url, 'https://evil.com/');
  });

  await t('unknown channel handle() -> DENY reason unknown-channel', async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({ service: mkService(), audit });
    const res = await bridge.handle('automation:evil', { sender: goodSender() });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'DENY');
    assert.strictEqual(res.error.message, 'channel not allowed');
    const d = audit.entries.find((e) => e.event === 'ipc-deny');
    assert.strictEqual(d.reason, 'unknown-channel');
    assert.strictEqual(d.channel, 'automation:evil');
  });

  await t('register: only allowlisted registered (count); outside channel throws', async () => {
    const bridge = createIpcBridge({ service: mkService(), audit: mkAudit() });
    const ipc = mockIpc();
    const registered = bridge.register(ipc);
    assert.strictEqual(registered.length, ALLOWED_CHANNELS.length);
    assert.strictEqual(ipc.handlers.size, ALLOWED_CHANNELS.length);
    assert.ok(ipc.handlers.has('automation:status'));
    assert.ok(!ipc.handlers.has('tab:create'));
    assert.throws(() => bridge.register(mockIpc(), ['automation:status', 'evil:channel']), /channel not allowed/);
    // registered handler routes through bridge
    const res = await ipc.handlers.get('automation:status')({ sender: goodSender() });
    assert.strictEqual(res.ok, true);
  });

  await t('webview frame sender -> DENY', async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({ service: mkService(), audit });
    const res = await bridge.handle('automation:status', { sender: webviewSender });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'DENY');
    assert.strictEqual(audit.entries.find((e) => e.event === 'ipc-deny').reason, 'sender');
  });

  await t("service throws Error('script not found') -> NOT_FOUND + audit", async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({
      service: mkService({
        scripts: {
          get: () => {
            throw new Error('script not found');
          },
        },
      }),
      audit,
    });
    const res = await bridge.handle('automation:scripts:get', { sender: goodSender() }, 'nope');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'NOT_FOUND');
    assert.strictEqual(res.error.message, 'script not found');
    const c = audit.entries.find((e) => e.event === 'ipc-call');
    assert.ok(c, 'missing ipc-call audit');
    assert.strictEqual(c.status, 'error');
    assert.strictEqual(c.code, 'NOT_FOUND');
  });

  await t("service throw non-notfound -> INTERNAL", async () => {
    const bridge = createIpcBridge({
      service: mkService({
        scripts: {
          list: () => {
            throw new TypeError('boom');
          },
        },
      }),
      audit: mkAudit(),
    });
    const res = await bridge.handle('automation:scripts:list', { sender: goodSender() });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'INTERNAL');
  });

  await t("success audit ipc-call present, args NOT in audit (no 'hunter2')", async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({ service: mkService(), audit });
    const res = await bridge.handle('automation:run', { sender: goodSender() }, 's1', {
      params: { password: 'hunter2' },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.executionId, 'e1');
    const c = audit.entries.find((e) => e.event === 'ipc-call' && e.channel === 'automation:run');
    assert.ok(c, 'missing ipc-call');
    assert.strictEqual(c.status, 'ok');
    assert.ok(!audit.json().includes('hunter2'), 'secret leaked into audit');
    assert.ok(!audit.json().includes('password'));
  });

  await t('default policy: file:// + http://localhost allowed; http://example.com denied', async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({ service: mkService(), audit });
    assert.strictEqual((await bridge.handle('automation:status', { sender: goodSender() })).ok, true);
    assert.strictEqual((await bridge.handle('automation:status', { sender: localhostSender })).ok, true);
    const res = await bridge.handle('automation:status', { sender: exampleSender });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'DENY');
  });

  await t('explicit allowedSenders urlPrefix rules', async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({
      service: mkService(),
      audit,
      allowedSenders: [{ urlPrefix: 'https://trusted.example/' }],
    });
    assert.strictEqual(
      (await bridge.handle('automation:status', { sender: { getType: () => 'window', getURL: () => 'https://trusted.example/app' } })).ok,
      true
    );
    // default-allowed file:// now needs explicit rule
    assert.strictEqual((await bridge.handle('automation:status', { sender: goodSender() })).ok, false);
    // webview still denied even with matching prefix
    const wv = { getType: () => 'webview', getURL: () => 'https://trusted.example/app' };
    assert.strictEqual((await bridge.handle('automation:status', { sender: wv })).ok, false);
  });

  await t('isSenderAllowed exported for tests', () => {
    assert.strictEqual(isSenderAllowed(goodSender()), true);
    assert.strictEqual(isSenderAllowed(evilSender), false);
    assert.strictEqual(isSenderAllowed(webviewSender), false);
    assert.strictEqual(isSenderAllowed(null), false);
    assert.strictEqual(isSenderAllowed({}), false);
    assert.strictEqual(isSenderAllowed(goodSender('https://evil.com/')), false);
    assert.strictEqual(isSenderAllowed({ getType: () => 'window', getURL: () => 'https://x/' }, [{ urlPrefix: 'https://x/' }]), true);
  });

  await t('missing event/sender -> DENY (no crash)', async () => {
    const audit = mkAudit();
    const bridge = createIpcBridge({ service: mkService(), audit });
    assert.strictEqual((await bridge.handle('automation:status', undefined)).ok, false);
    assert.strictEqual((await bridge.handle('automation:status', {})).ok, false);
    assert.strictEqual((await bridge.handle('automation:status', { sender: null })).ok, false);
  });

  await t('ALLOWED_CHANNELS frozen, 54 entries, unique', async () => {
    assert.ok(Object.isFrozen(ALLOWED_CHANNELS));
    assert.strictEqual(ALLOWED_CHANNELS.length, 54);
    assert.strictEqual(new Set(ALLOWED_CHANNELS).size, ALLOWED_CHANNELS.length);
    for (const ch of ALLOWED_CHANNELS) assert.ok(ch.startsWith('automation:'), ch);
  });

  await t('profiles channels roundtrip + evil sender denied', async () => {
    const audit = mkAudit();
    const service = mkService({
      profiles: {
        list: () => ({ ok: true, data: [{ id: 'p1' }] }),
        start: async (id) => ({ ok: true, data: { id, status: 'running' } }),
        status: (id) => ({ ok: true, data: { id, status: 'running', endpoint: null } }),
      },
    });
    const bridge = createIpcBridge({ service, audit });
    const ev = { sender: goodSender() };
    const list = await bridge.handle('automation:profiles:list', ev, {});
    assert.strictEqual(list.ok, true);
    assert.strictEqual(list.data[0].id, 'p1');
    const st = await bridge.handle('automation:profiles:start', ev, 'p1');
    assert.strictEqual(st.data.status, 'running');
    const denied = await bridge.handle('automation:profiles:list', { sender: evilSender }, {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'DENY');
  });

  await t('recorder channels roundtrip + evil sender denied', async () => {
    const audit = mkAudit();
    const service = mkService({
      recorder: {
        start: async () => ({ ok: true, data: { sessionId: 'rs1', url: 'file:///x' } }),
        drain: async () => ({ ok: true, data: { nodes: [{ type: 'click' }], count: 1 } }),
        stop: async () => ({ ok: true, data: { ast: { nodes: [{ type: 'click' }], meta: { url0: 'file:///x' } } } }),
        state: () => ({ ok: true, data: { active: true, sessions: [{ sessionId: 'rs1', nodes: 1 }], nodes: 1 } }),
      },
    });
    const bridge = createIpcBridge({ service, audit });
    const ev = { sender: goodSender() };
    for (const ch of ['automation:recorder:start', 'automation:recorder:drain', 'automation:recorder:stop', 'automation:recorder:state']) {
      assert.ok(ALLOWED_CHANNELS.includes(ch), 'missing ' + ch);
    }
    const s = await bridge.handle('automation:recorder:start', ev, { url: 'file:///x' });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.data.sessionId, 'rs1');
    const d = await bridge.handle('automation:recorder:drain', ev, 'rs1');
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.data.count, 1);
    const st = await bridge.handle('automation:recorder:stop', ev, 'rs1');
    assert.strictEqual(st.data.ast.nodes.length, 1);
    const state = await bridge.handle('automation:recorder:state', ev);
    assert.strictEqual(state.data.active, true);
    const denied = await bridge.handle('automation:recorder:start', { sender: evilSender }, {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'DENY');
  });

  await t('rpa channels roundtrip + evil sender denied', async () => {
    const audit = mkAudit();
    const service = mkService({
      rpa: {
        validate: (flow) => ({ ok: true, data: { ok: true, errors: [] } }),
        save: (flow) => ({ ok: true, data: { id: 's1', name: flow.name, nodes: flow.nodes } }),
        load: () => ({ ok: true, data: { name: 'flow', nodes: [{ type: 'goto', url: 'x' }] } }),
        replay: (flow, opts) => ({ ok: true, data: { executionId: 'ex1' } }),
      },
    });
    const bridge = createIpcBridge({ service, audit });
    const ev = { sender: goodSender() };
    for (const ch of ['automation:rpa:validate', 'automation:rpa:save', 'automation:rpa:load', 'automation:rpa:replay']) {
      assert.ok(ALLOWED_CHANNELS.includes(ch), 'missing ' + ch);
    }
    const v = await bridge.handle('automation:rpa:validate', ev, { name: 'f', nodes: [] });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.data.ok, true);
    const s = await bridge.handle('automation:rpa:save', ev, { name: 'f', nodes: [] });
    assert.strictEqual(s.data.id, 's1');
    const l = await bridge.handle('automation:rpa:load', ev);
    assert.strictEqual(l.data.nodes.length, 1);
    const r = await bridge.handle('automation:rpa:replay', ev, { name: 'f', nodes: [] }, { profileContext: { id: 'g' } });
    assert.strictEqual(r.data.executionId, 'ex1');
    const denied = await bridge.handle('automation:rpa:save', { sender: evilSender }, {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'DENY');
  });

  await t('fingerprintUpdate channel roundtrip + evil sender denied', async () => {
    const audit = mkAudit();
    const service = mkService({
      profiles: {
        fingerprintUpdate: async (id, body) => ({ ok: true, data: { ok: true, planes: ['blink'], restartRequired: false } }),
      },
    });
    const bridge = createIpcBridge({ service, audit });
    assert.ok(ALLOWED_CHANNELS.includes('automation:profiles:fingerprintUpdate'), 'missing channel');
    const ev = { sender: goodSender() };
    const r = await bridge.handle('automation:profiles:fingerprintUpdate', ev, 'p1', { config: { hardware_concurrency: 8 } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.data.planes, ['blink']);
    const denied = await bridge.handle('automation:profiles:fingerprintUpdate', { sender: evilSender }, 'p1', { config: {} });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'DENY');
  });

  await t('audit channels roundtrip + evil sender denied', async () => {
    const audit = mkAudit();
    const service = mkService({
      audit: {
        query: () => ({ ok: true, data: { total: 2, rows: [{ action: 'state' }] } }),
        stats: () => ({ ok: true, data: { total: 2, buffered: 2, byAction: { state: 2 } } }),
      },
    });
    const bridge = createIpcBridge({ service, audit });
    assert.ok(ALLOWED_CHANNELS.includes('automation:audit:query'), 'missing query');
    assert.ok(ALLOWED_CHANNELS.includes('automation:audit:stats'), 'missing stats');
    const q = await bridge.handle('automation:audit:query', { sender: goodSender() }, { action: 'state' });
    assert.strictEqual(q.ok, true);
    assert.strictEqual(q.data.total, 2);
    const denied = await bridge.handle('automation:audit:query', { sender: evilSender }, {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'DENY');
  });

  await t('metrics channel roundtrip + evil sender denied', async () => {
    const audit = mkAudit();
    const service = mkService({
      metrics: {
        summary: () => ({ ok: true, data: { total: 3, byStatus: { SUCCESS: 2, FAILED: 1 }, running: 0, window: {} } }),
      },
    });
    const bridge = createIpcBridge({ service, audit });
    assert.ok(ALLOWED_CHANNELS.includes('automation:metrics'), 'missing automation:metrics');
    const r = await bridge.handle('automation:metrics', { sender: goodSender() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.total, 3);
    const denied = await bridge.handle('automation:metrics', { sender: evilSender });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'DENY');
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
