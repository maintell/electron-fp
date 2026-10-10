// ponytail: envelope + error-mapping tests for the recorder service group over a mock controller.
'use strict';

const { createRecorderService } = require('./runtime/recorder-service');

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

function mockController(overrides) {
  return Object.assign(
    {
      start: async (opts) => ({ sessionId: 'rs-1', url: (opts && opts.url) || 'file:///x' }),
      drain: async () => ({ nodes: [{ type: 'goto' }, { type: 'click' }], count: 2 }),
      stop: async () => ({ ast: { nodes: [{ type: 'goto' }], meta: { url0: 'file:///x' } } }),
      state: () => ({ active: true, sessions: [{ sessionId: 'rs-1', profileId: 'p1', url: 'file:///x', nodes: 2 }], nodes: 2 }),
    },
    overrides || {}
  );
}

(async () => {
  await t('start pass-through envelope', async () => {
    const svc = createRecorderService({ controller: mockController() });
    const r = await svc.recorder.start({ url: 'file:///a' });
    assert(r.ok === true && r.data.sessionId === 'rs-1' && r.data.url === 'file:///a', JSON.stringify(r));
  });

  await t('drain pass-through: nodes array + count shape', async () => {
    const svc = createRecorderService({ controller: mockController() });
    const r = await svc.recorder.drain('rs-1');
    assert(r.ok === true, JSON.stringify(r));
    assert(Array.isArray(r.data.nodes) && r.data.count === r.data.nodes.length, 'shape=' + JSON.stringify(r.data));
    assert(r.data.count === 2, 'count=' + r.data.count);
  });

  await t('stop pass-through: ast envelope', async () => {
    const svc = createRecorderService({ controller: mockController() });
    const r = await svc.recorder.stop('rs-1');
    assert(r.ok === true && r.data.ast.nodes.length === 1 && r.data.ast.meta.url0 === 'file:///x', JSON.stringify(r));
  });

  await t('state pass-through', async () => {
    const svc = createRecorderService({ controller: mockController() });
    const r = svc.recorder.state();
    assert(r.ok === true && r.data.active === true && r.data.sessions[0].sessionId === 'rs-1', JSON.stringify(r));
  });

  await t('controller error -> mapped code (e.code first, message fallback)', async () => {
    const notFound = createRecorderService({ controller: mockController({ drain: async () => { const e = new Error('nope'); e.code = 'NOT_FOUND'; throw e; } }) });
    const r1 = await notFound.recorder.drain('x');
    assert(r1.ok === false && r1.error.code === 'NOT_FOUND', JSON.stringify(r1));

    const conflict = createRecorderService({ controller: mockController({ start: async () => { throw new Error('CONFLICT: busy'); } }) });
    const r2 = await conflict.recorder.start({});
    assert(r2.ok === false && r2.error.code === 'CONFLICT', JSON.stringify(r2));

    const validation = createRecorderService({ controller: mockController({ stop: async () => { throw new Error('bad input'); } }) });
    const r3 = await validation.recorder.stop('x');
    assert(r3.ok === false && r3.error.code === 'VALIDATION', JSON.stringify(r3));

    const internal = createRecorderService({ controller: mockController({ state: () => { throw new TypeError('boom'); } }) });
    const r4 = internal.recorder.state();
    assert(r4.ok === false && r4.error.code === 'INTERNAL', JSON.stringify(r4));
  });

  await t('no controller -> NOT_IMPLEMENTED for all four methods', async () => {
    const svc = createRecorderService({});
    const rs = await svc.recorder.start({});
    const rd = await svc.recorder.drain('x');
    const rt = await svc.recorder.stop('x');
    const st = svc.recorder.state();
    for (const r of [rs, rd, rt, st]) {
      assert(r.ok === false && r.error.code === 'NOT_IMPLEMENTED', JSON.stringify(r));
      assert(r.error.message === 'recorder controller not wired', r.error.message);
    }
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
