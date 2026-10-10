'use strict';

const fs = require('fs');
const path = require('path');
const { createScriptStore } = require('./runtime/script-store');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
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

function assertThrows(fn, msgPart) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    if (msgPart) assert(e.message.includes(msgPart), 'wrong error: ' + e.message);
  }
  assert(threw, 'expected throw');
}

// deterministic clock: strictly increasing ISO timestamps
let tick = 0;
const now = () => {
  tick += 1;
  return new Date(1700000000000 + tick * 1000).toISOString();
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- create/get ---
check('create/get: id uuid, entry default, perm defaults, get returns code, missing -> undefined', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'alpha', code: 'console.log(1)', version: '1.0.0' });
  assert(UUID_RE.test(s.id), 'id is uuid');
  assert(s.entry === 'main.js', 'entry default main.js');
  assert(s.permissions.browser === true && s.permissions.filesystem === false && s.permissions.process === false, 'perm defaults');
  assert(Array.isArray(s.parameters) && s.parameters.length === 0, 'parameters default []');
  const g = store.get(s.id);
  assert(g && g.name === 'alpha', 'get by id');
  assert(g.versions[0].code === 'console.log(1)', 'get includes code');
  assert(store.get('nope') === undefined, 'missing id -> undefined');
});

// --- list strips code ---
check('list: strips versions[].code, keeps version/createdAt, no code anywhere', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'listed', code: 'SECRET_BODY_XYZ', version: '1.0.0' });
  store.addVersion(s.id, 'ANOTHER_BODY_ABC');
  const list = store.list();
  assert(list.length === 1, 'one entry');
  assert(list[0].versions.length === 2, 'both versions listed');
  assert(list[0].versions[0].code === undefined, 'code stripped (newest)');
  assert(list[0].versions[1].code === undefined, 'code stripped (older)');
  assert(list[0].versions[0].version === '1.0.1', 'version kept');
  assert(typeof list[0].versions[0].createdAt === 'string', 'createdAt kept');
  assert(!JSON.stringify(list).includes('SECRET_BODY_XYZ'), 'no code body in list payload');
});

// --- update meta ---
check('update: meta fields only, bumps updatedAt, does NOT touch versions; rejects bad patch', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'upd', code: 'c1', version: '1.0.0' });
  const versionsBefore = JSON.stringify(s.versions);
  const u = store.update(s.id, { name: 'upd2', description: 'desc', category: 'cat', entry: 'other.js' });
  assert(u.name === 'upd2' && u.description === 'desc' && u.category === 'cat' && u.entry === 'other.js', 'fields applied');
  assert(u.updatedAt > s.updatedAt, 'updatedAt bumped');
  assert(JSON.stringify(u.versions) === versionsBefore, 'versions untouched');
  assertThrows(() => store.update(s.id, { author: 'x' }), 'not an updatable meta field');
  assertThrows(() => store.update(s.id, { name: '' }), 'name');
  assert(store.update('nope', { name: 'x' }) === undefined, 'missing -> undefined');
});

// --- addVersion auto + explicit ---
check('addVersion: auto bumps patch 1.0.0->1.0.1, explicit accepted, non-semar latest -> v+count, dup rejected', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'ver', code: 'c1', version: '1.0.0' });
  const auto = store.addVersion(s.id, 'c2');
  assert(auto.version === '1.0.1', 'auto patch bump, got ' + auto.version);
  const explicit = store.addVersion(s.id, 'c3', '2.0.0');
  assert(explicit.version === '2.0.0', 'explicit version');
  assertThrows(() => store.addVersion(s.id, 'c4', '2.0.0'), 'version already exists');
  store.addVersion(s.id, 'c5', 'beta'); // non-semver latest
  const v = store.addVersion(s.id, 'c6');
  assert(/^v\d+$/.test(v.version), 'v+count branch, got ' + v.version);
  assertThrows(() => store.addVersion(s.id, ''), 'non-empty string');
  assertThrows(() => store.addVersion(s.id, 42), 'code must be a non-empty string');
  assert(store.addVersion('nope', 'x') === undefined, 'missing -> undefined');
});

// --- getVersion latest-first ---
check('getVersion: latest = versions[0] (newest first), by exact version, unknown -> undefined', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'gv', code: 'first', version: '1.0.0' });
  store.addVersion(s.id, 'second');
  store.addVersion(s.id, 'third', '2.0.0');
  const latest = store.getVersion(s.id);
  assert(latest.version === '2.0.0' && latest.code === 'third', 'latest is newest');
  const old = store.getVersion(s.id, '1.0.0');
  assert(old && old.code === 'first', 'by exact version');
  assert(store.getVersion(s.id, '9.9.9') === undefined, 'unknown version -> undefined');
  assert(store.getVersion('nope') === undefined, 'missing script -> undefined');
});

// --- soft delete ---
check('remove: soft delete hides from get/list/getVersion, includeDeleted reveals, deletedAt set', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'gone', code: 'c' });
  const rm = store.remove(s.id);
  assert(typeof rm.deletedAt === 'string' && rm.deletedAt.length > 0, 'deletedAt set');
  assert(store.get(s.id) === undefined, 'get hides deleted');
  assert(store.list().length === 0, 'list hides deleted');
  assert(store.getVersion(s.id) === undefined, 'getVersion hides deleted');
  const all = store.list({ includeDeleted: true });
  assert(all.length === 1 && all[0].id === s.id, 'includeDeleted reveals');
  assert(store.remove('nope') === undefined, 'missing -> undefined');
});

// --- validateParameters: all 9 types happy ---
const nineParams = [
  { name: 's', type: 'string', required: true },
  { name: 'n', type: 'number', required: false, default: 3 },
  { name: 'b', type: 'boolean', required: false },
  { name: 'sel', type: 'select', required: false, options: ['a', 'b'] },
  { name: 'ms', type: 'multi-select', required: false, options: ['x', 'y'] },
  { name: 'sec', type: 'secret', required: false },
  { name: 'f', type: 'file', required: false },
  { name: 'ta', type: 'textarea', required: false },
  { name: 'j', type: 'JSON', required: false },
];

check('validateParameters: happy path all 9 types + coercion + defaults applied', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'params', parameters: nineParams });
  const r = store.validateParameters(s.id, {
    s: 'hi',
    n: '42',
    b: 'true',
    sel: 'b',
    ms: ['x', 'y'],
    sec: 'pw',
    f: 'C:\\tmp\\a.txt',
    ta: 'long text',
    j: '{"k":1}',
  });
  assert(r.ok === true, 'ok: ' + JSON.stringify(r.errors));
  assert(r.values.s === 'hi', 'string');
  assert(r.values.n === 42 && typeof r.values.n === 'number', 'number numeric-string coerced');
  assert(r.values.b === true && typeof r.values.b === 'boolean', "boolean 'true' coerced");
  assert(r.values.sel === 'b', 'select');
  assert(Array.isArray(r.values.ms) && r.values.ms.length === 2, 'multi-select');
  assert(r.values.sec === 'pw', 'secret');
  assert(r.values.f === 'C:\\tmp\\a.txt', 'file');
  assert(r.values.ta === 'long text', 'textarea');
  assert(typeof r.values.j === 'object' && r.values.j.k === 1, 'JSON string parsed to object');
  // default applied when absent
  const r2 = store.validateParameters(s.id, { s: 'x' });
  assert(r2.ok === true, 'required satisfied');
  assert(r2.values.n === 3, 'default applied');
  assert(!('b' in r2.values), 'absent optional without default omitted');
});

check('validateParameters: rejects missing required / unknown key / select invalid / number NaN / JSON bad / bool 1', () => {
  const store = createScriptStore({ now });
  const s = store.create({ name: 'params-rej', parameters: nineParams });

  const r1 = store.validateParameters(s.id, {});
  assert(r1.ok === false && r1.errors.some((e) => e.name === 's'), 'missing required');

  const r2 = store.validateParameters(s.id, { s: 'x', nope: 1 });
  assert(r2.ok === false && r2.errors.some((e) => e.name === 'nope' && e.message === 'unknown parameter'), 'unknown key');

  const r3 = store.validateParameters(s.id, { s: 'x', sel: 'z' });
  assert(r3.ok === false && r3.errors.some((e) => e.name === 'sel'), 'select not in options');

  const r4 = store.validateParameters(s.id, { s: 'x', n: 'abc' });
  assert(r4.ok === false && r4.errors.some((e) => e.name === 'n'), 'number NaN rejected');
  const r4b = store.validateParameters(s.id, { s: 'x', n: NaN });
  assert(r4b.ok === false && r4b.errors.some((e) => e.name === 'n'), 'number NaN value rejected');

  const r5 = store.validateParameters(s.id, { s: 'x', j: 'not-json' });
  assert(r5.ok === false && r5.errors.some((e) => e.name === 'j'), 'JSON bad rejected');
  const r5b = store.validateParameters(s.id, { s: 'x', j: '42' });
  assert(r5b.ok === false && r5b.errors.some((e) => e.name === 'j'), 'JSON primitive rejected');

  const r6 = store.validateParameters(s.id, { s: 'x', b: 1 });
  assert(r6.ok === false && r6.errors.some((e) => e.name === 'b'), 'boolean 1 rejected');

  const r7 = store.validateParameters('nope', {});
  assert(r7.ok === false, 'missing script rejected');
});

// --- create validation rules ---
check('create validation: name empty/overlong, bad permission key/value, bad param type, missing options, empty code', () => {
  const store = createScriptStore({ now });
  assertThrows(() => store.create({ name: '' }), 'name');
  assertThrows(() => store.create({ name: 'x'.repeat(121) }), 'name');
  assertThrows(() => store.create({ name: 'ok', permissions: { foo: true } }), 'unknown permission');
  assertThrows(() => store.create({ name: 'ok', permissions: { browser: 'yes' } }), 'boolean');
  assertThrows(() => store.create({ name: 'ok', parameters: [{ name: 'p', type: 'int', required: false }] }), 'invalid parameter type');
  assertThrows(() => store.create({ name: 'ok', parameters: [{ name: 'p', type: 'select', required: true }] }), 'options');
  assertThrows(() => store.create({ name: 'ok', parameters: [{ name: 'p', type: 'string', required: 'yes' }] }), 'boolean');
  assertThrows(() => store.create({ name: 'ok', code: '' }), 'code');
});

// --- export -> import roundtrip ---
check('export/import: format fp-script v1, roundtrip keeps meta+code, new distinct id, bad format rejected', () => {
  const store = createScriptStore({ now });
  const orig = store.create({ name: 'exp', author: 'me', description: 'd', category: 'c', code: 'exported code', version: '1.0.0' });
  const ex = store.exportScript(orig.id);
  assert(ex.format === 'fp-script' && ex.v === 1, 'format+v');
  assert(ex.script.name === 'exp' && ex.script.author === 'me', 'meta exported');
  assert(ex.code === 'exported code' && ex.version === '1.0.0', 'latest code+version exported');

  const imp = store.importScript(JSON.parse(JSON.stringify(ex)));
  assert(imp.id !== orig.id, 'distinct id (never overwrite)');
  assert(imp.name === 'exp' && imp.description === 'd', 'meta imported');
  assert(imp.versions.length === 1 && imp.versions[0].code === 'exported code', 'code imported');
  assert(imp.versions[0].version === '1.0.0', 'version preserved');
  assert(store.get(orig.id) !== undefined, 'original untouched');

  assertThrows(() => store.importScript({ format: 'nope', v: 1 }), 'invalid format');
  assertThrows(() => store.importScript({ format: 'fp-script', v: 2 }), 'unsupported');
  assert(store.get(orig.id + '-x') === undefined, 'sanity');
  assert(store.exportScript('nope') === undefined, 'export missing -> undefined');
});

// --- file persistence roundtrip ---
check('file persistence: write/reload meta+versions+softdelete, atomic tmp+rename, cleanup', () => {
  const dir = path.join('F:\\Temp\\opencode', 'fp-store-test');
  const file = path.join(dir, 'scripts.json');
  fs.rmSync(dir, { recursive: true, force: true });

  const a = createScriptStore({ file, now });
  const s1 = a.create({ name: 'persisted', code: 'c1' });
  a.addVersion(s1.id, 'c2'); // auto -> 1.0.1
  const b = createScriptStore({ file, now });
  const list = b.list();
  assert(list.length === 1, 'loaded from file');
  assert(list[0].name === 'persisted', 'meta persisted');
  assert(list[0].versions.length === 2, 'version history persisted (code stripped in list)');
  const g = b.get(s1.id);
  assert(g.versions[0].version === '1.0.1' && g.versions[0].code === 'c2', 'newest-first persisted');
  assert(g.versions[1].code === 'c1', 'older version persisted');
  assert(!fs.existsSync(file + '.tmp'), 'no tmp left behind');

  b.update(s1.id, { description: 'changed' });
  b.remove(s1.id);
  const c = createScriptStore({ file, now });
  assert(c.get(s1.id) === undefined, 'soft delete persisted');
  const back = c.list({ includeDeleted: true });
  assert(back.length === 1 && back[0].description === 'changed', 'update persisted across reload');

  fs.rmSync(dir, { recursive: true, force: true });
  assert(!fs.existsSync(dir), 'test dir cleaned up');
});

// --- trusted gate: admin-only trust bit ---
check('trust: create/update/import never grant; bad paths rejected', () => {
  const crypto = require('crypto');
  const store = createScriptStore({ now });
  const s = store.create({ name: 'tg', code: 'TRUST_ME_V1', version: '1.0.0' });
  assert(s.trusted === false, 'create defaults untrusted');
  // direct writes refuse trust
  assertThrows(() => store.create({ name: 'tg-evil', code: 'x', trusted: true }), 'admin-only');
  assertThrows(() => store.update(s.id, { trusted: true }), 'admin-only');
  assertThrows(() => store.update(s.id, { trusted: false }), 'admin-only');
  assert(store.get(s.id).trusted === false, 'update did not flip bit');
  // import drops trust bit silently
  const ex = store.exportScript(s.id);
  assert(!('trusted' in (ex.script || {})), 'export carries no trust bit');
  const evil = JSON.parse(JSON.stringify(ex));
  evil.script.trusted = true;
  const imp = store.importScript(evil);
  assert(imp.trusted === false, 'import lands untrusted');
  // trust() needs secret + signature + version
  assertThrows(() => store.trust(s.id, {}), 'trustSecret');
  assertThrows(() => store.trust(s.id, { trustSecret: 'k' }), 'signature');
  assertThrows(() => store.trust(s.id, { trustSecret: 'k', signature: 'deadbeef' }), 'bad signature');
  assert(store.trust('nope', { trustSecret: 'k', signature: 'x' }) === undefined, 'missing -> undefined');
});

check('trust: good signature grants + pins version; new version invalidates; untrust revokes', () => {
  const crypto = require('crypto');
  const store = createScriptStore({ now });
  const SECRET = 'trust-secret-test';
  const s = store.create({ name: 'tg2', code: 'BODY_V1', version: '1.0.0' });
  const sig = crypto.createHash('sha256').update('BODY_V1:' + SECRET).digest('hex');
  const t = store.trust(s.id, { signature: sig, trustSecret: SECRET, actor: 'admin' });
  assert(t.trusted === true && t.trustedVersion === '1.0.0', 'granted: ' + JSON.stringify({ trusted: t.trusted, v: t.trustedVersion }));
  assert(store.get(s.id).trusted === true, 'persisted bit');
  // wrong secret fails
  assertThrows(() => store.trust(s.id, { signature: sig, trustSecret: 'wrong' }), 'bad signature');
  // new version invalidates until re-signed
  store.addVersion(s.id, 'BODY_V2');
  assert(store.get(s.id).trusted === false, 'version bump clears trust');
  const sig2 = crypto.createHash('sha256').update('BODY_V2:' + SECRET).digest('hex');
  store.trust(s.id, { signature: sig2, trustSecret: SECRET });
  assert(store.get(s.id).trusted === true && store.get(s.id).trustedVersion === '1.0.1', 're-signed on new version');
  // untrust revokes
  const u = store.untrust(s.id);
  assert(u.trusted === false, 'revoked');
  assert(store.get(s.id).trusted === false, 'persisted revoke');
  assert(store.untrust('nope') === undefined, 'missing -> undefined');
  // no versions -> cannot sign
  const bare = store.create({ name: 'tg-bare' });
  assertThrows(() => store.trust(bare.id, { trustSecret: SECRET, signature: sig }), 'no versions');
});

console.log('SUMMARY pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
