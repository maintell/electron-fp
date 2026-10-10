'use strict';
const assert = require('assert');
const { TEMPLATES, installTemplates, getTemplate } = require('./runtime/script-templates');
const { createScriptStore } = require('./runtime/script-store');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' :: ' + ((e && e.stack) || e));
  }
}

const FORBIDDEN = /require\(|child_process|process\.exit|\bsleep\s*\(/;

check('templates: exactly 11, unique keys', () => {
  assert.strictEqual(TEMPLATES.length, 11, 'count=' + TEMPLATES.length);
  const keys = TEMPLATES.map((t) => t.key);
  assert.strictEqual(new Set(keys).size, 11, 'duplicate keys');
});

check('code: every template parses via new Function async wrapper', () => {
  for (const t of TEMPLATES) {
    assert.doesNotThrow(
      () => new Function('return (async function(){' + t.code + '})'),
      'parse failed: ' + t.key
    );
  }
});

check('permissions: browser true, filesystem/process false; code clean of require/child_process/process.exit/sleep', () => {
  for (const t of TEMPLATES) {
    assert.strictEqual(t.permissions.browser, true, t.key + ' browser');
    assert.strictEqual(t.permissions.filesystem, false, t.key + ' filesystem');
    assert.strictEqual(t.permissions.process, false, t.key + ' process');
    assert.ok(!FORBIDDEN.test(t.code), t.key + ' forbidden pattern');
  }
});

check('parameters: store.create validates every template shape (install round-trip)', () => {
  const store = createScriptStore();
  const r = installTemplates(store);
  assert.strictEqual(r.installed.length, 11, 'installed=' + r.installed.length);
});

check('install: first run installs 11, second run skips 11 (idempotent), list()===11', () => {
  const store = createScriptStore();
  const first = installTemplates(store);
  assert.strictEqual(first.installed.length, 11, 'first installed');
  assert.strictEqual(first.skipped, 0, 'first skipped');
  const second = installTemplates(store);
  assert.strictEqual(second.installed.length, 0, 'second installed');
  assert.strictEqual(second.skipped, 11, 'second skipped=' + second.skipped);
  assert.strictEqual(store.list().length, 11, 'list=' + store.list().length);
});

check("getTemplate('login') matches template + installed script name", () => {
  const store = createScriptStore();
  installTemplates(store);
  const t = getTemplate('login');
  assert.ok(t, 'login template exists');
  assert.strictEqual(t.key, 'login');
  const script = store.list().find((s) => s.name === '[Template] ' + t.name);
  assert.ok(script, 'installed script for login');
});

check('validateParameters: login fake params coerce ok, missing password errors', () => {
  const store = createScriptStore();
  installTemplates(store);
  const t = getTemplate('login');
  const script = store.list().find((s) => s.name === '[Template] ' + t.name);
  const ok = store.validateParameters(script.id, {
    loginUrl: 'https://x.test/login',
    account: 'user@example.com',
    password: 'hunter2',
  });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.errors));
  assert.strictEqual(ok.values.account, 'user@example.com');
  assert.strictEqual(ok.values.password, 'hunter2');
  const bad = store.validateParameters(script.id, { loginUrl: 'https://x.test/login', account: 'u' });
  assert.strictEqual(bad.ok, false, 'missing password must fail');
  assert.ok(bad.errors.some((e) => e.name === 'password'), 'password error present');
});

check('addVersion after install: bump 1.0.0 -> 1.0.1 (copy->edit->save lifecycle)', () => {
  const store = createScriptStore();
  installTemplates(store);
  const t = getTemplate('form-submit');
  const script = store.list().find((s) => s.name === '[Template] ' + t.name);
  const v = store.addVersion(script.id, '// edited\nconsole.log(1);');
  assert.strictEqual(v.version, '1.0.1', 'version=' + v.version);
  const latest = store.getVersion(script.id);
  assert.strictEqual(latest.code, '// edited\nconsole.log(1);');
});

check('data-extraction: single page.evaluate call', () => {
  const t = getTemplate('data-extraction');
  assert.ok(t, 'data-extraction exists');
  const n = (t.code.match(/page\.evaluate\(/g) || []).length;
  assert.strictEqual(n, 1, 'page.evaluate count=' + n);
  assert.ok(!/document\.\w+\(/.test(t.code.replace(/page\.evaluate\([\s\S]*$/, '')), 'document.* outside evaluate');
});

console.log('SUMMARY pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
