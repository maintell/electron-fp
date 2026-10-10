'use strict';
// ponytail: real-browser resource accounting at a 10-profile tier — acceptance #32 boundary
// ("真浏览器资源账 50/100 真 profile", docs/automation/testing.md §5).
//
// What it does: starts FP_STRESS_N REAL hidden BrowserWindows, each on its own
// persist:auto-<id> partition (launcher), attaches ONE reusable glue CDP session
// per window (executor reuses live handles that already carry session/adapter/rng —
// a fresh attach per run would throw "debugger already attached" on the 2nd run),
// then routes FP_STRESS_N*5 script tasks through per-profile managers + ONE worker
// (concurrency 5). Measures app.getAppMetrics() before/peak/after and asserts
// zero loss, per-profile serialization, global cap, heartbeat and real-window count.
//
// Scale switch (default 10 profiles x 5 items = 50 items):
//   PowerShell, from the repo root, resources/app stashed to _app_off first:
//     $env:FP_STRESS_N=10 ; & "F:\code\src\out\Default\electron.exe" automation\probe-real-stress.js
//     $env:FP_STRESS_N=50 ; ...   # 50 real profiles / 250 items
//     $env:FP_STRESS_N=100; ...   # 100 real profiles / 500 items (next tier, one command)
//
// ponytail: per-profile managers (not a shared mutable "current task" global) are the
// cleanest way to bind executor.for(ctx) without editing automation-manager.js:
// runnerFactory() takes no args, so the factory must already be context-bound.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { createElectronLauncher } = require('./electron/launcher');
const { createElectronSession } = require('./electron/glue');
const { createElectronExecutor } = require('./electron/executor');
const { createScriptStore } = require('./runtime/script-store');
const { createAutomationManager } = require('./runtime/automation-manager');
const { createTaskQueue } = require('./runtime/task-queue');
const { createWorker } = require('./runtime/worker');

let pass = 0;
let fail = 0;
function ok(name) {
  pass++;
  console.log('PASS ' + name);
}
function bad(name, err) {
  fail++;
  console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : String(err)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N = Math.max(1, Number(process.env.FP_STRESS_N) || 10);
const ITEMS_PER_PROFILE = 5;
const CONCURRENCY = 5;
const ITEM_BUDGET_MS = 120000;
const PAGE_FILE = 'F:\\Temp\\stress-page.html';
const PAGE_URL = 'file:///F:/Temp/stress-page.html';
const PAGE_HTML = [
  '<html><body>',
  '<div id="ok">ready</div>',
  "<button id=\"b\" onclick=\"var n=document.getElementById('n');n.textContent=String(Number(n.textContent)+1)\">b</button>",
  '<div id="n">0</div>',
  '</body></html>',
].join('\n');
const CODE = [
  'step("run");',
  'await browser.goto(params.url);',
  'await page.waitForSelector("#ok");',
  'const t = await page.getText("#ok");',
  'if (!String(t).includes("ready")) throw new ScriptError("bad #ok text: " + t);',
  'return t;',
].join('\n');
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'CRASHED']);

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch (_) {}
    }
  } catch (_) {}
}

function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, n - s.length));
}

// One attached glue session per profile, exposed on the handle so executor.js
// reuses it instead of creating+attaching a new CDP session per run.
function createRichLauncher({ createWindow, audit } = {}) {
  const base = createElectronLauncher({ createWindow, audit });
  const esByProfile = new Map();
  return {
    async start(profile) {
      const ep = await base.start(profile);
      const h = base.acquire(profile.id);
      const es = createElectronSession({ webContents: h.webContents, profileId: profile.id, audit });
      await es.start(); // attach CDP exactly once per profile
      esByProfile.set(profile.id, es);
      return ep;
    },
    acquire(id) {
      const h = base.acquire(id);
      if (!h) return undefined;
      const es = esByProfile.get(id);
      if (!es) return h;
      return {
        window: h.window,
        webContents: h.webContents,
        electronSession: h.electronSession,
        session: es.session,
        adapter: es.adapter,
        rng: es.rng,
      };
    },
    async stop(id) {
      const es = esByProfile.get(id);
      if (es) {
        try {
          await es.stop();
        } catch (_) {}
        esByProfile.delete(id);
      }
      return base.stop(id);
    },
    list: () => base.list(),
  };
}

function sampleMetrics() {
  const metrics = app.getAppMetrics();
  let workingSetKB = 0;
  let cpuPct = 0;
  const byType = {};
  for (const e of metrics) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    if (e.memory && typeof e.memory.workingSetSize === 'number') workingSetKB += e.memory.workingSetSize;
    if (e.cpu && typeof e.cpu.percentCPUUsage === 'number') cpuPct += e.cpu.percentCPUUsage;
  }
  return { procs: metrics.length, workingSetKB, cpuPct, byType };
}

async function main() {
  await app.whenReady();
  // Harness-lifetime guard: every window here is launcher-owned, so destroying the last
  // one would trigger Electron's default window-all-closed quit before teardown prints.
  app.on('window-all-closed', () => {});

  // Raised from the 150s convention to 240s: the declared item-wait budget alone is
  // 120s, plus up to N window starts and ~30s drain at teardown, so 150s could cut a
  // legitimate slow run. Still safely under the 260s launcher wait.
  const hardKill = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 240s budget exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 240000);
  if (hardKill.unref) hardKill.unref();

  const audits = [];
  const audit = (e) => {
    audits.push(e);
  };
  let launcher = null;
  let worker = null;

  try {
    fs.writeFileSync(PAGE_FILE, PAGE_HTML);
    console.log('NOTE FP_STRESS_N=' + N + ' -> ' + N + ' real profiles x ' + ITEMS_PER_PROFILE + ' = ' + N * ITEMS_PER_PROFILE + ' items, concurrency=' + CONCURRENCY);

    const createdWindows = [];
    launcher = createRichLauncher({
      audit,
      createWindow: (partition) => {
        const w = new BrowserWindow({
          width: 400,
          height: 300,
          show: false,
          webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: false },
        });
        createdWindows.push(w);
        void w.loadURL(PAGE_URL).catch(() => {}); // launcher waits did-finish-load; script goto is idempotent
        return w;
      },
    });

    const profiles = [];
    for (let n = 1; n <= N; n++) profiles.push({ id: 'stress-' + n });

    // 1) start N real windows (+ one attached session each)
    const tSetup = Date.now();
    const startFails = [];
    for (const p of profiles) {
      try {
        await launcher.start(p);
      } catch (e) {
        startFails.push(p.id + ':' + ((e && e.message) || e));
      }
    }
    const setupMs = Date.now() - tSetup;
    const started = launcher.list().length;
    if (started === N && startFails.length === 0) {
      ok('setup: launcher.start x' + N + ' -> ' + started + ' live windows in ' + setupMs + 'ms');
    } else {
      bad('setup: launcher.start x' + N, new Error('started=' + started + ' fails=' + JSON.stringify(startFails)));
    }

    // 2) shared execution stack: one script store, one executor, per-profile managers
    const store = createScriptStore({});
    const script = store.create({
      name: 'stress-ok',
      code: CODE,
      parameters: [{ name: 'url', type: 'string', required: true }],
    });
    const executor = createElectronExecutor({ launcher, audit, timeoutMs: 20000 });
    const managers = new Map();
    for (const p of profiles) {
      managers.set(
        p.id,
        createAutomationManager({
          store,
          runnerFactory: executor.for({ id: p.id }),
          audit,
          maxConcurrent: 50, // global cap is the worker's; per-profile work is serialized by worker skip
        })
      );
    }

    // concurrency accounting (wrapped execute)
    const activeGlobal = { count: 0, max: 0 };
    const perProfile = new Map();
    const heartbeats = [];
    const samples = [];

    const execute = async (item) => {
      const id = item.profileContext.id;
      let st = perProfile.get(id);
      if (!st) {
        st = { count: 0, max: 0 };
        perProfile.set(id, st);
      }
      st.count++;
      if (st.count > st.max) st.max = st.count;
      activeGlobal.count++;
      if (activeGlobal.count > activeGlobal.max) activeGlobal.max = activeGlobal.count;
      try {
        const rec = await managers.get(id).runScript(item.scriptId, {
          params: item.params,
          profileContext: item.profileContext,
        });
        if (!rec || rec.status !== 'SUCCESS') {
          const e = new Error('execution ' + (rec && rec.status) + (rec && rec.error ? ': ' + rec.error.message : ''));
          e.name = (rec && rec.error && rec.error.name) || 'ScriptError';
          throw e;
        }
        return { result: rec.result };
      } finally {
        st.count--;
        activeGlobal.count--;
      }
    };

    const queue = createTaskQueue({ audit });
    worker = createWorker({
      queue,
      execute,
      concurrency: CONCURRENCY,
      pollMs: 25,
      heartbeatMs: 250,
      taskTimeoutMs: 30000,
      audit,
      onHeartbeat: (h) => heartbeats.push(h),
    });

    const totalItems = N * ITEMS_PER_PROFILE;
    for (const p of profiles) {
      for (let i = 0; i < ITEMS_PER_PROFILE; i++) {
        queue.enqueue({
          scriptId: script.id,
          params: { url: PAGE_URL },
          profileContext: { id: p.id },
          maxAttempts: 1,
        });
      }
    }

    function recordSample(label) {
      const m = sampleMetrics();
      const row = { label, ...m, windows: launcher.list().length, active: activeGlobal.count };
      samples.push(row);
      return row;
    }

    const beforeRow = recordSample('BEFORE');
    let peak = beforeRow;
    const t0 = Date.now();
    worker.start();
    const deadline = t0 + ITEM_BUDGET_MS;
    for (;;) {
      const by = queue.stats().byStatus || {};
      let terminal = 0;
      for (const k of TERMINAL) terminal += by[k] || 0;
      const row = recordSample('run');
      row.terminal = terminal;
      if (row.procs > peak.procs || (row.procs === peak.procs && row.workingSetKB > peak.workingSetKB)) peak = row;
      if (terminal >= totalItems) break;
      if (Date.now() > deadline) break;
      await sleep(150);
    }
    const wallMs = Date.now() - t0;
    await worker.stop();

    const stats = queue.stats();
    const by = stats.byStatus || {};
    const success = by.SUCCESS || 0;
    const nonSuccess = totalItems - success;

    // a. zero loss
    if (success === totalItems) {
      ok('a. zero loss: ' + success + '/' + totalItems + ' items SUCCESS');
    } else {
      const fails = queue
        .list({ limit: totalItems })
        .filter((it) => it.status !== 'SUCCESS')
        .map((it) => it.status + ':' + (it.lastError ? it.lastError.name + '/' + it.lastError.message : '?'));
      bad('a. zero loss: ' + totalItems + ' items SUCCESS', new Error('success=' + success + ' nonSuccess=' + nonSuccess + ' ' + JSON.stringify(fails.slice(0, 8))));
    }

    // b. per-profile serialization
    let maxPer = 0;
    const violators = [];
    for (const [id, st] of perProfile) {
      if (st.max > maxPer) maxPer = st.max;
      if (st.max > 1) violators.push(id + '=' + st.max);
    }
    if (maxPer === 1 && perProfile.size === N) {
      ok('b. per-profile serialization held: maxActive=1 across ' + perProfile.size + ' profiles');
    } else {
      bad('b. per-profile serialization held', new Error('maxPer=' + maxPer + ' profiles=' + perProfile.size + ' violators=' + JSON.stringify(violators)));
    }

    // c. global parallelism
    if (activeGlobal.max <= CONCURRENCY) {
      ok('c. global parallelism peaked at ' + activeGlobal.max + ' (<= ' + CONCURRENCY + ')');
    } else {
      bad('c. global parallelism <= ' + CONCURRENCY, new Error('peak=' + activeGlobal.max));
    }

    // d. heartbeat
    const hbWithRunning = heartbeats.filter((h) => h.running > 0).length;
    if (heartbeats.length >= 1 && hbWithRunning >= 1) {
      ok('d. heartbeat observed ' + heartbeats.length + 'x (' + hbWithRunning + ' with running>0)');
    } else {
      bad('d. heartbeat observed', new Error('total=' + heartbeats.length + ' running>0=' + hbWithRunning));
    }

    // e. real windows at peak
    const maxWindows = samples.reduce((m, s) => Math.max(m, s.windows), 0);
    if (maxWindows === N && beforeRow.windows === N) {
      ok('e. ' + N + ' real windows alive at peak (before=' + beforeRow.windows + ')');
    } else {
      bad('e. ' + N + ' real windows alive at peak', new Error('max=' + maxWindows + ' before=' + beforeRow.windows + ' now=' + launcher.list().length));
    }

    // 3) teardown: stop every profile, then measure the floor
    const tTeardown = Date.now();
    for (const p of profiles) {
      try {
        await launcher.stop(p.id);
      } catch (_) {}
    }
    await sleep(1000);
    const afterRow = recordSample('AFTER');
    const teardownMs = Date.now() - tTeardown;

    // g. throughput
    const avgMs = totalItems > 0 ? wallMs / totalItems : 0;
    console.log('THROUGHPUT items=' + totalItems + ' wall=' + wallMs + 'ms avg=' + avgMs.toFixed(1) + 'ms/item profiles=' + N + ' concurrency=' + CONCURRENCY);
    console.log('TIMING setup=' + setupMs + 'ms run=' + wallMs + 'ms teardown=' + teardownMs + 'ms');

    // f. resource table (advisory numbers + two hard asserts)
    console.log('RESOURCE TABLE (app.getAppMetrics; workingSet=' + 'sum of process memory.workingSetSize)');
    console.log(pad('phase', 8) + pad('windows', 9) + pad('running', 9) + pad('procs', 7) + pad('workingSet', 15) + 'cpu%');
    for (const row of [beforeRow, peak, afterRow]) {
      console.log(
        pad(row === peak ? 'PEAK' : row.label, 8) +
          pad(row.windows, 9) +
          pad(row.active, 9) +
          pad(row.procs, 7) +
          pad((row.workingSetKB / 1024).toFixed(1) + ' MB', 15) +
          row.cpuPct.toFixed(1)
      );
    }
    console.log('PEAK byType=' + JSON.stringify(peak.byType));

    if (peak.procs >= peak.windows) {
      ok('f. peak procs (' + peak.procs + ') >= peak windows (' + peak.windows + ')');
    } else {
      bad('f. peak procs >= peak windows', new Error('procs=' + peak.procs + ' windows=' + peak.windows));
    }

    const remainingWindows = BrowserWindow.getAllWindows().length;
    const remainingList = launcher.list().length;
    if (remainingWindows === 0 && remainingList === 0) {
      ok('f. teardown: 0 BrowserWindows, launcher.list() empty');
    } else {
      bad('f. teardown: 0 windows + empty launcher', new Error('windows=' + remainingWindows + ' list=' + remainingList));
    }

    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await sleep(300); // let piped stdout flush before exit
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
  } finally {
    try {
      clearTimeout(hardKill);
    } catch (_) {}
    if (worker) {
      try {
        await worker.stop();
      } catch (_) {}
    }
    if (launcher) {
      for (const id of launcher.list()) {
        try {
          await launcher.stop(id);
        } catch (_) {}
      }
    }
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try {
      app.exit(process.exitCode);
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000);
  }
}

main();
