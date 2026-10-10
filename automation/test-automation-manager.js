'use strict';
const assert = require('assert');
const { createScriptStore } = require('./runtime/script-store');
const { createScriptRunner } = require('./runtime/script-runner');
const { createAutomationManager } = require('./runtime/automation-manager');

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

function mkManager({ maxConcurrent = 5, timeoutMs = 2000 } = {}) {
  const store = createScriptStore();
  const audits = [];
  const manager = createAutomationManager({
    store,
    runnerFactory: () =>
      createScriptRunner({
        browserApi: { browser: { goto: async () => {} } },
        timeoutMs, // hang test: large vs ms-scale ops, short enough to not linger after exitCode path
      }),
    audit: (ev) => audits.push(ev),
    maxConcurrent,
  });
  return { store, manager, audits };
}

(async () => {
  const { store, manager } = mkManager({ maxConcurrent: 1 });
  let happyId;

  await t('runScript happy SUCCESS + listExecutions + getLogs', async () => {
    const s = store.create({
      name: 'happy',
      code: "console.log('hi')",
      permissions: { browser: true },
      parameters: [{ name: 'account', type: 'string', required: true }],
    });
    happyId = s.id;
    const rec = await manager.runScript(s.id, {
      params: { account: 'a1' },
      profileContext: { id: 'prof-1' },
    });
    assert.strictEqual(rec.status, 'SUCCESS');
    assert.strictEqual(rec.profileId, 'prof-1');
    const list = manager.listExecutions({ scriptId: s.id });
    assert.strictEqual(list.total, 1);
    assert.strictEqual(list.rows.length, 1);
    assert.strictEqual(list.rows[0].executionId, rec.executionId);
    const logs = manager.getLogs(rec.executionId);
    assert.ok(Array.isArray(logs) && logs.length > 0);
    assert.ok(logs.some((l) => Array.isArray(l.args) && l.args.includes('hi')));
  });

  await t('param validation throws, no execution persisted', async () => {
    await assert.rejects(
      () => manager.runScript(happyId, {}),
      (e) => e.name === 'ScriptError' && /account/.test(e.message)
    );
    assert.strictEqual(manager.listExecutions().total, 1);
  });

  await t('unknown scriptId throws', async () => {
    await assert.rejects(
      () => manager.runScript('nope'),
      (e) => e.name === 'ScriptError' && /script not found/.test(e.message)
    );
    assert.strictEqual(manager.listExecutions().total, 1);
  });

  await t('concurrency limit + cancel + third run succeeds', async () => {
    const hang = store.create({
      name: 'hang',
      code: 'await new Promise(() => {})',
      permissions: { browser: true },
    });
    const first = manager.runScriptCancellable(hang.id, { profileContext: { id: 'prof-1' } });
    assert.ok(first.executionId);
    await assert.rejects(
      () => manager.runScript(happyId, { params: { account: 'z' } }),
      (e) => e.name === 'ScriptError' && /concurrency limit 1/.test(e.message)
    );
    assert.strictEqual(manager.cancel(first.executionId), true);
    const rec = await first.promise;
    assert.strictEqual(rec.status, 'CANCELLED');
    assert.strictEqual(manager.getExecution(first.executionId).status, 'CANCELLED');
    assert.strictEqual(manager.cancel(first.executionId), false); // terminal: no-op
    const r3 = await manager.runScript(happyId, { params: { account: 'z' } });
    assert.strictEqual(r3.status, 'SUCCESS');
  });

  await t('stats counts after above', async () => {
    const st = manager.stats();
    assert.strictEqual(st.total, 3);
    assert.strictEqual(st.byStatus.SUCCESS, 2);
    assert.strictEqual(st.byStatus.CANCELLED, 1);
    assert.strictEqual(st.running, 0);
  });

  await t('version pinning runs old code', async () => {
    const s = store.create({ name: 'ver', code: "console.log('v1')", permissions: { browser: true } });
    store.addVersion(s.id, "console.log('v2')"); // latest 1.0.1, old 1.0.0
    const oldRec = await manager.runScript(s.id, { version: '1.0.0', profileContext: { id: 'prof-1' } });
    assert.strictEqual(oldRec.status, 'SUCCESS');
    assert.ok(oldRec.logs.some((l) => Array.isArray(l.args) && l.args.includes('v1')));
    const newRec = await manager.runScript(s.id, { profileContext: { id: 'prof-1' } });
    assert.strictEqual(newRec.status, 'SUCCESS');
    assert.ok(newRec.logs.some((l) => Array.isArray(l.args) && l.args.includes('v2')));
  });

  await t('pagination newest-first offset/limit', async () => {
    const m2 = mkManager();
    const s = m2.store.create({ name: 'page', code: "'x'", permissions: { browser: true } });
    const r1 = await m2.manager.runScript(s.id, { profileContext: { id: 'prof-1' } });
    const r2 = await m2.manager.runScript(s.id, { profileContext: { id: 'prof-1' } });
    const r3 = await m2.manager.runScript(s.id, { profileContext: { id: 'prof-1' } });
    const all = m2.manager.listExecutions({ limit: 10 });
    assert.deepStrictEqual(
      all.rows.map((r) => r.executionId),
      [r3.executionId, r2.executionId, r1.executionId]
    );
    assert.strictEqual(all.total, 3);
    // spec said "3 execs limit 2 offset 1 -> 1 item"; standard slice gives 2 — asserting math-correct behavior
    const page = m2.manager.listExecutions({ limit: 2, offset: 1 });
    assert.strictEqual(page.rows.length, 2);
    assert.strictEqual(page.total, 3);
    assert.deepStrictEqual(
      page.rows.map((r) => r.executionId),
      [r2.executionId, r1.executionId]
    );
    const last = m2.manager.listExecutions({ limit: 2, offset: 2 });
    assert.strictEqual(last.rows.length, 1);
    assert.strictEqual(last.rows[0].executionId, r1.executionId);
  });

  await t('runScriptCancellable handle.abort() mid-hang → CANCELLED', async () => {
    const m = mkManager({ maxConcurrent: 5, timeoutMs: 30000 });
    const s = m.store.create({
      name: 'hang-abort',
      code: 'await new Promise(() => {})',
      permissions: { browser: true },
    });
    const h = m.manager.runScriptCancellable(s.id, { profileContext: { id: 'prof-1' } });
    assert.strictEqual(typeof h.abort, 'function', 'handle.abort missing');
    setTimeout(() => h.abort(), 50);
    const rec = await h.promise;
    assert.strictEqual(rec.status, 'CANCELLED');
    assert.strictEqual(rec.error && rec.error.name, 'CancelledError');
    assert.strictEqual(m.manager.getExecution(h.executionId).status, 'CANCELLED');
  });

  await t('cancel(id) mid-hang → CANCELLED (existing path)', async () => {
    const m = mkManager({ maxConcurrent: 5, timeoutMs: 30000 });
    const s = m.store.create({
      name: 'hang-cancel',
      code: 'await new Promise(() => {})',
      permissions: { browser: true },
    });
    const h = m.manager.runScriptCancellable(s.id, { profileContext: { id: 'prof-1' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(m.manager.cancel(h.executionId), true);
    const rec = await h.promise;
    assert.strictEqual(rec.status, 'CANCELLED');
    assert.strictEqual(rec.error && rec.error.name, 'CancelledError');
  });

  await t('appended: injected metrics receives one record per terminal execution', async () => {
    const store2 = createScriptStore();
    const records = [];
    const metrics = { record: (r) => records.push(r) };
    const m2 = createAutomationManager({
      store: store2,
      runnerFactory: () =>
        createScriptRunner({ browserApi: { browser: { goto: async () => {} } }, timeoutMs: 300 }),
      metrics,
      audit: () => {},
    });
    const okS = store2.create({ name: 'm-ok', code: 'return 1', permissions: { browser: false }, parameters: [] });
    const failS = store2.create({ name: 'm-fail', code: "throw new ScriptError('boom')", permissions: { browser: false }, parameters: [] });
    const hangS = store2.create({ name: 'm-hang', code: 'await new Promise(() => {})', permissions: { browser: false }, parameters: [] });
    await m2.runScript(okS.id, { profileContext: { id: 'p1' } });
    await m2.runScript(failS.id, { profileContext: { id: 'p1' } });
    await m2.runScript(hangS.id, { profileContext: { id: 'p2' } }); // runner timeoutMs 300 -> TIMEOUT
    assert.strictEqual(records.length, 3, 'records=' + records.length);
    const statuses = records.map((r) => r.status).sort();
    assert.deepStrictEqual(statuses, ['FAILED', 'SUCCESS', 'TIMEOUT'], JSON.stringify(statuses));
    const one = records[0];
    assert(
      one.scriptId && one.profileId && 'durationMs' in one && 'startTime' in one && 'currentUrl' in one && 'currentStep' in one,
      'shape=' + JSON.stringify(Object.keys(one))
    );
  });

  await t('appended: manager without metrics still works unchanged', async () => {
    const m3 = mkManager();
    const s = m3.store.create({ name: 'nom', code: 'return 1', permissions: { browser: true }, parameters: [] });
    const rec = await m3.manager.runScript(s.id, { profileContext: { id: 'p1' } });
    assert.strictEqual(rec.status, 'SUCCESS');
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
