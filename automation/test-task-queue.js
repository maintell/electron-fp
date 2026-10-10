'use strict';

const { createTaskQueue } = require('./runtime/task-queue');

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

// fixed clock + audit capture per queue instance
function makeQueue(defaultRetry) {
  const state = { t: 1_000_000, audits: [] };
  const q = createTaskQueue({
    now: () => state.t,
    audit: (e) => state.audits.push(e),
    ...(defaultRetry ? { defaultRetry } : {}),
  });
  return { q, state, advance: (ms) => { state.t += ms; } };
}

const netErr = () => ({ name: 'NetworkError', message: 'conn reset', retriable: true });

// --- 1. enqueue -> claim -> complete SUCCESS, legal states throughout ---
check('enqueue/claim/complete SUCCESS, states legal', () => {
  const { q } = makeQueue();
  const item = q.enqueue({ scriptId: 's1', version: 'v2', params: { a: 1 }, profileContext: { id: 'p1' } });
  assert(item.status === 'QUEUED', 'enqueue -> QUEUED, got ' + item.status);
  assert(q.get(item.id) && q.get(item.id).status === 'QUEUED', 'get QUEUED');
  const claimed = q.claim();
  assert(claimed && claimed.id === item.id, 'claim returns item');
  assert(claimed.status === 'RUNNING', 'claim -> RUNNING, got ' + claimed.status);
  assert(typeof claimed.claimedAt === 'number', 'claimedAt set');
  assert(q.get(item.id).status === 'RUNNING', 'get RUNNING');
  q.complete(item.id, { out: 42 });
  const done = q.get(item.id);
  assert(done.status === 'SUCCESS', 'complete -> SUCCESS, got ' + done.status);
  assert(done.result && done.result.out === 42, 'result stored');
  const path = done; // sampled via get() only — no external state reads
  assert(path.attempts === 0, 'attempts untouched on success');
});

// --- 2. retriable fail -> RETRYING -> QUEUED, backoff, claim gate by clock ---
check('fail NetworkError -> RETRYING->QUEUED, attempts=1, backoff, claim null before due', () => {
  const { q, state, advance } = makeQueue({ max: 3, baseMs: 5000, mult: 3, jitter: 0 });
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  const t0 = state.t;
  q.claim();
  q.fail(item.id, netErr());
  const got = q.get(item.id);
  assert(got.status === 'QUEUED', 'retry -> QUEUED, got ' + got.status);
  assert(got.attempts === 1, 'attempts=1, got ' + got.attempts);
  assert(got.nextRunAt === t0 + 5000, 'backoff baseMs*mult^0=5000, got ' + (got.nextRunAt - t0));
  assert(got.nextRunAt > t0, 'nextRunAt future');
  assert(got.lastError && got.lastError.name === 'NetworkError' && got.lastError.retriable === true, 'lastError set');
  const denied = state.audits.filter((a) => a.action === 'state-deny');
  assert(denied.length === 0, 'no state-deny');
  const rt = state.audits.filter((a) => a.action === 'state' && a.id === item.id && a.from === 'RETRYING' && a.to === 'QUEUED');
  assert(rt.length === 1, 'audit RETRYING->QUEUED present');
  assert(q.claim() === null, 'claim null before due');
  advance(4999);
  assert(q.claim() === null, 'claim null at due-1');
  advance(1);
  const again = q.claim();
  assert(again && again.status === 'RUNNING', 'claim after due -> RUNNING');
});

check('backoff grows exponentially, capped at 300000', () => {
  const { q, state, advance } = makeQueue({ max: 10, baseMs: 5000, mult: 3, jitter: 0 });
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  const expected = [5000, 15000, 45000, 135000, 300000, 300000];
  for (const exp of expected) {
    q.claim();
    const t = state.t;
    q.fail(item.id, netErr());
    const delay = q.get(item.id).nextRunAt - t;
    assert(delay === exp, 'delay=' + delay + ' expected=' + exp);
    advance(exp);
  }
  assert(q.get(item.id).attempts === expected.length, 'attempts=' + q.get(item.id).attempts);
});

check('jitter within ±20% of base delay', () => {
  const { q, state } = makeQueue({ max: 3, baseMs: 5000, mult: 3, jitter: 0.2 });
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  const t = state.t;
  q.fail(item.id, netErr());
  const delay = q.get(item.id).nextRunAt - t;
  assert(delay >= 4000 && delay <= 6000, 'delay ' + delay + ' outside [4000,6000]');
});

// --- 3. attempts exhaustion -> FAILED ---
check('retriable fail exhaustion -> FAILED terminal', () => {
  const { q, state, advance } = makeQueue({ max: 2, baseMs: 100, mult: 3, jitter: 0 });
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  // attempt cycle: attempts counts retries scheduled; max=2 => 1st fail retries (attempts=1), 2nd retries (attempts=2), 3rd exhausts
  for (let i = 0; i < 2; i++) {
    q.claim();
    q.fail(item.id, netErr());
    assert(q.get(item.id).status === 'QUEUED', 'retry cycle ' + i + ' QUEUED');
    advance(1000);
  }
  q.claim();
  q.fail(item.id, netErr());
  const got = q.get(item.id);
  assert(got.status === 'FAILED', 'exhausted -> FAILED, got ' + got.status);
  assert(got.attempts === 2, 'attempts stays at max, got ' + got.attempts);
  assert(got.lastError.retriable === true, 'lastError kept');
  assert(q.claim() === null, 'no claim after FAILED');
});

// --- 4. non-retriable taxonomy -> immediate FAILED ---
check('PermissionError -> immediate FAILED, no retry', () => {
  const { q, state } = makeQueue();
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.fail(item.id, { name: 'PermissionError', message: 'fence deny' });
  const got = q.get(item.id);
  assert(got.status === 'FAILED', 'FAILED immediately, got ' + got.status);
  assert(got.attempts === 0, 'no retry scheduled, attempts=' + got.attempts);
  assert(got.lastError.retriable === false, 'lastError.retriable=false');
  assert(q.claim() === null, 'nothing claimable');
  const retried = state.audits.filter((a) => a.action === 'state' && a.to === 'RETRYING');
  assert(retried.length === 0, 'no RETRYING transition');
});

check('SelectorError non-retriable by taxonomy; err.retriable=true flag wins', () => {
  const { q } = makeQueue();
  const a = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.fail(a.id, { name: 'SelectorError', message: 'no match' });
  assert(q.get(a.id).status === 'FAILED', 'SelectorError default FAILED');
  const { q: q2 } = makeQueue();
  const b = q2.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q2.claim();
  q2.fail(b.id, { name: 'SelectorError', message: 'flake', retriable: true });
  assert(q2.get(b.id).status === 'QUEUED', 'retriable flag wins over taxonomy');
  assert(q2.get(b.id).attempts === 1, 'flag path increments attempts');
});

// --- 5. timeout / crash: terminal or retry per policy ---
check('timeout with attempts left -> RETRYING->QUEUED', () => {
  const { q, state } = makeQueue({ max: 3, baseMs: 5000, mult: 3, jitter: 0 });
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  const t = state.t;
  q.timeout(item.id);
  const got = q.get(item.id);
  assert(got.status === 'QUEUED', 'timeout retried -> QUEUED, got ' + got.status);
  assert(got.attempts === 1, 'attempts=1');
  assert(got.nextRunAt - t === 5000, 'TimeoutError backoff applied');
  assert(got.lastError.name === 'TimeoutError' && got.lastError.retriable === true, 'lastError TimeoutError');
  const sawTimeout = state.audits.some((a) => a.action === 'state' && a.id === item.id && a.to === 'TIMEOUT');
  assert(sawTimeout, 'TIMEOUT state transition audited before retry');
});

check('timeout exhausted -> TIMEOUT terminal; crash exhausted -> CRASHED terminal', () => {
  const { q, advance } = makeQueue({ max: 1, baseMs: 1, mult: 3, jitter: 0 });
  const a = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.timeout(a.id); // attempts 0<1 -> retry
  assert(q.get(a.id).status === 'QUEUED', 'first timeout retries');
  advance(10); // clear backoff gate (baseMs=1)
  assert(q.claim(), 'claimable after backoff');
  q.timeout(a.id); // attempts 1<1 false -> TIMEOUT terminal
  assert(q.get(a.id).status === 'TIMEOUT', 'exhausted timeout -> TIMEOUT, got ' + q.get(a.id).status);
  assert(q.claim() === null, 'TIMEOUT not claimable');

  const b = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.crash(b.id);
  assert(q.get(b.id).status === 'QUEUED', 'crash with attempts left -> QUEUED');
  assert(q.get(b.id).lastError.name === 'CrashError', 'CrashError recorded');
  advance(10);
  assert(q.claim(), 'claimable after crash backoff');
  q.crash(b.id);
  assert(q.get(b.id).status === 'CRASHED', 'exhausted crash -> CRASHED, got ' + q.get(b.id).status);
  assert(q.claim() === null, 'CRASHED not claimable');
});

// --- 6. pause / resume / cancel / stop ---
check('pause/resume legal: RUNNING->PAUSED->RUNNING', () => {
  const { q } = makeQueue();
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.pause(item.id);
  assert(q.get(item.id).status === 'PAUSED', 'pause -> PAUSED');
  q.resume(item.id);
  assert(q.get(item.id).status === 'RUNNING', 'resume -> RUNNING');
});

check('stop RUNNING->STOPPING then worker fail/cancel settle', () => {
  const { q } = makeQueue();
  const a = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.stop(a.id);
  assert(q.get(a.id).status === 'STOPPING', 'stop -> STOPPING');
  q.fail(a.id, netErr());
  assert(q.get(a.id).status === 'QUEUED', 'STOPPING + retriable fail -> QUEUED');

  const b = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.stop(b.id);
  q.cancel(b.id);
  assert(q.get(b.id).status === 'CANCELLED', 'STOPPING + cancel -> CANCELLED');
});

check('cancel any non-terminal; cancel SUCCESS throws + state unchanged + state-deny audit', () => {
  const { q, state } = makeQueue();
  const a = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.cancel(a.id);
  assert(q.get(a.id).status === 'CANCELLED', 'QUEUED cancel -> CANCELLED');

  const b = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.complete(b.id, null);
  assertThrows(() => q.cancel(b.id), 'illegal transition: SUCCESS->CANCELLED');
  assert(q.get(b.id).status === 'SUCCESS', 'state unchanged after deny');
  const deny = state.audits.filter((x) => x.action === 'state-deny' && x.id === b.id && x.to === 'CANCELLED');
  assert(deny.length === 1, 'state-deny audited once');
});

check('illegal ops throw: complete QUEUED, pause QUEUED, resume RUNNING, retryNow RUNNING', () => {
  const { q } = makeQueue();
  const a = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  assertThrows(() => q.complete(a.id, null), 'illegal transition: QUEUED->SUCCESS');
  assertThrows(() => q.pause(a.id), 'illegal transition: QUEUED->PAUSED');
  assert(q.get(a.id).status === 'QUEUED', 'state unchanged');
  q.claim();
  assertThrows(() => q.resume(a.id), 'illegal transition: RUNNING->RUNNING');
  assertThrows(() => q.retryNow(a.id), 'illegal transition: RUNNING->QUEUED');
  assert(q.get(a.id).status === 'RUNNING', 'state unchanged after denies');
});

// --- 7. priority: higher first at equal time, FIFO otherwise ---
check('priority: higher claims first at equal nextRunAt; FIFO without priority', () => {
  const { q } = makeQueue({ max: 3, baseMs: 0, mult: 1, jitter: 0 });
  const low = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' }, priority: 1 });
  const first = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } }); // no priority = 0, enqueued first
  const high = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' }, priority: 10 });
  const mid = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' }, priority: 5 });
  assert(q.claim().id === high.id, 'priority 10 first');
  assert(q.claim().id === mid.id, 'priority 5 second');
  assert(q.claim().id === low.id, 'priority 1 third');
  assert(q.claim().id === first.id, 'no-priority FIFO last among equals');
  assert(q.claim() === null, 'queue empty');
});

// --- 8. manual retryNow ---
check('retryNow FAILED -> QUEUED nextRunAt=now; resetAttempts option', () => {
  const { q, state } = makeQueue({ max: 1, baseMs: 5000, mult: 3, jitter: 0 });
  const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.fail(item.id, { name: 'PermissionError', message: 'no' }); // immediate FAILED, attempts=0
  state.t += 99999;
  q.retryNow(item.id);
  const got = q.get(item.id);
  assert(got.status === 'QUEUED', 'retryNow -> QUEUED');
  assert(got.nextRunAt === state.t, 'nextRunAt=now, got ' + got.nextRunAt);
  assert(q.claim() && q.get(item.id).status === 'RUNNING', 'claimable after retryNow');

  // burn attempts to exhaustion then manual retry with resetAttempts
  const b = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.fail(b.id, netErr()); // attempts=1, max=1 -> QUEUED
  state.t += 10000;
  q.claim();
  q.fail(b.id, netErr()); // attempts=1 not < max=1 -> FAILED
  assert(q.get(b.id).status === 'FAILED', 'exhausted FAILED');
  assert(q.get(b.id).attempts === 1, 'attempts=1 kept');
  q.retryNow(b.id, { resetAttempts: true });
  assert(q.get(b.id).status === 'QUEUED', 'retryNow with reset -> QUEUED');
  assert(q.get(b.id).attempts === 0, 'attempts reset to 0');
});

check('retryNow on TIMEOUT/CRASHED terminal -> QUEUED', () => {
  const { q, state } = makeQueue({ max: 0, baseMs: 1, mult: 1, jitter: 0 });
  const a = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.claim();
  q.timeout(a.id);
  assert(q.get(a.id).status === 'TIMEOUT', 'max=0 timeout -> TIMEOUT');
  q.retryNow(a.id);
  assert(q.get(a.id).status === 'QUEUED', 'TIMEOUT retryNow -> QUEUED');
  assert(q.get(a.id).nextRunAt === state.t, 'nextRunAt=now');
});

// --- 9. stats / list pagination ---
check('stats byStatus+depth; list filters + pagination', () => {
  const { q } = makeQueue();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(q.enqueue({ scriptId: 's' + (i % 2), params: {}, profileContext: { id: 'p1' } }).id);
  q.claim(); // 1 RUNNING
  q.claim();
  q.complete(ids[1], null); // 1 SUCCESS
  const st = q.stats();
  assert(st.total === 5, 'total=5, got ' + st.total);
  assert(st.byStatus.RUNNING === 1, 'RUNNING=1, got ' + JSON.stringify(st.byStatus));
  assert(st.byStatus.SUCCESS === 1, 'SUCCESS=1');
  assert(st.byStatus.QUEUED === 3, 'QUEUED=3, got ' + st.byStatus.QUEUED);
  assert(st.depth === 3, 'depth=QUEUED count, got ' + st.depth);

  const p1 = q.list({ status: 'QUEUED', limit: 2, offset: 0 });
  const p2 = q.list({ status: 'QUEUED', limit: 2, offset: 2 });
  assert(p1.total === 3 && p1.rows.length === 2, 'page1 total=3 len=2');
  assert(p2.total === 3 && p2.rows.length === 1, 'page2 len=1, got ' + p2.rows.length);
  assert(!p1.rows.some((x) => p2.rows.some((y) => y.id === x.id)), 'pages disjoint');
  const byScript = q.list({ scriptId: 's0' });
  assert(byScript.total === 3 && byScript.rows.length === 3, 'scriptId filter works, got ' + byScript.total);
  const def = q.list();
  assert(def.total === 5 && def.rows.length === 5, 'default limit 50 returns all 5, got ' + def.total);
});

// --- 10. shutdown ---
check('shutdown audits and refuses claim', () => {
  const { q, state } = makeQueue();
  q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
  q.shutdown();
  assert(state.audits.some((a) => a.action === 'shutdown'), 'shutdown audited');
  assertThrows(() => q.claim(), 'shut down');
});

// --- extras: crash retry eligibility mirrors timeout; cancel from RETRYING/CREATED-adjacent ---
check('claim returns null on empty queue; unknown id ops throw', () => {
  const { q } = makeQueue();
  assert(q.claim() === null, 'empty claim null');
  assertThrows(() => q.complete('nope', null), 'unknown task item');
  assertThrows(() => q.fail('nope', netErr()), 'unknown task item');
  assertThrows(() => q.cancel('nope'), 'unknown task item');
});

// --- 11. claim({skip}) profile-serial predicate ---
check('claim({skip}) skips matching head, returns next; skipped item claimable later', () => {
  const { q } = makeQueue();
  const a = q.enqueue({ scriptId: 's', params: {}, profileContext: { id: 'pA' } });
  const b = q.enqueue({ scriptId: 's', params: {}, profileContext: { id: 'pB' } });
  const picked = q.claim({ skip: (it) => it.id === a.id });
  assert(picked && picked.id === b.id, 'skipped head, picked b: ' + (picked && picked.id));
  assert(q.get(a.id).status === 'QUEUED', 'skipped a stays QUEUED');
  assert(q.get(a.id).nextRunAt === q.get(b.id).nextRunAt, 'nextRunAt untouched');
  const later = q.claim();
  assert(later && later.id === a.id, 'a claimable once skip gone: ' + (later && later.id));
});

check('claim() no skip → FIFO/priority order unchanged', () => {
  const { q } = makeQueue();
  const a = q.enqueue({ scriptId: 's', params: {}, profileContext: { id: 'pA' } });
  const b = q.enqueue({ scriptId: 's', params: {}, priority: 5, profileContext: { id: 'pB' } });
  const c = q.enqueue({ scriptId: 's', params: {}, profileContext: { id: 'pC' } });
  assert(q.claim().id === b.id, 'priority wins');
  assert(q.claim().id === a.id, 'then FIFO a');
  assert(q.claim().id === c.id, 'then FIFO c');
});

check('claim({skip}) throwing predicate propagates (not swallowed)', () => {
  const { q } = makeQueue();
  q.enqueue({ scriptId: 's', params: {}, profileContext: { id: 'pA' } });
  let threw = null;
  try {
    q.claim({ skip: () => { throw new Error('skip boom'); } });
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.message === 'skip boom', 'predicate error propagated: ' + (threw && threw.message));
});

console.log('SUMMARY pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
