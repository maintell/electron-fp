'use strict';

const fs = require('fs');
const path = require('path');
const { createProfileManager, ProfileError } = require('./runtime/profile-manager');

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL ' + name + ' :: ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertThrows(fn, msgPart, code) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    if (msgPart) assert(e.message.includes(msgPart), 'wrong error: ' + e.message);
    if (code) assert(e.code === code, 'wrong code: ' + e.code);
  }
  assert(threw, 'expected throw');
}

async function assertRejects(fn, msgPart, code) {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    if (msgPart) assert(e.message.includes(msgPart), 'wrong error: ' + e.message);
    if (code) assert(e.code === code, 'wrong code: ' + e.code);
  }
  assert(threw, 'expected rejection');
}

// deterministic clock: strictly increasing ISO timestamps
let tick = 0;
const now = () => {
  tick += 1;
  return new Date(1700000000000 + tick * 1000).toISOString();
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const okLauncher = () => ({
  start: async (profile) => ({ wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/' + profile.id, debugPort: 9222 }),
  stop: async () => {},
});

async function main() {
  // --- create/get/list + partition prefix ---
  await check('create/get/list: uuid id, status stopped, partition persist:auto-* (3), name validation, audit', () => {
    const audits = [];
    const pm = createProfileManager({ now, audit: (e) => audits.push(e) });
    const a = pm.create({ name: 'alpha', groupId: 'g1', platform: 'win32' });
    const b = pm.create({ name: 'beta' });
    const c = pm.create({ name: 'gamma', groupId: 'g1' });
    for (const p of [a, b, c]) {
      assert(UUID_RE.test(p.id), 'id is uuid');
      assert(p.partition === 'persist:auto-' + p.id, 'partition derived: ' + p.partition);
      assert(p.partition.startsWith('persist:auto-'), 'never in-memory bare name (fp-tab lesson)');
      assert(p.status === 'stopped', 'initial status stopped');
      assert(typeof p.meta.createdAt === 'string' && typeof p.meta.updatedAt === 'string', 'meta timestamps');
    }
    assert(pm.get(a.id).name === 'alpha', 'get by id');
    assert(pm.get('nope') === undefined, 'missing -> undefined');
    assert(pm.list().length === 3, 'list all');
    assert(pm.list({ groupId: 'g1' }).length === 2, 'list by groupId');
    assert(pm.list({ status: 'stopped' }).length === 3, 'list by status');
    assertThrows(() => pm.create({ name: ' ' }), 'name', 'VALIDATION');
    assertThrows(() => pm.create({ name: 42 }), 'name', 'VALIDATION');
    assertThrows(() => pm.create({ name: 'x', proxy: {} }), 'proxy.server', 'VALIDATION');
    assert(audits.filter((x) => x.action === 'profile-create').length === 3, 'audit create x3');
  });

  // --- list redacts, get full ---
  await check('list redacts proxy.password as ***, get returns full', () => {
    const pm = createProfileManager({ now });
    const p = pm.create({ name: 'px', proxy: { server: 'http://127.0.0.1:8080', username: 'u', password: 'SECRET_PW' } });
    assert(pm.get(p.id).proxy.password === 'SECRET_PW', 'get full password');
    const listed = pm.list();
    assert(listed.length === 1, 'one entry');
    assert(listed[0].proxy.password === '***', 'list redacted, got ' + listed[0].proxy.password);
    assert(listed[0].proxy.server === 'http://127.0.0.1:8080', 'server kept');
    assert(!JSON.stringify(listed).includes('SECRET_PW'), 'no secret in list payload');
  });

  // --- update: running conflict vs stopped ok ---
  await check('update: running+fingerprint/proxy -> CONFLICT state unchanged; stopped -> ok; partition rejected', async () => {
    const pm = createProfileManager({ now, launcher: okLauncher() });
    const p = pm.create({ name: 'u1', fingerprint: { hardware_concurrency: 4 } });
    await pm.start(p.id);
    assertThrows(() => pm.update(p.id, { fingerprint: { hardware_concurrency: 8 } }), 'CONFLICT: stop profile before changing fingerprint/proxy', 'CONFLICT');
    assertThrows(() => pm.update(p.id, { proxy: { server: 'http://x:1' } }), 'CONFLICT', 'CONFLICT');
    const after = pm.get(p.id);
    assert(after.status === 'running', 'state unchanged: still running');
    assert(after.fingerprint.hardware_concurrency === 4, 'fingerprint unchanged');
    assert(after.proxy === undefined, 'proxy unchanged');
    await pm.stop(p.id);
    const u = pm.update(p.id, { name: 'u2', fingerprint: { hardware_concurrency: 8 } });
    assert(u.name === 'u2' && u.fingerprint.hardware_concurrency === 8, 'stopped update applied');
    assertThrows(() => pm.update(p.id, { partition: 'persist:auto-hax' }), 'partition', 'VALIDATION');
    assertThrows(() => pm.update(p.id, { nope: 1 }), 'not an updatable field', 'VALIDATION');
    assertThrows(() => pm.update('nope', { name: 'x' }), 'not found', 'NOT_FOUND');
    assert(pm.get(p.id).partition === 'persist:auto-' + p.id, 'partition untouched');
  });

  // --- remove: running conflict, soft delete ---
  await check('remove: running -> CONFLICT; soft delete hides; includeDeleted reveals', async () => {
    const pm = createProfileManager({ now, launcher: okLauncher() });
    const p = pm.create({ name: 'gone' });
    await pm.start(p.id);
    assertThrows(() => pm.remove(p.id), 'CONFLICT', 'CONFLICT');
    await pm.stop(p.id);
    const rm = pm.remove(p.id);
    assert(typeof rm.deletedAt === 'string' && rm.deletedAt.length > 0, 'deletedAt set');
    assert(pm.get(p.id) === undefined, 'get hides deleted');
    assert(pm.list().length === 0, 'list hides deleted');
    const back = pm.list({ includeDeleted: true });
    assert(back.length === 1 && back[0].id === p.id, 'includeDeleted reveals');
    assertThrows(() => pm.remove(p.id), 'not found', 'NOT_FOUND');
  });

  // --- start happy + double start conflict ---
  await check('start: happy -> running + endpoint in status(); start already running -> CONFLICT', async () => {
    const pm = createProfileManager({ now, launcher: okLauncher() });
    const p = pm.create({ name: 's1' });
    const started = await pm.start(p.id);
    assert(started.status === 'running', 'status running');
    const st = pm.status(p.id);
    assert(st.id === p.id && st.status === 'running', 'status() shape');
    assert(st.endpoint && st.endpoint.wsEndpoint.startsWith('ws://127.0.0.1:9222/'), 'endpoint in status()');
    assert(st.endpoint.debugPort === 9222, 'debugPort kept');
    await assertRejects(() => pm.start(p.id), 'CONFLICT', 'CONFLICT');
    assert(pm.get(p.id).status === 'running', 'still running after conflict');
  });

  // --- start: missing launcher + empty endpoint ---
  await check('start: missing launcher -> LIMIT; launcher returns {} -> VALIDATION no endpoint', async () => {
    const bare = createProfileManager({ now });
    const p1 = bare.create({ name: 'nol' });
    await assertRejects(() => bare.start(p1.id), 'launcher not wired', 'LIMIT');
    assert(bare.get(p1.id).status === 'stopped', 'status untouched when launcher missing');

    const bad = createProfileManager({ now, launcher: { start: async () => ({}), stop: async () => {} } });
    const p2 = bad.create({ name: 'empty-ep' });
    await assertRejects(() => bad.start(p2.id), 'no endpoint', 'VALIDATION');
    assert(bad.get(p2.id).status === 'error', 'validation failure -> error');
    await assertRejects(() => bad.stop(p2.id), 'CONFLICT', 'CONFLICT'); // error is not running
  });

  // --- stop happy + stop stopped conflict ---
  await check('stop: happy -> stopped, endpoint cleared; stop when stopped -> CONFLICT', async () => {
    const pm = createProfileManager({ now, launcher: okLauncher() });
    const p = pm.create({ name: 'st1' });
    await pm.start(p.id);
    assert(pm.status(p.id).endpoint !== null, 'endpoint live before stop');
    const stopped = await pm.stop(p.id);
    assert(stopped.status === 'stopped', 'status stopped');
    assert(pm.status(p.id).endpoint === null, 'endpoint cleared');
    await assertRejects(() => pm.stop(p.id), 'CONFLICT', 'CONFLICT');
  });

  // --- bulkStart ---
  await check('bulkStart: 3 profiles, launcher fails 2nd -> started 1st+3rd, failed has id, audit', async () => {
    const audits = [];
    let n = 0;
    const pm = createProfileManager({
      now,
      audit: (e) => audits.push(e),
      launcher: {
        start: async () => {
          n++;
          if (n === 2) throw new Error('boom');
          return { wsEndpoint: 'ws://ok/' + n };
        },
        stop: async () => {},
      },
    });
    const ids = ['x', 'y', 'z'].map((nm) => pm.create({ name: nm }).id);
    const res = await pm.bulkStart(ids, { concurrency: 5 });
    assert(res.started.length === 2, 'started 2, got ' + res.started.length);
    assert(res.started.includes(ids[0]) && res.started.includes(ids[2]), '1st and 3rd started');
    assert(res.failed.length === 1 && res.failed[0].id === ids[1], 'failed has 2nd id');
    assert(res.failed[0].error.message.includes('boom'), 'failed carries error message');
    assert(pm.status(ids[0]).status === 'running' && pm.status(ids[2]).status === 'running', 'winners running');
    assert(pm.status(ids[1]).status === 'error', 'loser error');
    assert(audits.some((x) => x.action === 'profile-bulk-start'), 'audit bulk');
    // empty + bad input
    const empty = await pm.bulkStart([]);
    assert(empty.started.length === 0 && empty.failed.length === 0, 'empty ids ok');
    await assertRejects(() => pm.bulkStart('nope'), 'array', 'VALIDATION');
  });

  // --- assertOwned ---
  await check('assertOwned: mismatch -> ProfileError cross-profile access denied; match/absent ctx ok', () => {
    const pm = createProfileManager({ now });
    let threw = false;
    try {
      pm.assertOwned('prof-a', 'prof-b');
    } catch (e) {
      threw = true;
      assert(e instanceof ProfileError, 'instanceof ProfileError');
      assert(e.name === 'ProfileError', 'name ProfileError');
      assert(e.message.includes('cross-profile access denied'), 'message');
    }
    assert(threw, 'mismatch must throw');
    assert(pm.assertOwned('prof-a', 'prof-a') === true, 'match ok');
    assert(pm.assertOwned('prof-a', undefined) === true, 'absent ctx ok');
    assert(pm.assertOwned('prof-a', null) === true, 'null ctx ok');
  });

  // --- persistence roundtrip ---
  await check('persistence roundtrip: atomic write, endpoint stripped on save, soft delete survives reload, cleanup', async () => {
    const dir = path.join('F:\\Temp\\opencode', 'fp-pm-test');
    const file = path.join(dir, 'profiles.json');
    fs.rmSync(dir, { recursive: true, force: true });

    const a = createProfileManager({ file, now });
    const p1 = a.create({ name: 'keep', groupId: 'g', proxy: { server: 'http://p:1', password: 'pw' } });
    a.update(p1.id, { name: 'keep2' });

    // live start: endpoint in memory, never on disk
    const b = createProfileManager({ file, now, launcher: okLauncher() });
    await b.start(p1.id);
    assert(b.status(p1.id).endpoint !== null, 'live endpoint present');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(!fs.existsSync(file + '.tmp'), 'no tmp left behind');
    assert(!JSON.stringify(raw).includes('lastEndpoint'), 'endpoint ephemeral, not persisted');
    assert(raw.length === 1 && raw[0].name === 'keep2', 'update persisted');
    assert(raw[0].partition === 'persist:auto-' + p1.id, 'partition persisted');
    await b.stop(p1.id);

    // reload: state + soft delete survive
    const c = createProfileManager({ file, now });
    const list = c.list();
    assert(list.length === 1 && list[0].name === 'keep2', 'reload sees update');
    assert(c.status(p1.id).status === 'stopped', 'status persisted');
    assert(c.status(p1.id).endpoint === null, 'endpoint null after reload');
    assert(c.get(p1.id).proxy.password === 'pw', 'password persisted full');
    c.remove(p1.id);
    const d = createProfileManager({ file, now });
    assert(d.list().length === 0, 'soft delete persisted');
    assert(d.list({ includeDeleted: true }).length === 1, 'includeDeleted after reload');

    fs.rmSync(dir, { recursive: true, force: true });
    assert(!fs.existsSync(dir), 'test dir cleaned up');
  });

  // --- in-process launcher endpoint ({ inProcess: true }) ---
  await check('inProcess endpoint: accepted, plain JSON, status survives reload (endpoint ephemeral), stop ok; {} still rejected', async () => {
    const dir = path.join('F:\\Temp\\opencode', 'fp-pm-test');
    const file = path.join(dir, 'profiles.json');
    fs.rmSync(dir, { recursive: true, force: true });

    const calls = [];
    const inProcessLauncher = {
      start: async (profile) => {
        calls.push('start:' + profile.id);
        return { inProcess: true };
      },
      stop: async (id) => {
        calls.push('stop:' + id);
      },
    };

    const pm = createProfileManager({ file, now, launcher: inProcessLauncher });
    const p = pm.create({ name: 'inproc' });
    const started = await pm.start(p.id);
    assert(started.status === 'running', 'start ok, status running');
    const st = pm.status(p.id);
    assert(st.endpoint && st.endpoint.inProcess === true, 'endpoint {inProcess:true}, got ' + JSON.stringify(st.endpoint));
    assert(Object.keys(st.endpoint).length === 1, 'plain marker only, no live handle keys');

    // endpoint itself is JSON-safe, but lastEndpoint stays ephemeral by design (stripped on save)
    assert(JSON.stringify(st.endpoint) === '{"inProcess":true}', 'endpoint serializes as plain JSON');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(!JSON.stringify(raw).includes('lastEndpoint'), 'endpoint not persisted (ephemeral strip unchanged)');
    assert(raw[0].status === 'running', 'running state persisted on disk');

    // reload: profile + status survive, endpoint is runtime-only (null), stop still works
    const re = createProfileManager({ file, now, launcher: inProcessLauncher });
    assert(re.status(p.id).status === 'running', 'reload keeps running state');
    assert(re.status(p.id).endpoint === null, 'endpoint null after reload (ephemeral)');
    const stopped = await re.stop(p.id);
    assert(stopped.status === 'stopped', 'stop via reloaded manager ok');
    assert(calls.includes('stop:' + p.id), 'in-process launcher.stop called');
    assert(re.status(p.id).endpoint === null, 'endpoint cleared after stop');

    // mixed launcher: empty object still rejected
    const bad = createProfileManager({ now, launcher: { start: async () => ({}), stop: async () => {} } });
    const p2 = bad.create({ name: 'empty-ep-2' });
    await assertRejects(() => bad.start(p2.id), 'no endpoint (need inProcess/wsEndpoint/cdpUrl/debugPort)', 'VALIDATION');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // --- fingerprintUpdate: FingerprintBroker minimal (architecture.md §4) ---
  await check('broker: stopped + no bearer needed -> ok, planes split, audit keyHash not carrier', async () => {
    const audits = [];
    const pm = createProfileManager({ now, audit: (e) => audits.push(e) });
    const p = pm.create({ name: 'fp1', fingerprint: { hardware_concurrency: 4 } });
    const r = await pm.fingerprintUpdate(p.id, { hardware_concurrency: 8, tls_version_min: '1.2' });
    assert(r.ok === true, 'ok');
    assert(r.planes.includes('blink') && r.planes.includes('tls'), 'planes: ' + JSON.stringify(r.planes));
    assert(r.restartRequired === false, 'stopped: no restart');
    const after = pm.get(p.id);
    assert(after.fingerprint.hardware_concurrency === 8 && after.fingerprint.tls_version_min === '1.2', 'applied: ' + JSON.stringify(after.fingerprint));
    const a = audits.find((e) => e.type === 'fingerprint-update');
    assert(a && a.id === p.id && typeof a.keyHash === 'string' && a.keyHash.length === 16, 'audit shape');
    assert(!JSON.stringify(audits).includes('TRUST_BODY') && !JSON.stringify(a).includes('hardware_concurrency'), 'no carrier in audit');
  });

  await check('broker: bearer gate — missing/bad denied UNAUTHORIZED, good passes', async () => {
    const audits = [];
    const pm = createProfileManager({ now, audit: (e) => audits.push(e), fpBroker: { token: 'fp-bearer-1' } });
    const p = pm.create({ name: 'fp-b' });
    await assertRejects(() => pm.fingerprintUpdate(p.id, { x: 1 }), 'UNAUTHORIZED', 'UNAUTHORIZED');
    await assertRejects(() => pm.fingerprintUpdate(p.id, { x: 1 }, { bearerToken: 'wrong' }), 'UNAUTHORIZED', 'UNAUTHORIZED');
    assert(pm.get(p.id).fingerprint === undefined, 'denied leaves stored fingerprint untouched');
    const r = await pm.fingerprintUpdate(p.id, { x: 1 }, { bearerToken: 'fp-bearer-1' });
    assert(r.ok === true, 'good bearer passes');
    assert(audits.some((e) => e.type === 'fingerprint-deny' && e.gate === 'permission'), 'deny audited');
  });

  await check('broker: validation runs before mutation — bad config leaves stored fp untouched', async () => {
    const pm = createProfileManager({
      now,
      fpValidate: (fp) => {
        if (fp.raw && fp.raw.evil === true) throw new Error('VALIDATION: evil key rejected');
      },
    });
    const p = pm.create({ name: 'fp-v', fingerprint: { keep: 1 } });
    let threw = false;
    try {
      await pm.fingerprintUpdate(p.id, { keep: 2, evil: true });
    } catch (e) {
      threw = true;
      assert(/evil/.test(e.message), 'validator message: ' + e.message);
    }
    assert(threw, 'expected rejection');
    assert(pm.get(p.id).fingerprint.keep === 1, 'atomic: stored untouched');
    await assertRejects(() => pm.fingerprintUpdate(p.id, 'not-an-object'), 'must be an object', 'VALIDATION');
    await assertRejects(() => pm.fingerprintUpdate(p.id, {}), 'must not be empty', 'VALIDATION');
    await assertRejects(() => pm.fingerprintUpdate('nope', { x: 1 }), 'not found', 'NOT_FOUND');
  });

  await check('broker: running -> CONFLICT (stop-first); H2 on frozen partition -> h2Error', async () => {    const inProc = { start: async () => ({ inProcess: true }), stop: async () => {} };
    const pm = createProfileManager({ now, launcher: inProc });
    const p = pm.create({ name: 'fp-r' });
    await pm.start(p.id);
    await assertRejects(() => pm.fingerprintUpdate(p.id, { hardware_concurrency: 2 }), 'CONFLICT', 'CONFLICT');
    assert(pm.get(p.id).status === 'running', 'still running after deny');
    await pm.stop(p.id);
    // first start materialized the partition: H2 change honestly refused
    let h2 = null;
    try {
      await pm.fingerprintUpdate(p.id, { h2_settings: 'x' });
    } catch (e) {
      h2 = e;
    }
    assert(h2 && /h2Error/.test(h2.message) && h2.code === 'CONFLICT' && h2.plane === 'h2', 'h2Error: ' + (h2 && h2.message));
    // blink/tls on stopped profile still fine
    const r = await pm.fingerprintUpdate(p.id, { hardware_concurrency: 2 });
    assert(r.ok === true && r.restartRequired === false, 'stopped blink update ok');
  });

  await check('broker rotate: running stop->update->start one call; stopped passthrough; H2 frozen refuses pre-stop', async () => {
    const inProc = { start: async () => ({ inProcess: true }), stop: async () => {} };
    const pm = createProfileManager({ now, launcher: inProc });
    const p = pm.create({ name: 'fp-rot' });
    await pm.start(p.id);
    const r = await pm.fingerprintRotate(p.id, { hardware_concurrency: 9 });
    assert(r.ok === true && r.restarted === true, 'rotated: ' + JSON.stringify(r));
    assert(pm.get(p.id).status === 'running', 'running again after rotate');
    assert(pm.get(p.id).fingerprint.hardware_concurrency === 9, 'new fp live');
    // stopped passthrough
    await pm.stop(p.id);
    const r2 = await pm.fingerprintRotate(p.id, { hardware_concurrency: 3 });
    assert(r2.ok === true && r2.restarted === false, 'stopped passthrough: ' + JSON.stringify(r2));
    // H2 frozen refuses BEFORE any stop (no half-switched identity)
    await pm.start(p.id);
    let h2 = null;
    try {
      await pm.fingerprintRotate(p.id, { h2_settings: 'x' });
    } catch (e) {
      h2 = e;
    }
    assert(h2 && /h2Error/.test(h2.message) && h2.code === 'CONFLICT', 'h2 refused pre-stop: ' + (h2 && h2.message));
    assert(pm.get(p.id).status === 'running', 'still running after refused rotate');
    // bearer gate applies to rotate too
    const pmB = createProfileManager({ now, launcher: inProc, fpBroker: { token: 'rot-bearer' } });
    const pb = pmB.create({ name: 'fp-rot-b' });
    await assertRejects(() => pmB.fingerprintRotate(pb.id, { x: 1 }), 'UNAUTHORIZED', 'UNAUTHORIZED');
    const rb = await pmB.fingerprintRotate(pb.id, { x: 1 }, { bearerToken: 'rot-bearer' });
    assert(rb.ok === true, 'bearer rotate ok');
    // unwired launcher on running profile -> LIMIT, fingerprint already updated (honest)
    // NOTE: create() returns a clone — mutating it never touches the store, so a
    // file-backed reload is the only way to get a running profile without a launcher.
    const rdir = path.join('F:\\Temp\\opencode', 'fp-pm-rot-' + process.pid);
    const rfile = path.join(rdir, 'profiles.json');
    fs.rmSync(rdir, { recursive: true, force: true });
    const pmF = createProfileManager({ file: rfile, now, launcher: inProc });
    const pf = pmF.create({ name: 'fp-rot-n' });
    await pmF.start(pf.id); // persists status=running to disk
    const pmN = createProfileManager({ file: rfile, now }); // no launcher
    assert(pmN.status(pf.id).status === 'running', 'reloaded running without launcher');
    await assertRejects(() => pmN.fingerprintRotate(pf.id, { x: 1 }), 'launcher not wired', 'LIMIT');
    fs.rmSync(rdir, { recursive: true, force: true });
  });

  // --- setEndpoint (additive, runtime-only) ---
  await check('setEndpoint: merges into live endpoint; status reflects it; not persisted; reload clears', async () => {
    const dir = path.join('F:\\Temp\\opencode', 'fp-pm-test');
    const file = path.join(dir, 'profiles.json');
    fs.rmSync(dir, { recursive: true, force: true });

    const inProc = { start: async () => ({ inProcess: true }), stop: async () => {} };
    const pm = createProfileManager({ file, now, launcher: inProc });
    const p = pm.create({ name: 'ep' });
    await pm.start(p.id);
    const before = pm.status(p.id).endpoint;
    assert(before && before.inProcess === true, 'pre endpoint ' + JSON.stringify(before));

    const url = 'ws://127.0.0.1:1234/api/cdp/' + p.id + '?token=tk';
    const merged = pm.setEndpoint(p.id, { cdpUrl: url });
    assert(merged.inProcess === true && merged.cdpUrl === url, 'merge keeps inProcess + adds cdpUrl: ' + JSON.stringify(merged));
    const st = pm.status(p.id);
    assert(st.endpoint.inProcess === true && st.endpoint.cdpUrl === url, 'status reflects cdpUrl');
    assertThrows(() => pm.setEndpoint(p.id, null), 'patch', 'VALIDATION');
    assertThrows(() => pm.setEndpoint('nope', { cdpUrl: 'x' }), 'not found', 'NOT_FOUND');

    // ephemeral: never on disk
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(!JSON.stringify(raw).includes('lastEndpoint') && !JSON.stringify(raw).includes('cdpUrl'), 'endpoint not persisted');

    // not running -> CONFLICT
    await pm.stop(p.id);
    assertThrows(() => pm.setEndpoint(p.id, { cdpUrl: 'x' }), 'CONFLICT', 'CONFLICT');

    // reload: profile survives, endpoint gone
    const re = createProfileManager({ file, now });
    assert(re.status(p.id).status === 'stopped', 'status persisted');
    assert(re.status(p.id).endpoint === null, 'endpoint absent after reload');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + (e && e.stack ? e.stack : e));
  console.log('SUMMARY pass=' + pass + ' fail=' + (fail + 1));
  process.exit(1);
});
