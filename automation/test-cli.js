'use strict';
const assert = require('assert');
const { runCli } = require('./runtime/cli');

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

function cap() {
  const o = [];
  const e = [];
  return {
    out: (s) => {
      o.push(String(s));
    },
    err: (s) => {
      e.push(String(s));
    },
    outS: () => o.join('\n'),
    errS: () => e.join('\n'),
  };
}

function spy(impl) {
  const calls = [];
  const svc = {};
  for (const key of Object.keys(impl)) {
    const fn = impl[key];
    svc[key] = (...args) => {
      calls.push([key, ...args]);
      return Promise.resolve(fn(...args));
    };
  }
  return { svc, calls };
}

(async () => {
  await t('script list formats columns, exit 0', async () => {
    const c = cap();
    const { svc, calls } = spy({
      listScripts: () => ({
        ok: true,
        data: [
          { id: 's1', name: 'alpha', latestVersion: '1.0.0', updatedAt: '2026-09-01T00:00:00Z' },
          { id: 's2', name: 'beta', versions: [{ version: '2.1.0' }], updatedAt: '2026-09-02T00:00:00Z' },
        ],
      }),
    });
    const code = await runCli(['script', 'list'], svc, c);
    assert.strictEqual(code, 0);
    const text = c.outS();
    for (const h of ['id', 'name', 'latestVersion', 'updatedAt']) {
      assert.ok(text.includes(h), 'missing column ' + h);
    }
    assert.ok(text.includes('alpha'));
    assert.ok(text.includes('2.1.0'), 'versions[0] fallback');
    assert.deepStrictEqual(calls[0], ['listScripts']);
  });

  await t('script run SUCCESS exit 0; --param/--version/--profile passed', async () => {
    const c = cap();
    const { svc, calls } = spy({
      runScript: () => ({ ok: true, data: { executionId: 'e-1', status: 'SUCCESS' } }),
    });
    const code = await runCli(
      [
        'script',
        'run',
        's1',
        '--param',
        'account=x',
        '--param',
        'n=1',
        '--version',
        '1.0.2',
        '--profile',
        'p9',
      ],
      svc,
      c
    );
    assert.strictEqual(code, 0);
    assert.ok(c.outS().includes('e-1'));
    assert.ok(c.outS().includes('SUCCESS'));
    assert.deepStrictEqual(calls[0], [
      'runScript',
      's1',
      { params: { account: 'x', n: '1' }, version: '1.0.2', profile: 'p9' },
    ]);
  });

  await t('script run FAILED exit 1', async () => {
    const c = cap();
    const { svc } = spy({
      runScript: () => ({ ok: true, data: { executionId: 'e-2', status: 'FAILED' } }),
    });
    const code = await runCli(['script', 'run', 's1'], svc, c);
    assert.strictEqual(code, 1);
    assert.ok(c.outS().includes('FAILED'));
  });

  await t('script stop delegates cancel with id', async () => {
    const c = cap();
    const { svc, calls } = spy({ cancel: () => ({ ok: true, data: true }) });
    const code = await runCli(['script', 'stop', 'exec-9'], svc, c);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[0], ['cancel', 'exec-9']);
  });

  await t('task list --status QUEUED passes filter, prints total', async () => {
    const c = cap();
    const { svc, calls } = spy({
      listTasks: () => ({
        ok: true,
        data: { total: 1, rows: [{ id: 't1', scriptId: 's1', status: 'QUEUED', attempts: 0 }] },
      }),
    });
    const code = await runCli(['task', 'list', '--status', 'QUEUED'], svc, c);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[0], ['listTasks', { status: 'QUEUED' }]);
    assert.ok(c.outS().includes('t1'));
    assert.ok(c.outS().includes('total: 1'));
  });

  await t('task run enqueues (flags mapped, bare spec)', async () => {
    const c = cap();
    const { svc, calls } = spy({
      enqueueTask: () => ({ ok: true, data: { id: 't-9', status: 'QUEUED' } }),
    });
    let code = await runCli(
      ['task', 'run', 's1', '--param', 'a=1', '--version', '2.0.0', '--profile', 'p-1'],
      svc,
      c
    );
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[0], [
      'enqueueTask',
      { scriptId: 's1', params: { a: '1' }, version: '2.0.0', profileContext: { id: 'p-1' } },
    ]);
    assert.ok(c.outS().includes('t-9') && c.outS().includes('QUEUED'), 'prints taskId/status');
    code = await runCli(['task', 'run', 's2'], svc, cap());
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[1], ['enqueueTask', { scriptId: 's2' }]);
  });

  await t('profile start NOT_IMPLEMENTED, exit 2', async () => {
    const c = cap();
    const { svc } = spy({});
    const code = await runCli(['profile', 'start'], svc, c);
    assert.strictEqual(code, 2);
    assert.ok((c.outS() + c.errS()).includes('NOT_IMPLEMENTED'));
  });

  await t('status prints components', async () => {
    const c = cap();
    const { svc } = spy({
      status: () => ({ ok: true, data: { components: { queue: 'ok', store: 'ok' } } }),
    });
    const code = await runCli(['status'], svc, c);
    assert.strictEqual(code, 0);
    assert.ok(c.outS().includes('queue'));
    assert.ok(c.outS().includes('ok'));
  });

  await t('unknown command -> usage, exit 2', async () => {
    const c = cap();
    const { svc } = spy({});
    const code = await runCli(['frobnicate', 'x'], svc, c);
    assert.strictEqual(code, 2);
    assert.ok(/usage/i.test(c.errS()));
  });

  await t('--json emits parseable JSON for script get', async () => {
    const c = cap();
    const data = { id: 's1', name: 'alpha' };
    const { svc } = spy({ getScript: () => ({ ok: true, data }) });
    const code = await runCli(['script', 'get', 's1', '--json'], svc, c);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(c.outS()), data);
  });

  await t('service NOT_FOUND -> exit 3 + stderr contains code', async () => {
    const c = cap();
    const { svc } = spy({
      getScript: () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'script not found' } }),
    });
    const code = await runCli(['script', 'get', 'missing'], svc, c);
    assert.strictEqual(code, 3);
    assert.ok(c.errS().includes('NOT_FOUND'));
    assert.ok(c.errS().includes('script not found'));
  });

  await t('no args -> usage, exit 0', async () => {
    const c = cap();
    const { svc } = spy({});
    const code = await runCli([], svc, c);
    assert.strictEqual(code, 0);
    assert.ok(/usage/i.test(c.outS()));
  });

  await t('unknown flag -> usage, exit 2', async () => {
    const c = cap();
    const { svc } = spy({});
    const code = await runCli(['script', 'list', '--bogus'], svc, c);
    assert.strictEqual(code, 2);
    assert.ok(/usage/i.test(c.errS()));
  });

  await t('profile list prints table, exit 0', async () => {
    const c = cap();
    const svc = {
      profiles: {
        list: async () => ({
          ok: true,
          data: [{ id: 'p1', name: 'main', status: 'stopped', partition: 'persist:auto-p1' }],
        }),
      },
    };
    const code = await runCli(['profile', 'list'], svc, c);
    assert.strictEqual(code, 0);
    assert.ok(c.outS().includes('p1'));
    assert.ok(c.outS().includes('stopped'));
  });

  await t('profile start unknown id -> exit 3', async () => {
    const c = cap();
    const svc = {
      profiles: {
        start: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'profile not found: nope' } }),
      },
    };
    const code = await runCli(['profile', 'start', 'nope'], svc, c);
    assert.strictEqual(code, 3);
    assert.ok(c.errS().includes('NOT_FOUND'));
  });

  await t('profile list without profileManager -> NOT_IMPLEMENTED exit 2', async () => {
    const c = cap();
    const { svc } = spy({});
    const code = await runCli(['profile', 'list'], svc, c);
    assert.strictEqual(code, 2);
    assert.ok((c.outS() + c.errS()).includes('NOT_IMPLEMENTED'));
  });

  await t('profile fingerprint/rotate: delegates config+bearer, bad JSON usage exit 2', async () => {
    const c = cap();
    const calls = [];
    const svc = {
      profiles: {
        fingerprintUpdate: async (id, body) => {
          calls.push(['fingerprintUpdate', id, body]);
          return { ok: true, data: { ok: true, planes: ['blink'], restartRequired: false } };
        },
        fingerprintRotate: async (id, body) => {
          calls.push(['fingerprintRotate', id, body]);
          return { ok: true, data: { ok: true, planes: ['blink'], restarted: true } };
        },
      },
    };
    let code = await runCli(['profile', 'fingerprint', 'p1', '--config', '{"a":1}', '--bearer', 'b1'], svc, c);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[0], ['fingerprintUpdate', 'p1', { config: { a: 1 }, bearerToken: 'b1' }]);
    code = await runCli(['profile', 'rotate', 'p1', '--config', '{"a":1}'], svc, c);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[1], ['fingerprintRotate', 'p1', { config: { a: 1 }, bearerToken: undefined }]);
    code = await runCli(['profile', 'fingerprint', 'p1', '--config', 'not-json'], svc, c);
    assert.strictEqual(code, 2);
    code = await runCli(['profile', 'fingerprint', 'p1', '--config', '{"a":1}'], { profiles: {} }, c);
    assert.strictEqual(code, 2, 'unwired -> NOT_IMPLEMENTED exit 2');
  });

  await t('appended: metrics prints aggregates, exit 0', async () => {
    const c = cap();
    const svc = {
      metrics: {
        summary: () => ({ ok: true, data: { total: 2, byStatus: { SUCCESS: 1, FAILED: 1 }, running: 0, window: {} } }),
        failureRate: () => ({ ok: true, data: { failures: 1, total: 2, rate: 0.5 } }),
        crashRate: () => ({ ok: true, data: 0 }),
        durationStats: () => ({ ok: true, data: { count: 1, avgMs: 10, p50Ms: 10, p95Ms: 10, maxMs: 10 } }),
        topFailures: (kind) => ({ ok: true, data: [{ key: kind + '-1', failures: 1, total: 1 }] }),
        hotSteps: () => ({ ok: true, data: [{ step: 'login', count: 1 }] }),
        volume: () => ({ ok: true, data: { bucketMs: 3600000, buckets: [{ ts: 1, started: 2, succeeded: 1, failed: 1 }] } }),
      },
    };
    const code = await runCli(['metrics'], svc, c);
    assert.strictEqual(code, 0);
    const text = c.outS();
    assert.ok(text.includes('total: 2'), text);
    assert.ok(text.includes('failureRate: 50.0% (1/2)'), text);
    assert.ok(text.includes('duration: count=1 avg=10ms p95=10ms'), text);
    assert.ok(text.includes('top script: script-1 1/1'), text);
    assert.ok(text.includes('top profile: profile-1 1/1'), text);
    assert.ok(text.includes('top site: site-1 1/1'), text);
    assert.ok(text.includes('hot step: login x1'), text);
    assert.ok(text.includes('24h volume: 2 started'), text);
  });

  await t('appended: metrics --json parses raw envelope', async () => {
    const c = cap();
    const svc = {
      metrics: {
        summary: () => ({ ok: true, data: { total: 1, byStatus: { SUCCESS: 1 }, running: 0, window: {} } }),
        failureRate: () => ({ ok: true, data: { failures: 0, total: 1, rate: 0 } }),
        crashRate: () => ({ ok: true, data: 0 }),
        durationStats: () => ({ ok: true, data: { count: 1, avgMs: 5, p50Ms: 5, p95Ms: 5, maxMs: 5 } }),
        topFailures: () => ({ ok: true, data: [] }),
        hotSteps: () => ({ ok: true, data: [] }),
        volume: () => ({ ok: true, data: { bucketMs: 3600000, buckets: [] } }),
      },
    };
    const code = await runCli(['metrics', '--json'], svc, c);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(c.outS());
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.data.summary.total, 1);
    assert.strictEqual(parsed.data.failureRate.rate, 0);
  });

  await t('script trust: needs --signature (exit 2), delegates with signature+actor', async () => {
    const c = cap();
    const { svc, calls } = spy({
      trustScript: () => ({ ok: true, data: { id: 's1', trusted: true, trustedVersion: '1.0.0' } }),
    });
    let code = await runCli(['script', 'trust', 's1'], svc, c);
    assert.strictEqual(code, 2, 'missing signature is usage error');
    code = await runCli(['script', 'trust', 's1', '--signature', 'ab'.repeat(32), '--actor', 'root'], svc, c);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[0], ['trustScript', 's1', { signature: 'ab'.repeat(32), actor: 'root' }]);
  });

  await t('script untrust: delegates id, exit 0', async () => {
    const c = cap();
    const { svc, calls } = spy({
      untrustScript: () => ({ ok: true, data: { id: 's1', trusted: false } }),
    });
    const code = await runCli(['script', 'untrust', 's1'], svc, c);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[0], ['untrustScript', 's1']);
  });

  await t('script trust service error surfaces exit code', async () => {
    const c = cap();
    const { svc } = spy({
      trustScript: () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'script not found: nope' } }),
    });
    const code = await runCli(['script', 'trust', 'nope', '--signature', 'x'], svc, c);
    assert.strictEqual(code, 3);
    assert.ok(c.errS().includes('NOT_FOUND'));
  });

  await t('appended: metrics-less service -> NOT_IMPLEMENTED exit 2', async () => {
    const c = cap();
    const { svc } = spy({});
    const code = await runCli(['metrics'], svc, c);
    assert.strictEqual(code, 2);
    assert.ok((c.outS() + c.errS()).includes('NOT_IMPLEMENTED'));
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
