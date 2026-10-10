'use strict';
// Smoke test for @fp-automation/tasks:
//  1. submit a task and poll to terminal  -> SUCCESS, result propagated
//  2. a throwing script -> FAILED (proves the failure terminal)
//  3. tasks.list returns the items
//  4. schedules: add / list / remove
// PASS/FAIL lines; exit 0 == the tasks layer works end-to-end.
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createAutomationServer } = require('../../../automation/bin/serve.js');
const { connect } = require('../../core/index.js');
const { createTaskClient, TERMINAL } = require('../index.js');

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

(async () => {
  const TOKEN = 'sdk-tasks-smoke-token';
  const storeFile = path.join(os.tmpdir(), 'fp-sdk-tasks-smoke-' + Date.now() + '.json');
  const srv = createAutomationServer({ port: 0, token: TOKEN, storeFile, concurrency: 2, schedulerTickMs: 50 });
  let info = null;
  try {
    info = await srv.start();
    const client = await connect({ url: info.url, token: info.token });
    const tasks = createTaskClient(client, { pollMs: 25, timeoutMs: 20000 });

    // 1. success path
    const NO_BROWSER = { browser: false, cookies: false, storage: false, network: false };
    const s = await client.scripts.create({ name: 'tasks-smoke-ok', permissions: NO_BROWSER });
    await client.scripts.saveVersion(s.id, 'return 42;');
    const ok = await tasks.runToTerminal({ scriptId: s.id, maxAttempts: 1 });
    t('task reached a terminal state', TERMINAL.indexOf(ok.item.status) !== -1, ok.item.status);
    t('success path -> SUCCESS', ok.item.status === 'SUCCESS', ok.item.status + ' lastError=' + JSON.stringify(ok.item.lastError));
    t('state flow observed (QUEUED .. SUCCESS)', ok.states[0] === 'QUEUED' && ok.states.indexOf('SUCCESS') !== -1, ok.states.join('>'));
    t('result propagated (42)', ok.item.result === 42, JSON.stringify(ok.item.result));

    // 2. failure path
    const f = await client.scripts.create({ name: 'tasks-smoke-fail', permissions: NO_BROWSER });
    await client.scripts.saveVersion(f.id, 'throw new Error("boom");');
    const bad = await tasks.runToTerminal({ scriptId: f.id, maxAttempts: 1 });
    t('failure path -> FAILED', bad.item.status === 'FAILED', bad.item.status);

    // 3. queue listing
    const list = await tasks.list({});
    const items = Array.isArray(list) ? list : list && (list.rows || list.items);
    t('tasks.list returns items', !!items && items.length >= 2, JSON.stringify(list).slice(0, 140));

    // 4. schedules
    const sched = await tasks.schedules.add({ scriptId: s.id, type: 'cron', cron: '* * * * *', profileContexts: [{ id: 'default' }] });
    t('schedule added', !!sched && !!sched.id, JSON.stringify(sched).slice(0, 140));
    const sl = await tasks.schedules.list({});
    const sitems = Array.isArray(sl) ? sl : sl && sl.items;
    t('schedule listed', !!sitems && sitems.some((x) => x && x.id === sched.id));
    await tasks.schedules.remove(sched.id);

    await client.close();
  } finally {
    try {
      await srv.stop();
    } catch (_) {}
    try {
      fs.unlinkSync(storeFile);
    } catch (_) {}
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
  const safety = setTimeout(() => process.exit(process.exitCode), 2000);
  if (typeof safety.unref === 'function') safety.unref();
})().catch((e) => {
  fail++;
  console.log('FAIL smoke threw :: ' + ((e && e.stack) || e));
  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(1);
});
