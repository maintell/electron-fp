// R7 (OQ-17 residual): fingerprintRotate stop->update->start rollback consistency.
// When the rotate restart (start) FAILS, what is stored vs what the runtime would use?
// New file only; no source changes. Output lines start with PASS/FAIL for the runner.
'use strict';

const fs = require('fs');
const path = require('path');
const { createProfileManager } = require('./runtime/profile-manager');

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : err));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

let tick = 0;
const now = () => {
  tick += 1;
  return new Date(1700000000000 + tick * 1000).toISOString();
};

function snapFp(fp) {
  return fp === undefined ? null : JSON.parse(JSON.stringify(fp));
}

async function main() {
  // --- primary: in-memory manager, launcher.start fails ONLY on the rotate restart ---
  await check('rotate start-failure: stored fingerprint vs runtime state vs next start (in-memory)', async () => {
    const startCalls = [];
    let attempt = 0;
    const flaky = {
      start: async (profile) => {
        attempt += 1;
        startCalls.push({ attempt, fingerprint: snapFp(profile.fingerprint) });
        if (attempt === 2) throw new Error('BOOM: rotate restart failed');
        return { inProcess: true };
      },
      stop: async () => {},
    };

    const pm = createProfileManager({ now, launcher: flaky });
    const p = pm.create({ name: 'rot-fail', fingerprint: { hardware_concurrency: 4 } });

    // attempt 1: initial start -> running with OLD fingerprint
    await pm.start(p.id);
    const initial = pm.get(p.id);
    assert(initial.status === 'running', 'initial status running, got ' + initial.status);
    assert(initial.fingerprint.hardware_concurrency === 4, 'initial stored fp = OLD(4)');
    assert(initial.meta.everStarted === true, 'everStarted frozen after first start');

    // attempt 2: rotate applies NEW fp, stop, restart -> start FAILS
    let err = null;
    try {
      await pm.fingerprintRotate(p.id, { hardware_concurrency: 9 });
    } catch (e) {
      err = e;
    }
    assert(err && /BOOM/.test(err.message), 'rotate rethrows launcher failure, got: ' + (err && err.message));

    const after = pm.get(p.id);
    console.log('EVIDENCE after-failed-rotate: status=' + after.status +
      ' storedFingerprint=' + JSON.stringify(after.fingerprint) +
      ' everStarted=' + (after.meta && after.meta.everStarted) +
      ' lastEndpoint=' + JSON.stringify(after.lastEndpoint === undefined ? null : after.lastEndpoint));
    console.log('EVIDENCE launcher.start calls=' + JSON.stringify(startCalls));

    // (a) stored fingerprint after failed rotate
    const stored = after.fingerprint;
    // (b) runtime state after failed rotate
    const statusAfter = after.status;
    // (c) a subsequent start
    const restarted = await pm.start(p.id);
    const used = startCalls[2] && startCalls[2].fingerprint; // attempt 3
    console.log('EVIDENCE subsequent-start: status=' + restarted.status +
      ' fingerprintPassedToLauncher=' + JSON.stringify(used));

    // Invariant: whatever is stored must be exactly what the next start replays.
    const consistent = JSON.stringify(used) === JSON.stringify(stored);
    assert(consistent,
      'MISMATCH: stored=' + JSON.stringify(stored) + ' but next start used=' + JSON.stringify(used));
    // Document the actual (no-rollback) semantics: rotate intent persisted, runtime honest 'error'.
    assert(stored.hardware_concurrency === 9,
      'stored is NEW (rotate intent, no rollback), got ' + JSON.stringify(stored));
    assert(statusAfter === 'error',
      'runtime state honest error after failed restart, got ' + statusAfter);
    assert(restarted.status === 'running', 'subsequent start succeeds');
    assert(used.hardware_concurrency === 9, 'subsequent start uses NEW fingerprint');
  });

  // --- persisted view: disk after failed rotate, then a clean restart ---
  await check('rotate start-failure: on-disk state survives reload; clean restart uses NEW fp', async () => {
    const dir = path.join('F:\\Temp\\opencode', 'fp-rot-rollback-' + process.pid);
    const file = path.join(dir, 'profiles.json');
    fs.rmSync(dir, { recursive: true, force: true });

    let attempt = 0;
    const flaky = {
      start: async () => {
        attempt += 1;
        if (attempt === 2) throw new Error('BOOM: rotate restart failed');
        return { inProcess: true };
      },
      stop: async () => {},
    };

    const pm = createProfileManager({ file, now, launcher: flaky });
    const p = pm.create({ name: 'rot-file', fingerprint: { hardware_concurrency: 4 } });
    await pm.start(p.id);
    let err = null;
    try {
      await pm.fingerprintRotate(p.id, { hardware_concurrency: 9 });
    } catch (e) {
      err = e;
    }
    assert(err && /BOOM/.test(err.message), 'rotate threw');

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log('EVIDENCE on-disk after-failed-rotate: status=' + raw[0].status +
      ' fingerprint=' + JSON.stringify(raw[0].fingerprint));
    assert(raw[0].status === 'error', 'disk status = error, got ' + raw[0].status);
    assert(raw[0].fingerprint.hardware_concurrency === 9, 'disk fingerprint = NEW(9), got ' + JSON.stringify(raw[0].fingerprint));

    // reload with a now-healthy launcher: start must replay the NEW stored fingerprint
    let used = null;
    const healthy = {
      start: async (profile) => {
        used = snapFp(profile.fingerprint);
        return { inProcess: true };
      },
      stop: async () => {},
    };
    const re = createProfileManager({ file, now, launcher: healthy });
    assert(re.status(p.id).status === 'error', 'reload sees error state');
    const r = await re.start(p.id);
    assert(r.status === 'running', 'clean restart succeeds');
    assert(used && used.hardware_concurrency === 9, 'clean restart replays NEW fp, got ' + JSON.stringify(used));

    fs.rmSync(dir, { recursive: true, force: true });
    assert(!fs.existsSync(dir), 'temp dir cleaned');
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + (e && e.stack ? e.stack : e));
  console.log('SUMMARY pass=' + pass + ' fail=' + (fail + 1));
  process.exit(1);
});
