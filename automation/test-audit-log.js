'use strict';
// Central audit collector: file-backed JSONL + query (database.md §12 shape until SQLite P9).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createAuditLog, scrubValue } = require('./runtime/audit-log');

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

(async () => {
  await t('append defaults index keys (actor/action/entity/entity_id/created_at/seq)', async () => {
    const a = createAuditLog({});
    const r = a.append({ type: 'script-exec', scriptId: 's1', status: 'SUCCESS' });
    assert.strictEqual(typeof r.seq, 'number');
    assert.strictEqual(typeof r.created_at, 'string');
    assert.strictEqual(r.action, 'script-exec');
    assert.strictEqual(r.actor, 'system');
  });

  await t('fn() dual shape: object + (event, detail) like ipc-bridge', async () => {
    const a = createAuditLog({});
    a.fn('ipc-call', { channel: 'automation:status', status: 'ok' });
    a.fn({ type: 'state', id: 't1', from: 'QUEUED', to: 'RUNNING' });
    const q = a.query({});
    assert.strictEqual(q.total, 2);
    assert.strictEqual(q.rows[0].type, 'ipc-call');
    assert.strictEqual(q.rows[1].action, 'state');
  });

  await t('query filters actor/action/entity/entity_id/type + pagination', async () => {
    const a = createAuditLog({});
    a.append({ type: 'execution', action: 'execution', actor: 'root', entity: 'script', entity_id: 's1' });
    a.append({ type: 'execution', action: 'execution', actor: 'dev', entity: 'script', entity_id: 's2' });
    a.append({ type: 'state', action: 'state', actor: 'root', entity: 'task', entity_id: 't1' });
    assert.strictEqual(a.query({ actor: 'root' }).total, 2);
    assert.strictEqual(a.query({ entity: 'script' }).total, 2);
    assert.strictEqual(a.query({ entity_id: 't1' }).rows[0].actor, 'root');
    assert.strictEqual(a.query({ type: 'state' }).total, 1);
    const p = a.query({ limit: 1, offset: 1 });
    assert.strictEqual(p.total, 3);
    assert.strictEqual(p.rows.length, 1);
  });

  await t('scrub at the door: token/password/bearer/FP carrier never stored', async () => {
    const a = createAuditLog({});
    const r = a.append({
      type: 'api', token: 'sekret', password: 'hunter2', bearerToken: 'abc',
      msg: 'Bearer xyz | --fingerprint-config=QUJD | FP_CONFIG_DATA here',
      nested: { proxyPassword: 'pw', ok: 1 },
    });
    const s = JSON.stringify(r);
    assert(!s.includes('sekret') && !s.includes('hunter2') && !s.includes('abc'), 'secret stored: ' + s);
    assert(!s.includes('QUJD') && !s.includes('xyz'), 'carrier stored: ' + s);
    assert(s.includes('***') && s.includes('[SCRUBBED:fp-carrier]'), 'scrub markers: ' + s);
    assert.strictEqual(r.nested.ok, 1);
  });

  await t('file backing: JSONL appended, crash-safe per line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-audit-'));
    const file = path.join(dir, 'audit.jsonl');
    const a = createAuditLog({ file });
    a.append({ type: 'e1', id: 'a' });
    a.append({ type: 'e2', id: 'b' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).type, 'e1');
    assert.strictEqual(JSON.parse(lines[1]).id, 'b');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t('ring capacity drops oldest, stats counts', async () => {
    const a = createAuditLog({ capacity: 3 });
    for (let i = 0; i < 5; i++) a.append({ type: 'x', action: 'x', id: 'i' + i });
    const q = a.query({});
    assert.strictEqual(q.total, 3);
    assert.strictEqual(a.stats().total, 5);
    assert.strictEqual(a.stats().buffered, 3);
  });

  await t('audit never throws the run: bad file path degrades to memory', async () => {
    const a = createAuditLog({ file: path.join('F:\\', 'nonexistent-root-xyz', '\0', 'a.jsonl') });
    const r = a.append({ type: 'x' });
    assert.strictEqual(r.type, 'x');
    assert.strictEqual(a.query({}).total, 1);
  });

  await t('wire: buildLocalStack funnels all modules into one collector', async () => {
    const { buildLocalStack } = require('./electron/wire');
    const st = buildLocalStack({});
    // queue audit (action shape) + manager audit (type shape) land in the same ring
    const item = st.queue.enqueue({ scriptId: 's-wire' });
    st.queue.claim();
    const q = st.service.audit.query({}).data;
    assert(q.total >= 2, 'queue events collected: ' + q.total);
    assert(q.rows.some((r) => r.action === 'state'), 'state rows present');
    assert.strictEqual(st.service.audit.stats().data.total, q.total);
  });

  await t('wire: explicit audit fn still called AND fanned into collector', async () => {
    const { buildLocalStack } = require('./electron/wire');
    const seen = [];
    const st = buildLocalStack({ audit: (e) => seen.push(e) });
    st.queue.enqueue({ scriptId: 's-fan' });
    assert(seen.length >= 1, 'explicit fn called');
    assert(st.service.audit.query({}).data.total >= 1, 'collector fanned');
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exitCode = fail > 0 ? 1 : 0;
})();
