// ponytail: token-rotation tests (doc 17 Part C). Real HTTP listener + fake clock so
// the grace window is deterministic; HS256 JWTs minted in-test with node:crypto.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHttpApi } = require('./runtime/http-api');
const { createTokenStore, writeCredentials, readCredentials, credentialsPath, sha256hex } = require('./runtime/token-store');

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

const SECRET = 'rotate-jwt-secret-0123456789';
const ADMIN = 'old-admin-token';
const VIEWER = 'viewer-token';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mint(payload, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest();
  return h + '.' + p + '.' + b64u(sig);
}

function req({ port, method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
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

const fakeService = () => ({
  status: () => ({ ok: true, data: { service: 'automation' } }),
  scripts: { list: () => ({ ok: true, data: [] }) },
});

const bearer = (tok) => ({ Authorization: 'Bearer ' + tok });

(async () => {
  let nowMs = 1700000000000;
  const now = () => nowMs;
  const audits = [];
  const audit = (ev) => audits.push(ev);

  const creds = createTokenStore({ token: ADMIN, readToken: VIEWER, jwtSecret: SECRET, graceMs: 60000, now });
  const api = createHttpApi({ service: fakeService(), creds, now, audit, rateLimit: { max: 100000, windowMs: 60000 } });
  const srv = await api.start();
  const port = srv.port;
  const adminJwt = () => mint({ sub: 'root', role: 'Admin' });

  let currentAdmin = ADMIN; // tracks the live admin token across rotations

  try {
    await t('baseline: admin token + viewer token work; junk rejected', async () => {
      const a = await req({ port, path: '/api/automation/status', headers: bearer(ADMIN) });
      assert(a.status === 200, 'admin ' + a.status);
      const v = await req({ port, path: '/api/scripts', headers: bearer(VIEWER) });
      assert(v.status === 200, 'viewer ' + v.status);
      const n = await req({ port, path: '/api/automation/status', headers: bearer('nope') });
      assert(n.status === 401, 'junk ' + n.status);
    });

    await t('rotate (explicit newToken) returns it once; new token authenticates', async () => {
      const r = await req({ port, method: 'POST', path: '/api/automation/token/rotate', headers: bearer(adminJwt()), body: JSON.stringify({ newToken: 'new-admin-token' }) });
      assert(r.status === 200, 'status ' + r.status + ' ' + JSON.stringify(r.json));
      assert(r.json.ok === true && r.json.data && r.json.data.token === 'new-admin-token', 'token=' + JSON.stringify(r.json.data));
      currentAdmin = 'new-admin-token';
      const u = await req({ port, path: '/api/automation/status', headers: bearer(currentAdmin) });
      assert(u.status === 200, 'new token ' + u.status);
    });

    await t('old token still works inside grace, fails after grace', async () => {
      nowMs += 1000; // inside 60s grace
      const within = await req({ port, path: '/api/automation/status', headers: bearer(ADMIN) });
      assert(within.status === 200, 'within grace ' + within.status);
      nowMs += 61000; // past grace
      const after = await req({ port, path: '/api/automation/status', headers: bearer(ADMIN) });
      assert(after.status === 401, 'after grace ' + after.status);
      const cur = await req({ port, path: '/api/automation/status', headers: bearer(currentAdmin) });
      assert(cur.status === 200, 'current still ok ' + cur.status);
    });

    await t('rotate with empty body generates a token server-side', async () => {
      const r = await req({ port, method: 'POST', path: '/api/automation/token/rotate', headers: bearer(adminJwt()), body: JSON.stringify({}) });
      assert(r.status === 200, 'status ' + r.status);
      const gen = r.json && r.json.data && r.json.data.token;
      assert(typeof gen === 'string' && gen.length >= 16 && gen !== currentAdmin, 'generated=' + JSON.stringify(gen));
      currentAdmin = gen;
      const u = await req({ port, path: '/api/automation/status', headers: bearer(currentAdmin) });
      assert(u.status === 200, 'generated token works ' + u.status);
    });

    await t('non-admin / possession-only rotate denied', async () => {
      // admin bearer WITHOUT a JWT claim: possession alone is insufficient
      const bearerOnly = await req({ port, method: 'POST', path: '/api/automation/token/rotate', headers: bearer(currentAdmin), body: JSON.stringify({ newToken: 'x' }) });
      assert(bearerOnly.status === 403, 'bearer-only ' + bearerOnly.status);
      // viewer bearer
      const viewer = await req({ port, method: 'POST', path: '/api/automation/token/rotate', headers: bearer(VIEWER), body: JSON.stringify({ newToken: 'x' }) });
      assert(viewer.status === 403, 'viewer ' + viewer.status);
      // non-admin JWT (Viewer role lacks Automation.Admin)
      const lowJwt = await req({ port, method: 'POST', path: '/api/automation/token/rotate', headers: bearer(mint({ sub: 'v', role: 'Viewer' })), body: JSON.stringify({ newToken: 'x' }) });
      assert(lowJwt.status === 403, 'low-jwt ' + lowJwt.status);
      // no token at all
      const none = await req({ port, method: 'POST', path: '/api/automation/token/rotate', body: JSON.stringify({ newToken: 'x' }) });
      assert(none.status === 401, 'none ' + none.status);
      // and the denied attempts did not rotate anything
      const cur = await req({ port, path: '/api/automation/status', headers: bearer(currentAdmin) });
      assert(cur.status === 200, 'current unchanged ' + cur.status);
    });

    await t('audit: token-rotate by sub, never the token value', async () => {
      const line = audits.find((a) => a.type === 'token-rotate');
      assert(line && line.by === 'root', 'rotate audit line: ' + JSON.stringify(line));
      const dump = JSON.stringify(audits);
      for (const secret of [ADMIN, VIEWER, 'new-admin-token', currentAdmin, SECRET]) {
        assert(!dump.includes(secret), 'secret leaked into audit: ' + secret.slice(0, 8));
      }
      assert(!/new-admin-token/.test(dump), 'rotated token leaked');
    });

    await t('rotate jwtSecret: old-secret JWT still verifies inside grace', async () => {
      nowMs += 1000; // back inside a fresh grace window for the secret
      const r = await req({ port, method: 'POST', path: '/api/automation/token/rotate', headers: bearer(adminJwt()), body: JSON.stringify({ jwtSecret: 'rotated-jwt-secret' }) });
      assert(r.status === 200 && r.json.data.jwtSecret === 'rotated-jwt-secret', 'rotate secret ' + JSON.stringify(r.json));
      // a JWT signed with the OLD secret still verifies inside grace
      const oldSigned = mint({ sub: 'legacy', permissions: ['Automation.API'] });
      const ok = await req({ port, path: '/api/automation/status', headers: bearer(oldSigned) });
      assert(ok.status === 200, 'old-secret jwt within grace ' + ok.status);
      // after grace the old secret is gone; new secret still works
      nowMs += 61000;
      const stale = await req({ port, path: '/api/automation/status', headers: bearer(oldSigned) });
      assert(stale.status === 401, 'old-secret jwt after grace ' + stale.status);
      const fresh = mint({ sub: 'fresh', permissions: ['Automation.API'] }, { secret: 'rotated-jwt-secret' });
      const ok2 = await req({ port, path: '/api/automation/status', headers: bearer(fresh) });
      assert(ok2.status === 200, 'new-secret jwt ' + ok2.status);
    });

    await t('persistence: credentials file stores sha256, never the raw token', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-cred-'));
      const file = credentialsPath(dir);
      const st = createTokenStore({ token: 'persist-admin', credentialFile: file, now });
      st.rotate({ token: 'persist-admin-2' });
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert(doc.tokenHash === sha256hex('persist-admin-2'), 'hash mismatch: ' + doc.tokenHash);
      assert(!JSON.stringify(doc).includes('persist-admin'), 'raw token in file');
      assert(st.verify('persist-admin-2').role === 'admin', 'new verifies');
      assert(st.verify('persist-admin').role === 'admin', 'old within grace');
      const loaded = readCredentials(file);
      assert(loaded && loaded.tokenHash === doc.tokenHash, 'reload');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    });
  } finally {
    await srv.close();
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
