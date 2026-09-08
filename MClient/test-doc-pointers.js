// Gate the doc pointers in AGENTS.md.
//
// AGENTS.md is the first file an agent reads, so it points at the expensive
// traps documented in fingerprint/README.md instead of restating them. Those
// pointers reference section titles, which are free to be renamed - and a
// pointer to a section that no longer exists sends the reader nowhere.
//
// This is a plain Node test (no Electron): it only reads files, so it costs
// milliseconds and can run on every suite invocation.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const AGENTS = path.join(REPO, 'AGENTS.md');
const README = path.join(REPO, 'fingerprint', 'README.md');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const agents = fs.existsSync(AGENTS) ? fs.readFileSync(AGENTS, 'utf8') : '';
const readme = fs.existsSync(README) ? fs.readFileSync(README, 'utf8') : '';

check('AGENTS.md is tracked and present', !!agents, AGENTS);
check('fingerprint/README.md is present', !!readme, README);

// Only section 2 carries doc pointers. Section 1.3's quoted strings are
// counterexample error messages ("A parameter cannot be found..."), not
// pointers, and must not be treated as such.
const SECTION2 = '## 2. Related project constraints';
const s2 = agents.includes(SECTION2)
  ? agents.slice(agents.indexOf(SECTION2))
  : '';

const refs = [];
const re = /\*"([^"]+)"/g;
let m;
while ((m = re.exec(s2))) refs.push(m[1]);

check('AGENTS.md carries at least one doc pointer', refs.length > 0,
  refs.length + ' pointers');

let broken = [];
for (const r of refs) {
  // The quoted text starts with the section title; trailing clauses are prose.
  const core = r.split(/[，,]/)[0].trim();
  if (core && !readme.includes(core)) broken.push(core);
}
check('every doc pointer resolves to a real section in fingerprint/README.md',
  broken.length === 0,
  broken.length ? 'broken: ' + broken.join(' | ') : refs.length + ' resolved');

// The traps being pointed at are the ones worth guarding: if someone deletes
// the WebUI scheme section, this fails even if the pointer text still matches
// a stray heading elsewhere.
for (const must of ['注册一个新 WebUI scheme', '配置值格式陷阱']) {
  check('fingerprint/README.md still documents ' + must,
    readme.includes(must), readme.includes(must) ? 'present' : 'MISSING');
}

console.log('');
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
