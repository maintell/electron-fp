'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashSeed, createRng } = require('./runtime/seeded-rng');
const { createTaskQueue } = require('./runtime/task-queue');
const { createWorker } = require('./runtime/worker');

let pass = 0;
let fail = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log('PASS ' + name);
    })
    .catch((err) => {
      fail++;
      console.log('FAIL ' + name + ' :: ' + err.message);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await check('determinism: same seed identical 100-next() sequences', () => {
    const a = createRng('profile-A');
    const b = createRng('profile-A');
    for (let i = 0; i < 100; i++) {
      const x = a.next();
      const y = b.next();
      assert(x === y, 'diverged at draw ' + i + ': ' + x + ' vs ' + y);
    }
  });

  await check('divergence: profile-A vs profile-B differ in first-10', () => {
    const a = createRng('profile-A');
    const b = createRng('profile-B');
    let diff = 0;
    for (let i = 0; i < 10; i++) {
      if (a.next() !== b.next()) diff++;
    }
    assert(diff >= 1, 'seeds did not diverge in 10 draws');
  });

  await check('hashSeed stable uint32 + 1-char avalanche', () => {
    const h1 = hashSeed('x');
    const h2 = hashSeed('x');
    assert(h1 === h2, 'unstable: ' + h1 + ' vs ' + h2);
    assert(Number.isInteger(h1) && h1 >= 0 && h1 <= 0xffffffff, 'not uint32: ' + h1);
    assert(hashSeed('ab') !== hashSeed('ac'), 'no avalanche on 1-char change');
  });

  await check('int bounds: [1,6]x200 + (5,5)=5 + (6,1) throws', () => {
    const r = createRng('int-test');
    for (let i = 0; i < 200; i++) {
      const v = r.int(1, 6);
      assert(Number.isInteger(v) && v >= 1 && v <= 6, 'int(1,6) out of range: ' + v);
    }
    for (let i = 0; i < 10; i++) assert(r.int(5, 5) === 5, 'int(5,5) must be 5');
    let threw = false;
    try {
      r.int(6, 1);
    } catch (e) {
      threw = true;
    }
    assert(threw, 'int(6,1) must throw');
  });

  await check('jitter bounds: jitter(1000,0.2)x200 in [800,1200]', () => {
    const r = createRng('jitter-test');
    for (let i = 0; i < 200; i++) {
      const v = r.jitter(1000, 0.2);
      assert(v >= 800 && v <= 1200, 'jitter out of range: ' + v);
    }
  });

  await check('no Math.random in seeded-rng.js source', () => {
    const src = fs.readFileSync(path.join(__dirname, 'runtime', 'seeded-rng.js'), 'utf8');
    // strip comments: own header comment names Math.random to document its absence
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/Math\.random/.test(code), 'seeded-rng.js uses Math.random');
  });

  await check('task-queue determinism: same seed same fail() backoff nextRunAt', () => {
    function runOnce() {
      const T = 1000000;
      const q = createTaskQueue({ now: () => T, rng: createRng('p1') });
      const item = q.enqueue({ scriptId: 's1', params: {}, profileContext: { id: 'p1' } });
      q.claim(); // QUEUED -> RUNNING so fail() takes the retry path
      q.fail(item.id, { name: 'NetworkError', message: 'conn reset' });
      return q.get(item.id);
    }
    const a = runOnce();
    const b = runOnce();
    assert(a.status === 'QUEUED', 'retry -> QUEUED, got ' + a.status);
    assert(a.nextRunAt === b.nextRunAt, 'nextRunAt differs: ' + a.nextRunAt + ' vs ' + b.nextRunAt);
    assert(a.nextRunAt > 1000000, 'nextRunAt must be future backoff, got ' + a.nextRunAt);
  });

  await check('worker rng opt: starts/stops cleanly on null-claim queue', async () => {
    const w = createWorker({
      queue: { claim: () => null },
      execute: async () => ({ result: 1 }),
      rng: createRng('w'),
      pollMs: 10,
      heartbeatMs: 60000,
    });
    w.start();
    await sleep(50);
    await w.stop();
    assert(w.status().state === 'stopped', 'state stopped, got ' + w.status().state);
  });

  await check('seed-not-persisted: createRng leaves no seed|rng tmp files', () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));
    const r = createRng('profile-A');
    for (let i = 0; i < 100; i++) r.next();
    r.int(1, 6);
    r.jitter(1000, 0.2);
    const created = fs
      .readdirSync(os.tmpdir())
      .filter((f) => !before.has(f) && /seed|rng/i.test(f));
    assert(created.length === 0, 'new seed/rng tmp files: ' + JSON.stringify(created));
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + e.message);
  process.exit(1);
});
