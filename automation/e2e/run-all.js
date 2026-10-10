'use strict';
// End-to-end business suite for the automation system (doc 09 functional flows).
// Runs against the REAL stack: serve.js + @fp-automation/core over HTTP for the
// HTTP-path flows, and an in-process short-timeout stack for timeout/cancel
// (which need execution control the blocking HTTP run route can't give).
// Output lines are PASS/FAIL/SKIP; exit 0 == every business flow green.
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createAutomationServer } = require('../bin/serve.js');
const { buildLocalStack } = require('../electron/wire');
const { createScriptRunner } = require('../runtime/script-runner');
const { connect } = require('../../sdk/core/index.js');
const { createTaskClient } = require('../../sdk/tasks/index.js');

let pass = 0;
let fail = 0;
let skip = 0;
function t(name, ok, detail) {
  if (ok === undefined) {
    skip++;
    console.log('SKIP ' + name);
  } else if (ok) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NO_BROWSER = { browser: false, cookies: false, storage: false, network: false, filesystem: false, process: false };

async function main() {
  const TOKEN = 'e2e-business-token';
  const storeFile = path.join(os.tmpdir(), 'fp-e2e-business-' + Date.now() + '.json');
  const srv = createAutomationServer({ port: 0, token: TOKEN, storeFile, concurrency: 2, schedulerTickMs: 50 });
  // In-process short-timeout stack for timeout/cancel.
  const direct = buildLocalStack({
    runnerFactory: () => createScriptRunner({ browserApi: undefined, timeoutMs: 400 }),
  });
  let info = null;
  try {
    info = await srv.start();
    const client = await connect({ url: info.url, token: info.token });
    const tasks = createTaskClient(client, { pollMs: 25, timeoutMs: 25000 });

    // ===== 1. script CRUD =====
    const created = await client.scripts.create({ name: 'e2e-crud', permissions: NO_BROWSER });
    t('CRUD create returns id', !!created && !!created.id);
    const got = await client.scripts.get(created.id);
    t('CRUD get by id', !!got && got.id === created.id);
    await client.scripts.update(created.id, { name: 'e2e-crud-renamed' });
    t('CRUD update name', (await client.scripts.get(created.id)).name === 'e2e-crud-renamed');
    const list = await client.scripts.list();
    const items = Array.isArray(list) ? list : list && (list.rows || list.items);
    t('CRUD list contains created', !!items && items.some((s) => s && s.id === created.id));
    const tmp = await client.scripts.create({ name: 'e2e-del', permissions: NO_BROWSER });
    await client.scripts.remove(tmp.id);
    let removed = false;
    try {
      await client.scripts.get(tmp.id);
    } catch (e) {
      removed = e.name === 'NotFoundError';
    }
    t('CRUD remove -> NotFoundError', removed);

    // ===== 2. syntax validation (invalid JS -> named failure, not a crash) =====
    const bad = await client.scripts.create({ name: 'e2e-syntax', permissions: NO_BROWSER });
    await client.scripts.saveVersion(bad.id, 'return (;');
    const rb = await client.scripts.run(bad.id, { profileContext: { id: 's' } });
    t('syntax error -> FAILED with a named error', rb.status === 'FAILED' && !!rb.error && typeof rb.error.name === 'string', JSON.stringify(rb).slice(0, 160));

    // ===== 3. run success =====
    const okScript = await client.scripts.create({ name: 'e2e-ok', permissions: NO_BROWSER });
    await client.scripts.saveVersion(okScript.id, 'return 42;');
    const rOk = await client.scripts.run(okScript.id, { profileContext: { id: 'p' } });
    t('run success -> SUCCESS', rOk.status === 'SUCCESS', rOk.status);
    t('run success -> result 42', rOk.result === 42, JSON.stringify(rOk.result));

    // ===== 4. throw =====
    const throwScript = await client.scripts.create({ name: 'e2e-throw', permissions: NO_BROWSER });
    await client.scripts.saveVersion(throwScript.id, 'throw new Error("boom");');
    const rThrow = await client.scripts.run(throwScript.id, { profileContext: { id: 'p' } });
    t('throw -> FAILED', rThrow.status === 'FAILED', rThrow.status);
    t('throw -> error carries message', !!rThrow.error && /boom/.test(String(rThrow.error.message)), JSON.stringify(rThrow.error));

    // ===== 5. timeout (direct short-timeout stack) =====
    const tScript = direct.store.create({ name: 'e2e-timeout', permissions: NO_BROWSER });
    direct.store.addVersion(tScript.id, 'await new Promise(() => {});');
    const rTimeout = await direct.service.run.runScript(tScript.id, { profileContext: { id: 'to' } });
    t('timeout -> TIMEOUT (TimeoutError)', rTimeout.ok === true && rTimeout.data.status === 'TIMEOUT' && rTimeout.data.error && rTimeout.data.error.name === 'TimeoutError', JSON.stringify(rTimeout).slice(0, 200));

    // ===== 6. cancel (direct stack, runCancellable + stop) =====
    const cScript = direct.store.create({ name: 'e2e-cancel', permissions: NO_BROWSER });
    direct.store.addVersion(cScript.id, 'await new Promise(() => {});'); // no setTimeout in the sandbox
    const canc = direct.service.run.runCancellable(cScript.id, { profileContext: { id: 'c' } });
    await sleep(120);
    const stopped = direct.service.run.stop(canc.data.executionId);
    t('cancel: stop accepted', stopped.ok === true, JSON.stringify(stopped).slice(0, 120));
    const recCancel = await canc.data.promise;
    t('cancel -> CANCELLED', recCancel.status === 'CANCELLED', recCancel.status);

    // ===== 7. multi-profile concurrency (task queue, 2 profiles) =====
    const mp = await client.scripts.create({ name: 'e2e-mp', permissions: NO_BROWSER });
    await client.scripts.saveVersion(mp.id, 'return 1;');
    const a = await client.tasks.enqueue({ scriptId: mp.id, profileContext: { id: 'p1' }, maxAttempts: 1 });
    const b = await client.tasks.enqueue({ scriptId: mp.id, profileContext: { id: 'p2' }, maxAttempts: 1 });
    const ra = await tasks.wait(a.id);
    const rbTask = await tasks.wait(b.id);
    t('multi-profile: task A SUCCESS', ra.item.status === 'SUCCESS', ra.item.status);
    t('multi-profile: task B SUCCESS', rbTask.item.status === 'SUCCESS', rbTask.item.status);

    // ===== 8. schedules (add / list / pause / resume / trigger / remove) =====
    const sch = await client.schedules.add({ scriptId: mp.id, type: 'cron', cron: '* * * * *', profileContexts: [{ id: 's1' }], maxAttempts: 1 });
    t('schedule add', !!sch && !!sch.id);
    const sl = await client.schedules.list({});
    const sitems = Array.isArray(sl) ? sl : sl && (sl.rows || sl.items);
    t('schedule list contains', !!sitems && sitems.some((x) => x && x.id === sch.id));
    t('schedule pause', !!(await client.schedules.pause(sch.id)));
    t('schedule resume', !!(await client.schedules.resume(sch.id)));
    const before = await tasks.list({});
    const beforeN = (before && before.total) || 0;
    await client.schedules.trigger(sch.id);
    let fired = false;
    for (let i = 0; i < 40; i++) {
      const now = await tasks.list({});
      if (((now && now.total) || 0) > beforeN) {
        fired = true;
        break;
      }
      await sleep(50);
    }
    t('schedule trigger enqueued a task', fired);
    await client.schedules.remove(sch.id);

    // ===== 9. import / export =====
    const ex = await client.scripts.exportOne(mp.id);
    t('export returns a document', !!ex && typeof ex === 'object');
    const imported = await client.scripts.importOne(ex);
    t('import creates a new script', !!imported && !!imported.id && imported.id !== mp.id, JSON.stringify(imported).slice(0, 120));

    // ===== 10. version switch =====
    const vs = await client.scripts.create({ name: 'e2e-version', permissions: NO_BROWSER });
    await client.scripts.saveVersion(vs.id, 'return 1;', 'v1');
    await client.scripts.saveVersion(vs.id, 'return 2;', 'v2');
    const rv1 = await client.scripts.run(vs.id, { version: 'v1', profileContext: { id: 'v' } });
    const rv2 = await client.scripts.run(vs.id, { version: 'v2', profileContext: { id: 'v' } });
    t('version switch: v1 -> 1', rv1.result === 1, JSON.stringify(rv1.result));
    t('version switch: v2 -> 2', rv2.result === 2, JSON.stringify(rv2.result));

    await client.close();
  } finally {
    try {
      await srv.stop();
    } catch (_) {}
    try {
      fs.unlinkSync(storeFile);
    } catch (_) {}
  }
}

main()
  .then(() => {
    console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
    process.exitCode = fail === 0 ? 0 : 1;
    const safety = setTimeout(() => process.exit(process.exitCode), 2000);
    if (typeof safety.unref === 'function') safety.unref();
  })
  .catch((e) => {
    fail++;
    console.log('FAIL suite threw :: ' + ((e && e.stack) || e));
    console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
    process.exit(1);
  });
