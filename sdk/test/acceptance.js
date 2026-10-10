'use strict';
// Acceptance for the automation SDK + MClient integration + e2e business suite.
// Asserts every deliverable exists AND that each verification command runs
// through (exit 0). Set FP_ACCEPTANCE_SKIP_ELECTRON=1 to skip the Electron
// MClient check (it spawns electron.exe, ~40s). PASS/FAIL/SKIP lines; exit 0
// == all deliverables present and all verification commands green.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..'); // sdk/test -> repo root

let pass = 0;
let fail = 0;
let skip = 0;
function t(name, ok, detail) {
  if (ok === undefined) {
    skip++;
    console.log('SKIP ' + name);
  } else if (ok) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function exists(rel) {
  return fs.existsSync(path.join(REPO, rel));
}
function read(rel) {
  try {
    return fs.readFileSync(path.join(REPO, rel), 'utf8');
  } catch (_) {
    return '';
  }
}
function runNode(args, label) {
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const summary = (out.split('\n').filter((l) => /^SUMMARY/.test(l))[0] || '').trim();
  const ok = r.status === 0;
  t(label + ' verification command exits 0', ok, ok ? '' : 'exit=' + r.status + ' ' + summary + ' ' + out.slice(-200));
  return ok;
}

// ===== 1. deliverables exist =====
const FILES = [
  'sdk/core/package.json', 'sdk/core/index.js', 'sdk/core/index.d.ts', 'sdk/core/test/smoke.js',
  'sdk/browser/package.json', 'sdk/browser/index.js', 'sdk/browser/index.d.ts', 'sdk/browser/test/smoke.js',
  'sdk/tasks/package.json', 'sdk/tasks/index.js', 'sdk/tasks/index.d.ts', 'sdk/tasks/test/smoke.js',
  'sdk/rpa/package.json', 'sdk/rpa/index.js', 'sdk/rpa/index.d.ts', 'sdk/rpa/test/smoke.js',
  'MClient/test-automation-integration.js',
  'automation/e2e/run-all.js',
  'Client/test-automation-browser.js',
  'MClient/test-automation-panel.js',
  'MClient/test-automation-rpa.js',
  'automation/runtime/rpa-service.js',
  'MClient/renderer/automation-panel/panel.js',
  'automation/test-security.js',
  'automation/test-perf.js',
  'docs/automation-research/18-delivery-manifest.md',
];
for (const f of FILES) t('deliverable exists: ' + f, exists(f));

// ===== 2. MClient wiring present =====
const mcMain = read('MClient/main.js');
t('MClient/main.js wires automation (wireAutomation + attachAutomation)', /wireAutomation/.test(mcMain) && /attachAutomation/.test(mcMain));
const mcPre = read('MClient/preload.js');
t('MClient/preload.js exposes automationApi facade', /exposeInMainWorld\('automationApi'/.test(mcPre));
t('Client/preload.js exposes rpaApi (visual workflow)', /exposeInMainWorld\('rpaApi'/.test(read('Client/preload.js')));
t('MClient/preload.js exposes rpaApi (visual workflow)', /exposeInMainWorld\('rpaApi'/.test(mcPre));

// ===== 3. verification commands run through =====
runNode(['sdk/core/test/smoke.js'], 'sdk-core');
runNode(['sdk/browser/test/smoke.js'], 'sdk-browser');
runNode(['sdk/tasks/test/smoke.js'], 'sdk-tasks');
runNode(['sdk/rpa/test/smoke.js'], 'sdk-rpa');
runNode(['automation/e2e/run-all.js'], 'e2e-business');
runNode(['automation/test-security.js'], 'security-suite');
runNode(['automation/test-perf.js'], 'perf-suite');
if (process.env.FP_ACCEPTANCE_SKIP_ELECTRON === '1') {
  t('mclient-integration verification command exits 0', undefined);
  t('mclient-automation-panel verification command exits 0', undefined);
  t('mclient-automation-rpa verification command exits 0', undefined);
  t('client-automation-browser verification command exits 0', undefined);
} else {
  runNode(['MClient/run-tests.js', 'test-automation-integration.js'], 'mclient-integration');
  runNode(['MClient/run-tests.js', 'test-automation-panel.js'], 'mclient-automation-panel');
  runNode(['MClient/run-tests.js', 'test-automation-rpa.js'], 'mclient-automation-rpa');
  runNode(['Client/run-tests.js', 'test-automation-browser.js'], 'client-automation-browser');
}

// ===== 4. delivery manifest =====
console.log('');
console.log('=== Delivery manifest ===');
console.log('SDK (external thin clients, zero browser logic):');
console.log('  @fp-automation/core    -> sdk/core    | verify: node sdk/core/test/smoke.js');
console.log('  @fp-automation/browser -> sdk/browser | verify: node sdk/browser/test/smoke.js');
console.log('  @fp-automation/tasks   -> sdk/tasks   | verify: node sdk/tasks/test/smoke.js');
console.log('  @fp-automation/rpa     -> sdk/rpa     | verify: node sdk/rpa/test/smoke.js');
console.log('MClient integration (usable client):');
console.log('  MClient/main.js wireAutomation + MClient/preload.js automationApi');
console.log('  verify: node MClient/run-tests.js test-automation-integration.js');
console.log('E2E business suite (all flows):');
console.log('  automation/e2e/run-all.js | verify: node automation/e2e/run-all.js');
console.log('Runtime it builds on (existing): automation/runtime/* + automation/electron/*');
console.log('Docs: docs/automation-research/00..18 (18 = delivery manifest)');

console.log('');
console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
process.exit(fail === 0 ? 0 : 1);
