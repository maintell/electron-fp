// ponytail: JWT claims kernel tests — HS256 hand-rolled tokens minted in-test with node:crypto.
// Focused fake service (auth is the subject, not the service layer).
'use strict';

const http = require('http');
const crypto = require('crypto');
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

const SECRET = 'unit-test-jwt-secret-rotate-me';
const ADMIN = 'admin-token-xyz';
const VIEWER = 'viewer-token-xyz';

const b64u = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// mint(payload, {secret, header}) — same construction verifyJwt reverses.
function mint(payload, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest();
  return h + '.' + p + '.' + b64u(sig);
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

function fakeService() {
  return {
    status: () => ({ ok: true, data: { service: 'automation' } }),
    scripts: {
      list: () => ({ ok: true, data: [] }),
      get: (id) => ({ ok: true, data: { id } }),
      create: (m) => ({ ok: true, data: { id: 's-new', name: m && m.name } }),
      update: (id) => ({ ok: true, data: { id } }),
      remove: (id) => ({ ok: true, data: { id } }),
      saveVersion: (id) => ({ ok: true, data: { id, version: '1.0.1' } }),
      exportOne: (id) => ({ ok: true, data: { format: 'fp-script', id } }),
      importOne: () => ({ ok: true, data: { id: 's-imported' } }),
    },
    run: {
      runScript: async (id) => ({ ok: true, data: { executionId: 'e1', status: 'SUCCESS', scriptId: id } }),
      listExecutions: () => ({ ok: true, data: [] }),
      getExecution: (id) => ({ ok: true, data: { executionId: id } }),
      getLogs: (id) => ({ ok: true, data: [] }),
      stop: (id) => ({ ok: true, data: { executionId: id } }),
    },
    tasks: {
      listTasks: () => ({ ok: true, data: [] }),
      getTask: (id) => ({ ok: true, data: { id } }),
      enqueue: () => ({ ok: true, data: { id: 't1' } }),
      cancelTask: (id) => ({ ok: true, data: { id } }),
      pauseTask: (id) => ({ ok: true, data: { id } }),
      resumeTask: (id) => ({ ok: true, data: { id } }),
      retryTask: (id) => ({ ok: true, data: { id } }),
    },
    schedules: {
      listSchedules: () => ({ ok: true, data: [] }),
      addSchedule: () => ({ ok: true, data: { id: 'sch1' } }),
      removeSchedule: (id) => ({ ok: true, data: { id } }),
      pauseSchedule: (id) => ({ ok: true, data: { id } }),
      resumeSchedule: (id) => ({ ok: true, data: { id } }),
      triggerSchedule: (id) => ({ ok: true, data: { id } }),
    },
    profiles: {
      list: () => ({ ok: true, data: [] }),
      get: (id) => ({ ok: true, data: { id } }),
      create: () => ({ ok: true, data: { id: 'p-new' } }),
      update: (id) => ({ ok: true, data: { id } }),
      remove: (id) => ({ ok: true, data: { id } }),
      start: async (id) => ({ ok: true, data: { id, status: 'running' } }),
      stop: async (id) => ({ ok: true, data: { id, status: 'stopped' } }),
      status: (id) => ({ ok: true, data: { id, status: 'stopped', endpoint: null } }),
    },
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

(async () => {
  const audits = [];
  const audit = (ev) => audits.push(ev);
  const jwtApi = createHttpApi({
    service: fakeService(),
    token: ADMIN,
    readToken: VIEWER,
    jwtSecret: SECRET,
    audit,
    rateLimit: { max: 10000, windowMs: 60000 },
  });
  const s = await jwtApi.start();
  const port = s.port;
  const bearer = (tok) => ({ Authorization: 'Bearer ' + tok });

  try {
    // ---- happy path ----
    await t('valid JWT + matching permission -> 201 (write allowed)', async () => {
      const tok = mint({ sub: 'alice', role: 'Developer', permissions: ['Script.Create'] });
      const r = await req({ port, method: 'POST', path: '/api/scripts', headers: bearer(tok), body: JSON.stringify({ name: 'a' }) });
      assert(r.status === 201, 'status ' + r.status + ' body ' + JSON.stringify(r.json));
    });

    await t('valid JWT GET with Script.View -> 200', async () => {
      const tok = mint({ sub: 'alice', permissions: ['Script.View'] });
      const r = await req({ port, path: '/api/scripts', headers: bearer(tok) });
      assert(r.status === 200, 'status ' + r.status);
    });

    // ---- permission enforcement ----
    await t('valid JWT missing permission -> 403 naming required permission', async () => {
      const tok = mint({ sub: 'alice', permissions: ['Script.View'] });
      const r = await req({ port, method: 'POST', path: '/api/scripts', headers: bearer(tok), body: JSON.stringify({ name: 'a' }) });
      assert(r.status === 403, 'status ' + r.status);
      assert(r.json.error.code === 'FORBIDDEN', 'code ' + r.json.error.code);
      assert(/Script\.Create/.test(r.json.error.message), 'message names perm: ' + r.json.error.message);
    });

    await t('route->permission map: run/export/import/task-cancel/profile-run/admin', async () => {
      // run needs Script.Run
      const runBad = await req({ port, method: 'POST', path: '/api/scripts/s1/run', headers: bearer(mint({ sub: 'u', permissions: ['Script.View'] })), body: '{}' });
      assert(runBad.status === 403 && /Script\.Run/.test(runBad.json.error.message), 'run 403: ' + runBad.status + ' ' + (runBad.json.error && runBad.json.error.message));
      const runOk = await req({ port, method: 'POST', path: '/api/scripts/s1/run', headers: bearer(mint({ sub: 'u', permissions: ['Script.Run'] })), body: '{}' });
      assert(runOk.status === 200, 'run ok ' + runOk.status);

      // export needs Script.Export
      const expBad = await req({ port, path: '/api/scripts/s1/export', headers: bearer(mint({ sub: 'u', permissions: ['Script.View'] })) });
      assert(expBad.status === 403 && /Script\.Export/.test(expBad.json.error.message), 'export 403');
      const expOk = await req({ port, path: '/api/scripts/s1/export', headers: bearer(mint({ sub: 'u', permissions: ['Script.Export'] })) });
      assert(expOk.status === 200, 'export ok ' + expOk.status);

      // import needs Script.Import
      const impBad = await req({ port, method: 'POST', path: '/api/scripts/import', headers: bearer(mint({ sub: 'u', permissions: ['Script.Create'] })), body: '{}' });
      assert(impBad.status === 403 && /Script\.Import/.test(impBad.json.error.message), 'import 403');

      // tasks cancel needs Task.Cancel
      const tBad = await req({ port, method: 'POST', path: '/api/tasks/t1/cancel', headers: bearer(mint({ sub: 'u', permissions: ['Task.View'] })), body: '{}' });
      assert(tBad.status === 403 && /Task\.Cancel/.test(tBad.json.error.message), 'task cancel 403');

      // profiles start needs Profile.Run
      const pBad = await req({ port, method: 'POST', path: '/api/profiles/p1/start', headers: bearer(mint({ sub: 'u', permissions: ['Profile.View'] })), body: '{}' });
      assert(pBad.status === 403 && /Profile\.Run/.test(pBad.json.error.message), 'profile start 403');
      const pOk = await req({ port, method: 'POST', path: '/api/profiles/p1/start', headers: bearer(mint({ sub: 'u', permissions: ['Profile.Run'] })), body: '{}' });
      assert(pOk.status === 200, 'profile start ok ' + pOk.status);

      // profiles create needs Automation.Admin
      const cBad = await req({ port, method: 'POST', path: '/api/profiles', headers: bearer(mint({ sub: 'u', permissions: ['Profile.Run'] })), body: JSON.stringify({ name: 'x' }) });
      assert(cBad.status === 403 && /Automation\.Admin/.test(cBad.json.error.message), 'profile create 403');

      // status needs Automation.API
      const sBad = await req({ port, path: '/api/automation/status', headers: bearer(mint({ sub: 'u', permissions: ['Script.View'] })) });
      assert(sBad.status === 403 && /Automation\.API/.test(sBad.json.error.message), 'status 403');
    });

    // ---- Viewer rule ----
    await t('role Viewer, no permissions[] -> GET 200 but write 403 (default read-only)', async () => {
      const get = await req({ port, path: '/api/scripts', headers: bearer(mint({ sub: 'v', role: 'Viewer' })) });
      assert(get.status === 200, 'viewer GET ' + get.status);
      const post = await req({ port, method: 'POST', path: '/api/scripts', headers: bearer(mint({ sub: 'v', role: 'Viewer' })), body: JSON.stringify({ name: 'x' }) });
      assert(post.status === 403, 'viewer POST ' + post.status);
    });

    await t('role Viewer WITH explicit permissions[] -> explicit grant wins (201)', async () => {
      const tok = mint({ sub: 'v', role: 'Viewer', permissions: ['Script.Create'] });
      const r = await req({ port, method: 'POST', path: '/api/scripts', headers: bearer(tok), body: JSON.stringify({ name: 'x' }) });
      assert(r.status === 201, 'status ' + r.status);
    });

    await t('role defaults: Operator can run but not manage (no Automation.Admin)', async () => {
      const run = await req({ port, method: 'POST', path: '/api/scripts/s1/run', headers: bearer(mint({ sub: 'op', role: 'Operator' })), body: '{}' });
      assert(run.status === 200, 'operator run ' + run.status);
      const admin = await req({ port, method: 'POST', path: '/api/profiles', headers: bearer(mint({ sub: 'op', role: 'Operator' })), body: JSON.stringify({ name: 'x' }) });
      assert(admin.status === 403, 'operator profile-create ' + admin.status);
    });

    await t('unknown role + no permissions[] -> grants nothing (403)', async () => {
      const r = await req({ port, path: '/api/scripts', headers: bearer(mint({ sub: 'u', role: 'Nope' })) });
      assert(r.status === 403, 'status ' + r.status);
    });

    // ---- token validation ----
    await t('expired -> 401', async () => {
      const tok = mint({ sub: 'u', permissions: ['Script.View'], exp: nowSec() - 61 });
      const r = await req({ port, path: '/api/scripts', headers: bearer(tok) });
      assert(r.status === 401, 'status ' + r.status);
      assert(r.json.error.code === 'UNAUTHORIZED', 'code');
    });

    await t('nbf in the future -> 401', async () => {
      const tok = mint({ sub: 'u', permissions: ['Script.View'], nbf: nowSec() + 3600 });
      const r = await req({ port, path: '/api/scripts', headers: bearer(tok) });
      assert(r.status === 401, 'status ' + r.status);
    });

    await t('clock skew ±60s tolerated: exp-30s ok, nbf+30s ok, exp-61s still 401', async () => {
      const e30 = mint({ sub: 'u', permissions: ['Script.View'], exp: nowSec() - 30 });
      const r1 = await req({ port, path: '/api/scripts', headers: bearer(e30) });
      assert(r1.status === 200, 'exp-30s tolerated: ' + r1.status);
      const n30 = mint({ sub: 'u', permissions: ['Script.View'], nbf: nowSec() + 30 });
      const r2 = await req({ port, path: '/api/scripts', headers: bearer(n30) });
      assert(r2.status === 200, 'nbf+30s tolerated: ' + r2.status);
      const e61 = mint({ sub: 'u', permissions: ['Script.View'], exp: nowSec() - 61 });
      const r3 = await req({ port, path: '/api/scripts', headers: bearer(e61) });
      assert(r3.status === 401, 'exp-61s still expired: ' + r3.status);
    });

    await t('wrong signature -> 401', async () => {
      const tok = mint({ sub: 'u', permissions: ['Script.View'] }, { secret: 'the-wrong-secret' });
      const r = await req({ port, path: '/api/scripts', headers: bearer(tok) });
      assert(r.status === 401, 'status ' + r.status);
    });

    await t("alg 'none' -> 401 (no alg confusion)", async () => {
      const tok = mint({ sub: 'u', permissions: ['Script.View'] }, { header: { alg: 'none' } });
      const r = await req({ port, path: '/api/scripts', headers: bearer(tok) });
      assert(r.status === 401, 'status ' + r.status);
    });

    await t('typ mismatch -> 401', async () => {
      const tok = mint({ sub: 'u', permissions: ['Script.View'] }, { header: { alg: 'HS256', typ: 'NOPE' } });
      const r = await req({ port, path: '/api/scripts', headers: bearer(tok) });
      assert(r.status === 401, 'status ' + r.status);
    });

    await t('malformed (<3 segments) -> 401', async () => {
      const r = await req({ port, path: '/api/scripts', headers: bearer('abc.def') });
      assert(r.status === 401, 'status ' + r.status);
    });

    await t('missing sub -> 401', async () => {
      const tok = mint({ role: 'Admin', permissions: ['Script.View'] });
      const r = await req({ port, path: '/api/scripts', headers: bearer(tok) });
      assert(r.status === 401, 'status ' + r.status);
    });

    await t('valid signature but tampered payload -> 401', async () => {
      const tok = mint({ sub: 'u', permissions: ['Script.View'] });
      const [h, , sig] = tok.split('.');
      const evil = b64u(JSON.stringify({ sub: 'root', permissions: ['Automation.Admin'] }));
      const r = await req({ port, method: 'POST', path: '/api/profiles', headers: bearer(h + '.' + evil + '.' + sig), body: JSON.stringify({ name: 'x' }) });
      assert(r.status === 401, 'status ' + r.status);
    });

    // ---- existing kernels unaffected ----
    await t('admin token still full access (no permission table applied)', async () => {
      const post = await req({ port, method: 'POST', path: '/api/profiles', headers: bearer(ADMIN), body: JSON.stringify({ name: 'x' }) });
      assert(post.status === 201, 'admin create ' + post.status);
      const st = await req({ port, path: '/api/automation/status', headers: bearer(ADMIN) });
      assert(st.status === 200, 'admin status ' + st.status);
    });

    await t('readToken viewer still GET-only', async () => {
      const get = await req({ port, path: '/api/scripts', headers: bearer(VIEWER) });
      assert(get.status === 200, 'viewer get ' + get.status);
      const post = await req({ port, method: 'POST', path: '/api/scripts', headers: bearer(VIEWER), body: JSON.stringify({ name: 'x' }) });
      assert(post.status === 403, 'viewer post ' + post.status);
      assert(/read-only/.test(post.json.error.message), 'read-only message');
    });

    // ---- audit ----
    await t('audit: auth-jwt ok + fail lines, never the raw token', async () => {
      const ok = mint({ sub: 'audit-ok', permissions: ['Script.View'] });
      await req({ port, path: '/api/scripts', headers: bearer(ok) });
      const bad = mint({ sub: 'audit-bad', permissions: ['Script.View'] }, { secret: 'nope' });
      await req({ port, path: '/api/scripts', headers: bearer(bad) });
      const okLine = audits.some((a) => a.type === 'auth-jwt' && a.ok === true && a.sub === 'audit-ok');
      const badLine = audits.some((a) => a.type === 'auth-jwt' && a.ok === false && a.reason === 'bad-signature');
      assert(okLine, 'auth-jwt ok line present');
      assert(badLine, 'auth-jwt fail line with reason');
      const dump = JSON.stringify(audits);
      assert(!dump.includes(ok) && !dump.includes(bad), 'raw token leaked into audit');
      assert(!dump.includes(ADMIN) && !dump.includes(VIEWER), 'static tokens leaked');
    });

    // ---- backward compat (no jwtSecret) ----
    await t('no jwtSecret -> JWT-looking token rejected 401 (behavior unchanged)', async () => {
      const plain = createHttpApi({ service: fakeService(), token: ADMIN, audit: () => {}, rateLimit: { max: 100, windowMs: 60000 } });
      const ps = await plain.start();
      try {
        const tok = mint({ sub: 'u', permissions: ['Script.View'] });
        const r = await req({ port: ps.port, path: '/api/scripts', headers: bearer(tok) });
        assert(r.status === 401, 'status ' + r.status);
        const ok = await req({ port: ps.port, path: '/api/scripts', headers: bearer(ADMIN) });
        assert(ok.status === 200, 'admin still ok ' + ok.status);
      } finally {
        await ps.close();
      }
    });
  } finally {
    await s.close();
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
