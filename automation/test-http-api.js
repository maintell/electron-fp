'use strict';

const http = require('http');
const { createScriptStore } = require('./runtime/script-store');
const { createScriptRunner } = require('./runtime/script-runner');
const { createAutomationManager } = require('./runtime/automation-manager');
const { createTaskQueue } = require('./runtime/task-queue');
const { createScheduler } = require('./runtime/scheduler');
const { createAutomationService } = require('./runtime/automation-service');
const { createHttpApi } = require('./runtime/http-api');

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

// raw http.request so we can forge the Host header (fetch/undici blocks it)
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

(async () => {
  const TOKEN = 'test-token-abc123-secret';
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
  const scheduler = createScheduler({
    audit,
    onFire: () => {},
  });
  const service = createAutomationService({ store, manager, queue, scheduler });
  const api = createHttpApi({ service, token: TOKEN, audit, rateLimit: { max: 1000, windowMs: 60000 } });

  // separate instance for the rate-limit test (max=3)
  const rlApi = createHttpApi({ service, token: 'rl-token', audit, rateLimit: { max: 3, windowMs: 60000 } });

  let srv;
  let rlSrv;
  try {
    srv = await api.start();
    rlSrv = await rlApi.start();
    const port = srv.port;
    const auth = { Authorization: 'Bearer ' + TOKEN };

    await t('no token -> 401', async () => {
      const r = await req({ port, path: '/api/automation/status' });
      assert(r.status === 401, 'status ' + r.status);
      assert(r.json && r.json.ok === false && r.json.error.code === 'UNAUTHORIZED', 'shape');
    });

    await t('wrong token -> 401', async () => {
      const r = await req({ port, path: '/api/automation/status', headers: { Authorization: 'Bearer nope' } });
      assert(r.status === 401, 'status ' + r.status);
    });

    await t('good token -> 200 status endpoint', async () => {
      const r = await req({ port, path: '/api/automation/status', headers: auth });
      assert(r.status === 200, 'status ' + r.status);
      assert(r.json.ok === true, 'ok');
      assert(r.json.data.service === 'automation', 'service name');
      assert(typeof r.json.data.components.queueDepth === 'number', 'queueDepth');
      assert(typeof r.json.data.components.running === 'number', 'running');
      assert(r.json.data.components.schedules && typeof r.json.data.components.schedules.total === 'number', 'schedules');
      assert(typeof r.json.data.uptimeSec === 'number', 'uptimeSec');
    });

    await t('Host: evil.com -> 403', async () => {
      const r = await req({ port, path: '/api/automation/status', headers: { ...auth, Host: 'evil.com' } });
      assert(r.status === 403, 'status ' + r.status);
      assert(r.json && r.json.error.code === 'FORBIDDEN', 'code');
    });

    await t('rate limit max=3 -> 4th request 429 + Retry-After', async () => {
      const p = rlSrv.port;
      const h = { Authorization: 'Bearer rl-token' };
      const s1 = (await req({ port: p, path: '/api/automation/status', headers: h })).status;
      const s2 = (await req({ port: p, path: '/api/automation/status', headers: h })).status;
      const s3 = (await req({ port: p, path: '/api/automation/status', headers: h })).status;
      const r4 = await req({ port: p, path: '/api/automation/status', headers: h });
      assert(s1 === 200 && s2 === 200 && s3 === 200, 'first 3 ok: ' + [s1, s2, s3]);
      assert(r4.status === 429, '4th ' + r4.status);
      assert(r4.headers['retry-after'], 'Retry-After header');
      assert(
        audits.some((a) => a.type === 'rate-limit' && a.status === 429),
        'rate-limit audited'
      );
    });

    let scriptId;
    await t('POST /api/scripts create -> 201', async () => {
      const r = await req({
        port,
        method: 'POST',
        path: '/api/scripts',
        headers: auth,
        body: JSON.stringify({
          name: 'http-happy',
          code: "console.log('from-http')",
          permissions: { browser: true },
          parameters: [],
        }),
      });
      assert(r.status === 201, 'status ' + r.status);
      assert(r.json.ok === true && r.json.data.id, 'created id');
      scriptId = r.json.data.id;
    });

    await t('POST run -> execution in GET /api/executions, logs 200 array', async () => {
      const run = await req({
        port,
        method: 'POST',
        path: `/api/scripts/${scriptId}/run`,
        headers: auth,
        body: JSON.stringify({ profileContext: { id: 'prof-http' } }),
      });
      assert(run.status === 200, 'run status ' + run.status);
      assert(run.json.ok === true && run.json.data.executionId, 'executionId');
      assert(run.json.data.status === 'SUCCESS', 'run status ' + run.json.data.status);

      const list = await req({ port, path: '/api/executions?limit=10', headers: auth });
      assert(list.status === 200, 'list status');
      assert(list.json.data && typeof list.json.data.total === 'number' && Array.isArray(list.json.data.rows), 'paged shape {total,rows}');
      assert(list.json.data.rows.length >= 1, 'executions rows');
      assert(
        list.json.data.rows.some((e) => e.executionId === run.json.data.executionId),
        'run appears in list'
      );

      const logs = await req({ port, path: `/api/executions/${run.json.data.executionId}/logs`, headers: auth });
      assert(logs.status === 200, 'logs status ' + logs.status);
      assert(Array.isArray(logs.json.data), 'logs array');
    });

    await t('PUT scripts/:id update 200; DELETE -> GET 404', async () => {
      const upd = await req({
        port,
        method: 'PUT',
        path: `/api/scripts/${scriptId}`,
        headers: auth,
        body: JSON.stringify({ name: 'http-renamed', description: 'd1' }),
      });
      assert(upd.status === 200, 'put status ' + upd.status);
      assert(upd.json.data.name === 'http-renamed', 'renamed');

      const del = await req({ port, method: 'DELETE', path: `/api/scripts/${scriptId}`, headers: auth });
      assert(del.status === 200, 'delete status ' + del.status);
      assert(del.json.ok === true, 'delete ok');

      const gone = await req({ port, path: `/api/scripts/${scriptId}`, headers: auth });
      assert(gone.status === 404, 'get after delete ' + gone.status);
      assert(gone.json.ok === false && gone.json.error.code === 'NOT_FOUND', 'NOT_FOUND shape');
    });

    await t('POST /api/tasks + cancel path', async () => {
      const en = await req({
        port,
        method: 'POST',
        path: '/api/tasks',
        headers: auth,
        body: JSON.stringify({ scriptId: 'any-script', params: {} }),
      });
      assert(en.status === 200, 'enqueue status ' + en.status);
      assert(en.json.ok === true && en.json.data.id, 'task id');
      const id = en.json.data.id;

      const cx = await req({ port, method: 'POST', path: `/api/tasks/${id}/cancel`, headers: auth });
      assert(cx.status === 200, 'cancel status ' + cx.status);
      // either success or honest CONFLICT shape — both acceptable per spec
      if (cx.json.ok) assert(cx.json.data.status === 'CANCELLED', 'cancelled');
      else assert(cx.json.ok === false && cx.json.error.code === 'CONFLICT', 'conflict shape');
    });

    await t('schedules add + trigger 200', async () => {
      const add = await req({
        port,
        method: 'POST',
        path: '/api/schedules',
        headers: auth,
        body: JSON.stringify({
          name: 's1',
          scriptId: 'any-script',
          profileContexts: [{ id: 'p1' }],
          type: 'interval',
          everyMs: 3600000,
        }),
      });
      assert(add.status === 200, 'add status ' + add.status);
      assert(add.json.ok === true && add.json.data.id, 'schedule id');
      const sid = add.json.data.id;

      const trig = await req({ port, method: 'POST', path: `/api/schedules/${sid}/trigger`, headers: auth });
      assert(trig.status === 200, 'trigger status ' + trig.status);
      assert(trig.json.ok === true, 'trigger ok');
    });

    await t('profiles start -> 501 NOT_IMPLEMENTED', async () => {
      const list = await req({ port, path: '/api/profiles', headers: auth });
      assert(list.status === 501, 'list status ' + list.status);
      assert(list.json.ok === false && list.json.error.code === 'NOT_IMPLEMENTED', 'list code');
      assert(list.json.error.message === 'Profile Manager P8', 'list message');

      const start = await req({ port, method: 'POST', path: '/api/profiles/p1/start', headers: auth, body: '{}' });
      assert(start.status === 501, 'start status ' + start.status);
      assert(start.json.error.code === 'NOT_IMPLEMENTED', 'start code');
    });

    // --- profiles wired via profileManager (P8; the 501 tests above cover the unwired path) ---
    const { createProfileManager } = require('./runtime/profile-manager');
    const pm = createProfileManager({
      launcher: {
        start: async () => ({ wsEndpoint: 'ws://x', debugPort: 1 }),
        stop: async () => {},
      },
    });
    const serviceW = createAutomationService({ store, manager, queue, scheduler, profileManager: pm });
    const apiW = createHttpApi({ service: serviceW, token: TOKEN, audit, rateLimit: { max: 1000, windowMs: 60000 } });
    const srvW = await apiW.start();
    try {
      const portW = srvW.port;
      let profId;

      await t('wired: POST /api/profiles -> 201', async () => {
        const r = await req({
          port: portW,
          method: 'POST',
          path: '/api/profiles',
          headers: auth,
          body: JSON.stringify({ name: 'wired-1', proxy: { server: 'http://p:8080', password: 's3cret' } }),
        });
        assert(r.status === 201, 'status ' + r.status);
        assert(r.json.ok === true && r.json.data.id, 'created id');
        assert(r.json.data.partition === 'persist:auto-' + r.json.data.id, 'derived partition');
        profId = r.json.data.id;
      });

      await t('wired: GET /api/profiles redacts proxy.password; GET one returns full', async () => {
        const list = await req({ port: portW, path: '/api/profiles', headers: auth });
        assert(list.status === 200, 'status ' + list.status);
        const row = list.json.data.find((p) => p.id === profId);
        assert(row && row.proxy && row.proxy.password === '***', 'redacted: ' + JSON.stringify(row && row.proxy));
        const one = await req({ port: portW, path: '/api/profiles/' + profId, headers: auth });
        assert(one.status === 200, 'one status ' + one.status);
        assert(one.json.data.proxy.password === 's3cret', 'full password in-process');
      });

      await t('wired: PUT rename 200; start->running+endpoint; double start 409; stop->stopped', async () => {
        const upd = await req({
          port: portW,
          method: 'PUT',
          path: '/api/profiles/' + profId,
          headers: auth,
          body: JSON.stringify({ name: 'wired-renamed' }),
        });
        assert(upd.status === 200, 'put ' + upd.status);
        assert(upd.json.data.name === 'wired-renamed', 'renamed');

        const st = await req({ port: portW, path: '/api/profiles/' + profId + '/status', headers: auth });
        assert(st.status === 200, 'status route ' + st.status);
        assert(st.json.data.status === 'stopped', 'initial stopped');

        const start = await req({ port: portW, method: 'POST', path: '/api/profiles/' + profId + '/start', headers: auth, body: '{}' });
        assert(start.status === 200, 'start ' + start.status);
        assert(start.json.data.status === 'running', 'running');
        assert(start.json.data.lastEndpoint && start.json.data.lastEndpoint.wsEndpoint === 'ws://x', 'endpoint');

        const again = await req({ port: portW, method: 'POST', path: '/api/profiles/' + profId + '/start', headers: auth, body: '{}' });
        assert(again.status === 409, 'double start ' + again.status);
        assert(again.json.error.code === 'CONFLICT', 'CONFLICT code');

        const stop = await req({ port: portW, method: 'POST', path: '/api/profiles/' + profId + '/stop', headers: auth, body: '{}' });
        assert(stop.status === 200, 'stop ' + stop.status);
        assert(stop.json.data.status === 'stopped', 'stopped');
      });

      await t('wired: DELETE then GET -> 404', async () => {
        const del = await req({ port: portW, method: 'DELETE', path: '/api/profiles/' + profId, headers: auth });
        assert(del.status === 200, 'delete ' + del.status);
        const gone = await req({ port: portW, path: '/api/profiles/' + profId, headers: auth });
        assert(gone.status === 404, 'get after delete ' + gone.status);
        assert(gone.json.error.code === 'NOT_FOUND', 'NOT_FOUND code');
      });

      await t('wired: script versions 201 + export/import roundtrip new id', async () => {
        const c = await req({
          port: portW,
          method: 'POST',
          path: '/api/scripts',
          headers: auth,
          body: JSON.stringify({ name: 'wired-script', code: "console.log('v1')", permissions: { browser: true }, parameters: [] }),
        });
        assert(c.status === 201, 'create ' + c.status);
        const sid = c.json.data.id;

        const v = await req({
          port: portW,
          method: 'POST',
          path: '/api/scripts/' + sid + '/versions',
          headers: auth,
          body: JSON.stringify({ code: "console.log('v2')", version: '9.9.9' }),
        });
        assert(v.status === 201, 'versions ' + v.status);
        assert(v.json.data.version === '9.9.9', 'version echo');

        const ex = await req({ port: portW, path: '/api/scripts/' + sid + '/export', headers: auth });
        assert(ex.status === 200, 'export ' + ex.status);
        assert(ex.json.ok === true && ex.json.data.format === 'fp-script', 'fp-script format');
        assert(ex.json.data.code === "console.log('v2')", 'latest code exported');

        const im = await req({
          port: portW,
          method: 'POST',
          path: '/api/scripts/import',
          headers: auth,
          body: JSON.stringify(ex.json.data),
        });
        assert(im.status === 201, 'import ' + im.status);
        assert(im.json.data.id && im.json.data.id !== sid, 'roundtrip id differs');
        const got = await req({ port: portW, path: '/api/scripts/' + im.json.data.id, headers: auth });
        assert(got.status === 200, 'imported get ' + got.status);
        assert(got.json.data.name === 'wired-script', 'imported name');
      });
    } finally {
      await srvW.close();
    }

    await t('malformed JSON body -> 400', async () => {
      const r = await req({ port, method: 'POST', path: '/api/scripts', headers: auth, body: '{not json' });
      assert(r.status === 400, 'status ' + r.status);
      assert(r.json.ok === false && r.json.error.code === 'VALIDATION', 'code');
    });

    await t('CORS preflight: bad origin -> 403; good origin -> allow headers', async () => {
      const bad = await req({
        port,
        method: 'OPTIONS',
        path: '/api/scripts',
        headers: { Origin: 'http://evil.com', 'Access-Control-Request-Method': 'POST' },
      });
      assert(bad.status === 403, 'bad origin status ' + bad.status);

      const good = await req({
        port,
        method: 'OPTIONS',
        path: '/api/scripts',
        headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST' },
      });
      assert(good.status === 204 || good.status === 200, 'good origin status ' + good.status);
      assert(good.headers['access-control-allow-origin'] === 'http://127.0.0.1:5173', 'reflect origin');
      assert(String(good.headers['access-control-allow-methods'] || '').includes('DELETE'), 'methods');
      assert(String(good.headers['access-control-allow-headers'] || '').toLowerCase().includes('authorization'), 'headers');
    });

    await t('token never appears in audit sink', async () => {
      const dump = JSON.stringify(audits);
      assert(!dump.includes(TOKEN), 'TOKEN leaked into audit');
      assert(!dump.includes('rl-token'), 'rl-token leaked into audit');
      assert(
        audits.some((a) => a.type === 'api' && a.method && a.path && typeof a.status === 'number'),
        'api audit lines present'
      );
    });

    // --- RBAC viewer token + CDP endpoint (own server, own cleanup) ---
    const { createProfileManager: createPM2 } = require('./runtime/profile-manager');
    const pm2 = createPM2({
      launcher: {
        start: async () => ({ wsEndpoint: 'ws://127.0.0.1:9333/devtools/page/AAAA', debugPort: 9333 }),
        stop: async () => {},
      },
    });
    const serviceR = createAutomationService({ store, manager, queue, scheduler, profileManager: pm2 });
    const apiR = createHttpApi({ service: serviceR, token: TOKEN, readToken: 'ro-token', audit, rateLimit: { max: 1000, windowMs: 60000 } });
    const srvR = await apiR.start();
    try {
      const portR = srvR.port;
      const ro = { Authorization: 'Bearer ro-token' };

      await t('RBAC: viewer GET 200, viewer POST 403, admin POST 201, unknown 401', async () => {
        const g = await req({ port: portR, path: '/api/automation/status', headers: ro });
        assert(g.status === 200, 'viewer get ' + g.status);
        const w = await req({ port: portR, method: 'POST', path: '/api/scripts', headers: ro, body: JSON.stringify({ name: 'nope', code: 'x' }) });
        assert(w.status === 403, 'viewer post ' + w.status);
        assert(w.json.error.code === 'FORBIDDEN', 'FORBIDDEN code');
        const a = await req({ port: portR, method: 'POST', path: '/api/scripts', headers: auth, body: JSON.stringify({ name: 'admin-ok', code: "console.log('a')", permissions: {}, parameters: [] }) });
        assert(a.status === 201, 'admin post ' + a.status);
        const u = await req({ port: portR, method: 'POST', path: '/api/scripts', headers: { Authorization: 'Bearer bogus' }, body: '{}' });
        assert(u.status === 401, 'unknown ' + u.status);
      });

      await t('CDP: no endpoint before start 404; live endpoint after start 200', async () => {
        const c = await req({ port: portR, method: 'POST', path: '/api/profiles', headers: auth, body: JSON.stringify({ name: 'cdp-1' }) });
        assert(c.status === 201, 'create ' + c.status);
        const pid = c.json.data.id;
        const cold = await req({ port: portR, path: '/api/profiles/' + pid + '/cdp', headers: auth });
        assert(cold.status === 404, 'cold ' + cold.status);
        assert(cold.json.error.code === 'NOT_FOUND', 'cold code');
        const st = await req({ port: portR, method: 'POST', path: '/api/profiles/' + pid + '/start', headers: auth, body: '{}' });
        assert(st.status === 200, 'start ' + st.status);
        const live = await req({ port: portR, path: '/api/profiles/' + pid + '/cdp', headers: auth });
        assert(live.status === 200, 'live ' + live.status);
        assert(live.json.data.endpoint.wsEndpoint === 'ws://127.0.0.1:9333/devtools/page/AAAA', 'ws url');
        assert(live.json.data.endpoint.debugPort === 9333, 'debug port');
        // viewer may read it too
        const roLive = await req({ port: portR, path: '/api/profiles/' + pid + '/cdp', headers: ro });
        assert(roLive.status === 200, 'viewer cdp ' + roLive.status);
        const missing = await req({ port: portR, path: '/api/profiles/nope/cdp', headers: auth });
        assert(missing.status === 404, 'missing profile ' + missing.status);
      });
    } finally {
      await srvR.close();
    }

    // --- appended: JWT claims kernel — backward compat + happy path ---
    const cryptoJ = require('crypto');
    const b64uJ = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const mintJwt = (payload, secret) => {
      const h = b64uJ(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const p = b64uJ(JSON.stringify(payload));
      const sig = cryptoJ.createHmac('sha256', secret).update(h + '.' + p).digest();
      return h + '.' + p + '.' + b64uJ(sig);
    };
    const JWT_SECRET = 'http-api-test-jwt-secret';

    await t('appended: no jwtSecret -> JWT-looking token still 401 (backward compat)', async () => {
      const svcPlain = createAutomationService({ store, manager, queue, scheduler });
      const apiPlain = createHttpApi({ service: svcPlain, token: TOKEN, audit, rateLimit: { max: 1000, windowMs: 60000 } });
      const sPlain = await apiPlain.start();
      try {
        const tok = mintJwt({ sub: 'alice', permissions: ['Script.View'] }, JWT_SECRET);
        const r = await req({ port: sPlain.port, path: '/api/automation/status', headers: { Authorization: 'Bearer ' + tok } });
        assert(r.status === 401, 'status ' + r.status);
        assert(r.json.ok === false && r.json.error.code === 'UNAUTHORIZED', 'UNAUTHORIZED shape');
      } finally {
        await sPlain.close();
      }
    });

    await t('appended: jwtSecret + valid JWT -> 200 + auth-jwt audit line', async () => {
      const jwtAudits = [];
      const svcJwt = createAutomationService({ store, manager, queue, scheduler });
      const apiJwt = createHttpApi({
        service: svcJwt,
        token: TOKEN,
        jwtSecret: JWT_SECRET,
        audit: (ev) => jwtAudits.push(ev),
        rateLimit: { max: 1000, windowMs: 60000 },
      });
      const sJwt = await apiJwt.start();
      try {
        const tok = mintJwt({ sub: 'bob', role: 'Developer', permissions: ['Automation.API'] }, JWT_SECRET);
        const r = await req({ port: sJwt.port, path: '/api/automation/status', headers: { Authorization: 'Bearer ' + tok } });
        assert(r.status === 200, 'status ' + r.status);
        assert(r.json.ok === true, 'ok');
        assert(
          jwtAudits.some((a) => a.type === 'auth-jwt' && a.ok === true && a.sub === 'bob'),
          'auth-jwt ok line: ' + JSON.stringify(jwtAudits.filter((a) => a.type === 'auth-jwt'))
        );
        assert(!JSON.stringify(jwtAudits).includes(tok), 'raw token leaked into audit');
      } finally {
        await sJwt.close();
      }
    });

    await t('appended: GET /api/metrics -> bundle consistent with seeded executions', async () => {
      const { createMetrics } = require('./runtime/metrics');
      const metrics = createMetrics({ capacity: 100 });
      const store2 = createScriptStore();
      const manager2 = createAutomationManager({
        store: store2,
        runnerFactory: () => createScriptRunner({ browserApi: { browser: { goto: async () => {} } }, timeoutMs: 2000 }),
        metrics,
        audit: () => {},
      });
      const svc2 = createAutomationService({
        store: store2,
        manager: manager2,
        queue: createTaskQueue({}),
        scheduler: createScheduler({ onFire: () => {} }),
        metrics,
      });
      const api2 = createHttpApi({ service: svc2, token: TOKEN, audit: () => {}, rateLimit: { max: 1000, windowMs: 60000 } });
      const s2 = await api2.start();
      try {
        const okS = store2.create({ name: 'met-ok', code: 'return 1', permissions: { browser: false }, parameters: [] });
        const badS = store2.create({ name: 'met-bad', code: "throw new ScriptError('boom')", permissions: { browser: false }, parameters: [] });
        await manager2.runScript(okS.id, { profileContext: { id: 'p-ok' } });
        await manager2.runScript(okS.id, { profileContext: { id: 'p-ok' } });
        await manager2.runScript(badS.id, { profileContext: { id: 'p-bad' } });
        const r = await req({ port: s2.port, path: '/api/metrics', headers: { Authorization: 'Bearer ' + TOKEN } });
        assert(r.status === 200 && r.json.ok === true, 'status=' + r.status);
        const d = r.json.data;
        assert(d.summary.total === 3, 'total=' + d.summary.total);
        assert(d.summary.byStatus.SUCCESS === 2 && d.summary.byStatus.FAILED === 1, JSON.stringify(d.summary.byStatus));
        assert(d.failureRate.failures === 1 && d.failureRate.total === 3, JSON.stringify(d.failureRate));
        assert(Math.abs(d.failureRate.rate - 1 / 3) < 1e-9, 'rate=' + d.failureRate.rate);
        assert(d.durationStats.count === 2, 'duration count=' + d.durationStats.count);
        assert(
          Array.isArray(d.topFailures) && d.topFailures[0].key === badS.id && d.topFailures[0].failures === 1,
          'topFailures=' + JSON.stringify(d.topFailures)
        );
        assert(typeof d.crashRate === 'number' && Array.isArray(d.hotSteps) && typeof d.volume.bucketMs === 'number', 'bundle shape');
        const rf = await req({ port: s2.port, path: '/api/metrics?scriptId=' + badS.id, headers: { Authorization: 'Bearer ' + TOKEN } });
        // metrics.js summary is unfiltered; scriptId passthrough applies to failureRate/durationStats
        assert(rf.json.data.failureRate.total === 1 && rf.json.data.failureRate.failures === 1, 'filter=' + JSON.stringify(rf.json.data.failureRate));
        assert(rf.json.data.durationStats.count === 0, 'filtered duration=' + rf.json.data.durationStats.count);
        const un = await req({ port: s2.port, path: '/api/metrics' });
        assert(un.status === 401, 'unauth=' + un.status);
      } finally {
        await s2.close();
      }
    });

    await t('appended: trust gate — admin bearer alone 403, admin JWT 200, viewer 403, no secret 501', async () => {
      const cryptoT = require('crypto');
      const TRUST_SECRET_T = 'http-api-test-trust-secret';
      const storeT = createScriptStore();
      const managerT = createAutomationManager({
        store: storeT,
        runnerFactory: () => createScriptRunner({ browserApi: { browser: { goto: async () => {} } }, timeoutMs: 2000 }),
        audit: () => {},
      });
      const svcT = createAutomationService({
        store: storeT,
        manager: managerT,
        queue: createTaskQueue({}),
        scheduler: createScheduler({ onFire: () => {} }),
        trustConfig: { secret: TRUST_SECRET_T, audit },
      });
      const apiT = createHttpApi({
        service: svcT,
        token: TOKEN,
        readToken: 'ro-token-t',
        jwtSecret: JWT_SECRET,
        audit,
        rateLimit: { max: 1000, windowMs: 60000 },
      });
      const sT = await apiT.start();
      try {
        const s = storeT.create({ name: 'trust-http', code: 'TRUST_BODY_V1', version: '1.0.0' });
        const sig = cryptoT.createHash('sha256').update('TRUST_BODY_V1:' + TRUST_SECRET_T).digest('hex');
        const adminTok = mintJwt({ sub: 'root', role: 'Owner' }, JWT_SECRET); // Owner => ALL_PERMS incl Admin
        const devTok = mintJwt({ sub: 'dev', role: 'Developer' }, JWT_SECRET); // no Admin
        const roT = { Authorization: 'Bearer ro-token-t' };
        // admin bearer token alone is NOT enough to mint trust
        const b = await req({ port: sT.port, path: '/api/scripts/' + s.id + '/trust', method: 'POST', headers: auth, body: JSON.stringify({ signature: sig }) });
        assert(b.status === 403 && b.json.error.code === 'FORBIDDEN', 'admin bearer alone 403: ' + b.status);
        // developer JWT (no Admin perm) also 403
        const d = await req({ port: sT.port, path: '/api/scripts/' + s.id + '/trust', method: 'POST', headers: { Authorization: 'Bearer ' + devTok }, body: JSON.stringify({ signature: sig }) });
        assert(d.status === 403 && d.json.error.code === 'FORBIDDEN', 'developer 403: ' + d.status);
        // admin JWT claim grants
        const g = await req({ port: sT.port, path: '/api/scripts/' + s.id + '/trust', method: 'POST', headers: { Authorization: 'Bearer ' + adminTok }, body: JSON.stringify({ signature: sig, actor: 'root' }) });
        assert(g.status === 200 && g.json.ok === true && g.json.data.trusted === true, 'grant: ' + JSON.stringify(g));
        assert(storeT.get(s.id).trusted === true, 'store bit set');
        // bad signature -> 400 VALIDATION (authorized but code mismatch)
        const bad = await req({ port: sT.port, path: '/api/scripts/' + s.id + '/untrust', method: 'POST', headers: { Authorization: 'Bearer ' + adminTok }, body: '{}' });
        assert(bad.status === 200, 'untrust 200: ' + bad.status);
        const badSig = await req({ port: sT.port, path: '/api/scripts/' + s.id + '/trust', method: 'POST', headers: { Authorization: 'Bearer ' + adminTok }, body: JSON.stringify({ signature: '0'.repeat(64) }) });
        assert(badSig.status === 400 && badSig.json.error.code === 'VALIDATION', 'bad sig 400: ' + badSig.status);
        // viewer POST already 403 on trust route
        const v = await req({ port: sT.port, path: '/api/scripts/' + s.id + '/trust', method: 'POST', headers: roT, body: JSON.stringify({ signature: sig }) });
        assert(v.status === 403, 'viewer 403: ' + v.status);
        // audit never carries the secret or signature
        assert(!JSON.stringify(audits).includes(TRUST_SECRET_T), 'trust secret leaked into audit');
        assert(!JSON.stringify(audits).includes(sig), 'signature leaked into audit');
      } finally {
        await sT.close();
      }
    });

    await t('appended: trust gate unconfigured -> 501 NOT_IMPLEMENTED', async () => {
      const storeU = createScriptStore();
      const sU = storeU.create({ name: 'trust-unconf', code: 'x', version: '1.0.0' });
      const svcU = createAutomationService({ store: storeU }); // no trustConfig
      const apiU = createHttpApi({ service: svcU, token: TOKEN, jwtSecret: JWT_SECRET, audit: () => {}, rateLimit: { max: 1000, windowMs: 60000 } });
      const sUU = await apiU.start();
      try {
        const adminTok = mintJwt({ sub: 'root', role: 'Owner' }, JWT_SECRET);
        const r = await req({ port: sUU.port, path: '/api/scripts/' + sU.id + '/trust', method: 'POST', headers: { Authorization: 'Bearer ' + adminTok }, body: JSON.stringify({ signature: 'x' }) });
        assert(r.status === 501 && r.json.error.code === 'NOT_IMPLEMENTED', 'unconfigured 501: ' + r.status);
      } finally {
        await sUU.close();
      }
    });

    await t('appended: metrics-less service -> 501 NOT_IMPLEMENTED', async () => {
      const r = await req({ port, path: '/api/metrics', headers: auth });
      assert(r.status === 501, 'status=' + r.status);
      assert(r.json.ok === false && r.json.error.code === 'NOT_IMPLEMENTED', JSON.stringify(r.json));
    });

    console.log('DONE pass=' + pass + ' fail=' + fail);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    if (srv) await srv.close();
    if (rlSrv) await rlSrv.close();
  }
})();
