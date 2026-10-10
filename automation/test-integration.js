// ponytail: cross-layer integration (store -> service -> HTTP -> CLI) with one shared stack.
// Scope: Node-level, fake launcher. Real-browser E2E = probe-automation-smoke.js (Electron).
'use strict';

const http = require('http');
const { createScriptStore } = require('./runtime/script-store');
const { createScriptRunner } = require('./runtime/script-runner');
const { createAutomationManager } = require('./runtime/automation-manager');
const { createTaskQueue } = require('./runtime/task-queue');
const { createScheduler } = require('./runtime/scheduler');
const { createProfileManager } = require('./runtime/profile-manager');
const { createAutomationService } = require('./runtime/automation-service');
const { createHttpApi } = require('./runtime/http-api');
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
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) {
      const buf = Buffer.from(body);
      r.setHeader('Content-Length', buf.length);
      r.setHeader('Content-Type', 'application/json');
      r.write(buf);
    }
    r.end();
  });
}

function cap() {
  const o = [];
  const e = [];
  return { out: (s) => o.push(String(s)), err: (s) => e.push(String(s)), outS: () => o.join('\n'), errS: () => e.join('\n') };
}

(async () => {
  const TOKEN = 'integ-token';
  const store = createScriptStore();
  const manager = createAutomationManager({
    store,
    runnerFactory: () => createScriptRunner({ browserApi: { browser: { goto: async () => {} } }, timeoutMs: 5000 }),
    audit: () => {},
  });
  const queue = createTaskQueue({ audit: () => {} });
  const scheduler = createScheduler({ audit: () => {}, onFire: () => {} });
  const profileManager = createProfileManager({
    launcher: { start: async () => ({ wsEndpoint: 'ws://integ', debugPort: 1 }), stop: async () => {} },
  });
  const svc = createAutomationService({ store, manager, queue, scheduler, profileManager });
  // flat CLI façade mirrors bin/browser-cli.js; cli.js reads service.profiles grouped
  const cliSvc = {
    listScripts: () => svc.scripts.list(),
    getScript: (id) => svc.scripts.get(id),
    runScript: (id, opts = {}) =>
      svc.run.runScript(id, { version: opts.version, params: opts.params, profileContext: opts.profile !== undefined ? { id: opts.profile } : undefined }),
    cancel: (eid) => svc.run.stop(eid),
    exportScript: (id) => svc.scripts.exportOne(id),
    importScript: (p) => svc.scripts.importOne(p),
    listTasks: (o) => svc.tasks.listTasks(o),
    enqueueTask: (spec) => svc.tasks.enqueue(spec),
    cancelTask: (id) => svc.tasks.cancelTask(id),
    retryTask: (id) => svc.tasks.retryTask(id),
    profiles: svc.profiles,
    status: () => svc.status(),
  };
  const api = createHttpApi({ service: svc, token: TOKEN, audit: () => {}, rateLimit: { max: 1000, windowMs: 60000 } });

  let srv;
  try {
    srv = await api.start();
    const port = srv.port;
    const auth = { Authorization: 'Bearer ' + TOKEN };
    let sid;
    let pid;

    await t('HTTP create script -> service get sees it -> CLI get prints it', async () => {
      const c = await req({ port, method: 'POST', path: '/api/scripts', headers: auth, body: JSON.stringify({ name: 'integ', code: 'return 7;', permissions: {}, parameters: [] }) });
      assert(c.status === 201, 'create ' + c.status);
      sid = c.json.data.id;
      const viaSvc = svc.scripts.get(sid);
      assert(viaSvc.ok && viaSvc.data.name === 'integ', 'service sees it');
      const cc = cap();
      const code = await runCli(['script', 'get', sid], cliSvc, cc);
      assert(code === 0, 'cli exit ' + code);
      assert(cc.outS().includes('integ'), 'cli prints name');
    });

    await t('HTTP saveVersion -> HTTP run SUCCESS -> CLI run exit 0 same execution', async () => {
      const v = await req({ port, method: 'POST', path: '/api/scripts/' + sid + '/versions', headers: auth, body: JSON.stringify({ code: 'return 8;', version: '2.0.0' }) });
      assert(v.status === 201, 'versions ' + v.status);
      const run = await req({ port, method: 'POST', path: '/api/scripts/' + sid + '/run', headers: auth, body: JSON.stringify({ version: '2.0.0', profileContext: { id: 'ctx-i' } }) });
      assert(run.status === 200 && run.json.data.status === 'SUCCESS', 'http run');
      assert(run.json.data.result === 8, 'versioned code ran');
      const cc = cap();
      const code = await runCli(['script', 'run', sid, '--version', '2.0.0'], cliSvc, cc);
      assert(code === 0, 'cli run exit ' + code);
    });

    await t('HTTP export -> HTTP import new id -> CLI list shows both', async () => {
      const ex = await req({ port, path: '/api/scripts/' + sid + '/export', headers: auth });
      assert(ex.status === 200, 'export');
      const im = await req({ port, method: 'POST', path: '/api/scripts/import', headers: auth, body: JSON.stringify(ex.json.data) });
      assert(im.status === 201 && im.json.data.id !== sid, 'import new id');
      const cc = cap();
      const code = await runCli(['script', 'list'], cliSvc, cc);
      assert(code === 0, 'cli list');
      assert(cc.outS().includes(sid) && cc.outS().includes(im.json.data.id), 'both ids listed');
    });

    await t('HTTP profile create/start -> CLI profile list shows running', async () => {
      const c = await req({ port, method: 'POST', path: '/api/profiles', headers: auth, body: JSON.stringify({ name: 'integ-p' }) });
      assert(c.status === 201, 'profile create');
      pid = c.json.data.id;
      const st = await req({ port, method: 'POST', path: '/api/profiles/' + pid + '/start', headers: auth, body: '{}' });
      assert(st.status === 200, 'start');
      const cc = cap();
      const code = await runCli(['profile', 'list'], cliSvc, cc);
      assert(code === 0, 'cli profile list');
      assert(cc.outS().includes(pid) && cc.outS().includes('running'), 'running row:\n' + cc.outS());
      const cdp = await req({ port, path: '/api/profiles/' + pid + '/cdp', headers: auth });
      assert(cdp.status === 200 && cdp.json.data.endpoint.wsEndpoint === 'ws://integ', 'cdp endpoint');
    });

    await t('task plane: HTTP enqueue -> CLI list; CLI run -> HTTP list; status components', async () => {
      const en = await req({ port, method: 'POST', path: '/api/tasks', headers: auth, body: JSON.stringify({ scriptId: sid, params: {} }) });
      assert(en.status === 200, 'enqueue');
      const cc = cap();
      const code = await runCli(['task', 'list'], cliSvc, cc);
      assert(code === 0, 'cli task list');
      assert(cc.outS().includes(en.json.data.id), 'task listed');
      const cc2 = cap();
      const code2 = await runCli(['task', 'run', sid, '--param', 'k=v'], cliSvc, cc2);
      assert(code2 === 0, 'cli task run');
      const runId = (cc2.outS().match(/taskId: (\S+)/) || [])[1];
      assert(runId, 'taskId printed:\n' + cc2.outS());
      const l2 = await req({ port, path: '/api/tasks', headers: auth });
      assert(JSON.stringify(l2.json.data.rows).includes(runId), 'HTTP sees CLI-enqueued task');
      const s = svc.status();
      assert(s.ok && s.data.components.profiles === true, 'profiles component on');
    });

    // --- worker topology: executor + mid-run pause interrupt (service + HTTP) ---
    const { createTaskExecutor } = require('./runtime/automation-service');
    const { createWorker } = require('./runtime/worker');
    const storeW = createScriptStore();
    const quickW = storeW.create({ name: 'w-quick', code: 'return 41;', permissions: {}, parameters: [] });
    const hangW = storeW.create({ name: 'w-hang', code: 'await new Promise(() => {});', permissions: {}, parameters: [] });
    const managerW = createAutomationManager({
      store: storeW,
      runnerFactory: () => createScriptRunner({ browserApi: { browser: { goto: async () => {} } }, timeoutMs: 60000 }),
      audit: () => {},
    });
    const queueW = createTaskQueue({ audit: () => {} });
    const schedW = createScheduler({ audit: () => {}, onFire: () => {} });
    const execW = createTaskExecutor({ manager: managerW });
    const workerW = createWorker({
      queue: queueW,
      execute: (item) => execW.execute(item),
      concurrency: 1,
      pollMs: 10,
      heartbeatMs: 100000,
      taskTimeoutMs: 60000,
    });
    const svcW = createAutomationService({ store: storeW, manager: managerW, queue: queueW, scheduler: schedW, worker: workerW });
    const apiW2 = createHttpApi({ service: svcW, token: TOKEN, audit: () => {}, rateLimit: { max: 1000, windowMs: 60000 } });
    const srvW2 = await apiW2.start();
    workerW.start();
    try {
      const portW2 = srvW2.port;
      const waitQ = async (id, want, ms) => {
        const t0 = Date.now();
        for (;;) {
          const it = queueW.get(id);
          if (it && it.status === want) return it;
          if (Date.now() - t0 > ms) throw new Error('wait ' + want + ' got ' + (it && it.status));
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      const waitMgrRun = async (ms) => {
        const t0 = Date.now();
        for (;;) {
          if (managerW.stats().running === 1) return;
          if (Date.now() - t0 > ms) throw new Error('manager never started');
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      await t('worker+executor: queued quick script runs to SUCCESS', async () => {
        const en = await req({ port: portW2, method: 'POST', path: '/api/tasks', headers: auth, body: JSON.stringify({ scriptId: quickW.id, params: {} }) });
        assert(en.status === 200, 'enqueue ' + en.status);
        const done = await waitQ(en.json.data.id, 'SUCCESS', 10000);
        assert(done.result === 41, 'result ' + JSON.stringify(done.result));
      });

      await t('HTTP pause{interrupt:true} on RUNNING hang -> CANCELLED promptly', async () => {
        const en = await req({ port: portW2, method: 'POST', path: '/api/tasks', headers: auth, body: JSON.stringify({ scriptId: hangW.id, params: {} }) });
        const tid = en.json.data.id;
        await waitQ(tid, 'RUNNING', 5000);
        await waitMgrRun(5000);
        // runner registers its abort listener a few microtasks after manager
        // marks RUNNING — settle for a beat so interrupt lands, not whiffs.
        await new Promise((r) => setTimeout(r, 150));
        const t0 = Date.now();
        const p = await req({ port: portW2, method: 'POST', path: '/api/tasks/' + tid + '/pause', headers: auth, body: JSON.stringify({ interrupt: true }) });
        assert(p.status === 200, 'pause ' + p.status);
        assert(p.json.data.interrupted === true, 'interrupted flag: ' + JSON.stringify(p.json.data));
        await waitQ(tid, 'CANCELLED', 8000);
        assert(Date.now() - t0 < 15000, 'converged promptly, not timeout-bound');
      });

      await t('pauseTask on unknown id -> NOT_FOUND envelope', async () => {
        const miss = svcW.tasks.pauseTask('nope', { interrupt: true });
        assert(miss.ok === false && miss.error.code === 'NOT_FOUND', 'shape: ' + JSON.stringify(miss));
      });
    } finally {
      await workerW.stop();
      await srvW2.close();
    }

    console.log('DONE pass=' + pass + ' fail=' + fail);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    if (srv) await srv.close();
  }
})();
