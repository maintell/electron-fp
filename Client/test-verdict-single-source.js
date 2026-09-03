// Gate the single-source-of-truth property of the self-test decision table.
//
// The verdict logic used to exist twice: once inside main.js's `selftest:run`
// handler and once copy-pasted into test-selftest.js. Those two copies had
// already drifted - the handler produced expected/got strings and
// explainMismatch() hints, the test's copy produced neither - which meant the
// test was asserting against a re-implementation and could stay green while
// the shipped behaviour was wrong.
//
// That duplication is now gone: fp-probe.js owns verdicts() and everyone calls
// it. This test keeps it gone. It is plain Node (no Electron), so it runs on
// every suite invocation and costs milliseconds.

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'Client');
const MAIN = path.join(CLIENT, 'main.js');
const PROBE = path.join(CLIENT, 'fp-probe.js');
const TEST = path.join(CLIENT, 'test-selftest.js');

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const main = fs.readFileSync(MAIN, 'utf8');
const probe = fs.readFileSync(PROBE, 'utf8');
const test = fs.readFileSync(TEST, 'utf8');

// --- 1. fp-probe.js owns the decision table -------------------------------
const probeDefines = /function verdicts\s*\(/.test(probe);
ck('fp-probe.js defines verdicts()', probeDefines);
ck('fp-probe.js exports verdicts',
  /module\.exports\s*=\s*\{[^}]*\bverdicts\b/.test(probe),
  probeDefines ? 'exported' : '');

// --- 2. main.js CALLS it rather than re-implementing it -------------------
// Find the selftest:run handler body and look for the branch it used to have.
const hIdx = main.indexOf("ipcMain.handle('selftest:run'");
const nextHandler = main.indexOf('ipcMain.handle(', hIdx + 10);
const handlerBody = main.slice(hIdx, nextHandler < 0 ? main.length : nextHandler);

ck('main.js has a selftest:run handler', hIdx >= 0);
ck('main.js imports verdicts from fp-probe',
  /require\('\.\/fp-probe'\)/.test(main) && /verdicts/.test(main));
ck('main.js calls verdicts() in the handler',
  /verdicts\(/.test(handlerBody));
ck('main.js does NOT re-implement the verdict loop',
  !/for\s*\(\s*const\s+key\s+of\s+PROBE_FIELDS\s*\)\s*\{/.test(handlerBody),
  /for\s*\(\s*const\s+key\s+of\s+PROBE_FIELDS/.test(handlerBody)
    ? 'found an inline PROBE_FIELDS loop in the handler'
    : 'delegates to fp-probe.js');
ck('main.js does NOT build its own summary counters',
  !/const\s+summary\s*=\s*\{\s*pass:\s*0/.test(handlerBody),
  /const\s+summary\s*=\s*\{\s*pass:\s*0/.test(handlerBody)
    ? 'found an inline summary loop'
    : 'uses the shared summary');

// --- 3. the test does not carry a second copy -----------------------------
ck('test-selftest.js imports verdicts from fp-probe',
  /require\('\.\/fp-probe'\)/.test(test) && /\bverdicts\b/.test(test));
ck('test-selftest.js does NOT re-implement the verdict loop',
  !/function\s+verdicts\s*\(/.test(test),
  /function\s+verdicts\s*\(/.test(test)
    ? 'found a local function verdicts()'
    : 'no local copy');

// --- 4. no third copy anywhere else ---------------------------------------
// This file names `function verdicts(` only inside the regexes below, so it
// must exclude itself or it would flag itself on every run.
const SELF = 'test-verdict-single-source.js';
const others = fs.readdirSync(CLIENT)
  .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-selftest.js' && f !== SELF)
  .filter((f) => /function\s+verdicts\s*\(/.test(fs.readFileSync(path.join(CLIENT, f), 'utf8')));
ck('no other test defines its own verdicts()', others.length === 0,
  others.length ? others.join(', ') : 'none');

// --- 5. the shared function is actually reachable by both callers ---------
const { verdicts, PROBE_FIELDS } = require('../Client/fp-probe.js');
ck('verdicts() is callable', typeof verdicts === 'function');
const r = verdicts({ tz_id: 'America/New_York' }, { tz_id: 'America/New_York' },
  { isActive: (k, v) => v !== undefined && v !== null && v !== '' });
ck('verdicts() returns one row per probe field',
  r.rows.length === PROBE_FIELDS.length,
  r.rows.length + ' rows / ' + PROBE_FIELDS.length + ' fields');
ck('verdicts() returns a 4-way summary',
  r.summary && ['pass', 'fail', 'skip', 'error'].every((k) => k in r.summary),
  JSON.stringify(r.summary));
const tzRow = r.rows.find((x) => x.key === 'tz_id');
ck('verdicts() passes a configured and applied key', tzRow && tzRow.verdict === 'pass',
  tzRow ? tzRow.verdict : 'no row');

// --- 6. the error branch must not throw while reporting -------------------
// A value whose toString() throws reaches the `error` verdict, where the
// obvious handler body `String(got)` throws AGAIN - the catch dies while
// handling the error and the row is never pushed.
const poisoned = {};
Object.defineProperty(poisoned, 'toString', {
  value: () => { throw new Error('poisoned toString'); },
  enumerable: false,
});
let threw = null, res = null;
try {
  res = verdicts({ tz_id: 'America/New_York' }, { tz_id: poisoned },
    { isActive: (k, v) => v !== undefined && v !== null && v !== '' });
} catch (e) { threw = e; }
ck('a throwing compare is reported, not re-thrown',
  threw === null, threw ? 're-threw: ' + threw.message : 'handled');
const eRow = res && res.rows.find((x) => x.key === 'tz_id');
ck('a throwing compare yields verdict=error', eRow && eRow.verdict === 'error',
  eRow ? eRow.verdict : 'no row');

console.log('');
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
