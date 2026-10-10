'use strict';
// Security test suite for the automation runtime (doc 09 §8.4 / doc 08 §15–§26).
// Every case runs the REAL runtime modules and states its precondition + what is
// asserted. PASS/FAIL/SKIP lines; exit 0 when all pass. No assertion is weakened to
// pass — anything needing a real Chromium partition uses the in-process browser-api
// scoping carrier with a fake session (stated in the case), never a fake PASS.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { builtinModules } = require('module');

const { createScriptRunner } = require('./runtime/script-runner');
const { createScriptStore } = require('./runtime/script-store');
const { createAutomationManager } = require('./runtime/automation-manager');
const { createIpcBridge, ALLOWED_CHANNELS, isSenderAllowed } = require('./runtime/ipc-bridge');
const { createHttpApi } = require('./runtime/http-api');
const { createBrowserApi } = require('./electron/browser-api');

let pass = 0;
let fail = 0;
let skip = 0;

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
function skipCase(name, reason) {
  skip++;
  console.log('SKIP ' + name + ' :: ' + reason);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a script through the real runner; returns the terminal record.
function run(runner, spec, params) {
  return runner.run(
    Object.assign({ id: 'sec', parameters: [], profileContext: { id: 'sec-prof' } }, spec),
    params || {},
    {}
  );
}

// A fake page/session pair for the cross-profile scoping carrier (case 6).
function fakeProfile(id) {
  const session = {
    cookies: {
      get: async () => [{ name: 'session', value: id }],
      set: async () => {},
      remove: async () => {},
    },
    clearStorageData: async () => {},
  };
  const page = {
    storageGet: async (k) => (k === 'token' ? id + '-storage' : null),
    storageSet: async () => {},
  };
  return createBrowserApi({ page, electronSession: session, profileContext: { id }, fences: { dirs: [os.tmpdir()] } });
}

(async () => {
  // ==========================================================================
  // 1. 未授权浏览器控制 — permissions.browser:false must deny, not silently pass.
  // ==========================================================================
  await t('SEC1 unauthorized browser control: browser:false -> browser.goto throws PermissionError', async () => {
    const api = fakeProfile('A'); // real browserApi so the deny is the capability gate, not "no api"
    const runner = createScriptRunner({ browserApi: api, timeoutMs: 3000 });
    const rec = await run(runner, { code: "return await browser.goto('https://example.com');", permissions: { browser: false } });
    assert(rec.status === 'FAILED', 'status=' + rec.status + ' (silent success is the bug)');
    assert(rec.error && rec.error.name === 'PermissionError', 'error=' + JSON.stringify(rec.error));
    assert(rec.result === undefined, 'result must not be produced');
  });

  // ==========================================================================
  // 2. 越权文件访问 — filesystem deny-proxy + upload/download fence.
  // ==========================================================================
  await t('SEC3 filesystem:false -> access throws PermissionError (deny-proxy)', async () => {
    const runner = createScriptRunner({ browserApi: undefined, timeoutMs: 3000 });
    const rec = await run(runner, { code: "return filesystem.readFileSync('/etc/passwd');", permissions: { filesystem: false } });
    assert(rec.status === 'FAILED', 'status=' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error=' + JSON.stringify(rec.error));
  });

  await t('SEC3 filesystem permission ON but UNTRUSTED -> still deny-proxy', async () => {
    const runner = createScriptRunner({ browserApi: undefined, timeoutMs: 3000 });
    const rec = await run(runner, { code: 'return filesystem.read("/x");', permissions: { filesystem: true }, trusted: false });
    assert(rec.status === 'FAILED', 'status=' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error=' + JSON.stringify(rec.error));
  });

  await t('SEC3 upload/download fence: path outside authorized dir -> PermissionError; no fence -> deny', async () => {
    const fenced = createBrowserApi({ page: {}, electronSession: null, profileContext: { id: 'p' }, fences: { dirs: [os.tmpdir()] } });
    const outside = path.join(os.tmpdir(), '..', '..', 'evil-' + Date.now() + '.txt');
    let upErr = null;
    try {
      await fenced.upload.setFiles('#file', [outside]);
    } catch (e) {
      upErr = e;
    }
    assert(upErr && upErr.name === 'PermissionError' && upErr.code === 'PERMISSION' && upErr.retriable === false, 'upload fence: ' + JSON.stringify(upErr && upErr.message));
    let dlErr = null;
    try {
      await fenced.download.save({ trigger: async () => {} }, outside);
    } catch (e) {
      dlErr = e;
    }
    assert(dlErr && dlErr.name === 'PermissionError', 'download fence: ' + JSON.stringify(dlErr && dlErr.message));
    // fail-closed: no authorized dir at all => deny even for a benign name
    const unfenced = createBrowserApi({ page: {}, electronSession: null, profileContext: { id: 'p' } });
    let noFence = null;
    try {
      await unfenced.upload.setFiles('#file', ['benign.txt']);
    } catch (e) {
      noFence = e;
    }
    assert(noFence && noFence.name === 'PermissionError', 'no-fence must deny: ' + JSON.stringify(noFence && noFence.message));
  });

  // ==========================================================================
  // 3. 未授权子进程 — process denied; require/child_process unreachable.
  // ==========================================================================
  await t('SEC4 process:false -> deny-proxy; require/child_process unreachable from sandbox', async () => {
    const runner = createScriptRunner({ browserApi: undefined, timeoutMs: 3000 });
    const code = [
      'const out = {};',
      "out.req = typeof require;",
      "out.child = typeof child_process;",
      'try { process.spawn("cmd"); out.spawn = "REACHED"; } catch (e) { out.spawn = e.name; }',
      'return out;',
    ].join('\n');
    const rec = await run(runner, { code, permissions: { process: false } });
    assert(rec.status === 'SUCCESS', 'status=' + rec.status + ' err=' + JSON.stringify(rec.error));
    assert(rec.result.req === 'undefined', 'require reachable: ' + rec.result.req);
    assert(rec.result.child === 'undefined', 'child_process reachable: ' + rec.result.child);
    assert(rec.result.spawn === 'PermissionError', 'process.spawn not denied: ' + rec.result.spawn);
  });

  await t('SEC4 process permission ON but UNTRUSTED -> still deny-proxy', async () => {
    const runner = createScriptRunner({ browserApi: undefined, timeoutMs: 3000 });
    const rec = await run(runner, { code: 'process.exec("whoami");', permissions: { process: true }, trusted: false });
    assert(rec.status === 'FAILED', 'status=' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error=' + JSON.stringify(rec.error));
  });

  // ==========================================================================
  // 4. 恶意脚本（沙箱遏制）— no host globals; constructor-chain escape blocked;
  //    prototype pollution contained to the vm.
  // ==========================================================================
  await t('SEC5 sandbox exposes no host globals; eval/new Function/ctor-chain escape blocked', async () => {
    const runner = createScriptRunner({ browserApi: undefined, timeoutMs: 3000 });
    const code = [
      'const o = {};',
      'o.require = typeof require;',
      'o.buffer = typeof Buffer;',
      'o.global = typeof global;',
      'o.module = typeof module;',
      'try { process.versions.node; o.hostProcess = "REACHED"; } catch (e) { o.hostProcess = e.name; }',
      'try { eval("1+1"); o.eval = "REACHED"; } catch (e) { o.eval = e.name; }',
      'try { new Function("return 1")(); o.fn = "REACHED"; } catch (e) { o.fn = e.name; }',
      "try { o.ctor = ({constructor: Object}).constructor.constructor('return typeof require')(); } catch (e) { o.ctor = 'BLOCKED:' + e.name; }",
      'return o;',
    ].join('\n');
    const rec = await run(runner, { code, permissions: {} });
    assert(rec.status === 'SUCCESS', 'status=' + rec.status + ' err=' + JSON.stringify(rec.error));
    const o = rec.result;
    assert(o.require === 'undefined', 'require: ' + o.require);
    assert(o.buffer === 'undefined', 'Buffer: ' + o.buffer);
    assert(o.global === 'undefined', 'global: ' + o.global);
    assert(o.module === 'undefined', 'module: ' + o.module);
    assert(o.hostProcess === 'PermissionError', 'host process reachable: ' + o.hostProcess);
    assert(o.eval === 'EvalError', 'eval not blocked: ' + o.eval);
    assert(o.fn === 'EvalError', 'new Function not blocked: ' + o.fn);
    assert(o.ctor === 'BLOCKED:EvalError', 'ctor-chain escape not blocked: ' + o.ctor);
  });

  await t('SEC5 prototype pollution is contained to the vm context (host Object untouched)', async () => {
    const runner = createScriptRunner({ browserApi: undefined, timeoutMs: 3000 });
    const code = "Object.prototype.__sec_evil__ = 'pwn'; return ({})['__sec_evil__'];";
    const rec = await run(runner, { code, permissions: {} });
    assert(rec.status === 'SUCCESS', 'status=' + rec.status);
    assert(rec.result === 'pwn', 'script did not pollute its own vm: ' + rec.result);
    // The host process must be unaffected (vm has its own Object.prototype).
    assert(({})['__sec_evil__'] === undefined, 'HOST Object.prototype was polluted');
  });

  // ==========================================================================
  // 5. secret 泄露 — secret param value redacted from logs + error.
  // ==========================================================================
  await t('SEC6 secret param value is redacted in logs and error (never raw)', async () => {
    const RAW = 'super-secret-value-9f3a';
    const runner = createScriptRunner({ browserApi: undefined, timeoutMs: 3000 });
    const spec = {
      code: "console.log('tok=' + params.token); throw new Error('leak ' + params.token);",
      permissions: {},
      parameters: [{ name: 'token', type: 'secret', required: true }],
    };
    const rec = await run(runner, spec, { token: RAW });
    assert(rec.status === 'FAILED', 'status=' + rec.status);
    const logsDump = JSON.stringify(rec.logs);
    assert(!logsDump.includes(RAW), 'raw secret leaked into logs: ' + logsDump.slice(0, 200));
    assert(logsDump.includes('***'), 'secret was not redacted (no *** in logs)');
    const errDump = JSON.stringify(rec.error);
    assert(!errDump.includes(RAW), 'raw secret leaked into error: ' + errDump.slice(0, 200));
  });

  // ==========================================================================
  // 6. 跨 profile 隔离 — a script bound to profile A can only read A's data.
  //    Uses the in-process browser-api scoping carrier (injected session/page);
  //    real Chromium partitions are the same carrier, just provided by Electron.
  // ==========================================================================
  await t('SEC2 cross-profile: A-bound script reads only A cookies/storage; context.profile=A', async () => {
    const apiA = fakeProfile('A');
    const apiB = fakeProfile('B');
    const code = [
      "const c = await cookies.get({});",
      "const s = await storage.get('token');",
      'return { cookie: c && c[0] ? c[0].value : null, storage: s, pid: context.profile.id };',
    ].join('\n');
    const spec = { code, permissions: { cookies: true, storage: true }, profileContext: { id: 'A' } };
    const recA = await createScriptRunner({ browserApi: apiA, timeoutMs: 3000 }).run(spec, {}, {});
    assert(recA.status === 'SUCCESS', 'A status=' + recA.status + ' ' + JSON.stringify(recA.error));
    assert(recA.profileId === 'A', 'record.profileId=' + recA.profileId);
    assert(recA.result.pid === 'A', 'context.profile.id=' + recA.result.pid);
    assert(recA.result.cookie === 'A' && recA.result.storage === 'A-storage', 'A data=' + JSON.stringify(recA.result));

    const recB = await createScriptRunner({ browserApi: apiB, timeoutMs: 3000 }).run(
      { code, permissions: { cookies: true, storage: true }, profileContext: { id: 'B' } },
      {},
      {}
    );
    assert(recB.result.cookie === 'B' && recB.result.storage === 'B-storage', 'B data=' + JSON.stringify(recB.result));
    // A's carrier can never surface B's values (distinct injected session/page).
    assert(recA.result.cookie !== recB.result.cookie && recA.result.storage !== recB.result.storage, 'profiles shared data');
  });

  // ==========================================================================
  // 7. IPC 绕过 — sender gate, channel allowlist, unknown channel refused.
  // ==========================================================================
  await t('SEC7 IPC sender gate: webview/wrong-URL/forged sender rejected', async () => {
    const rules = [{ urlPrefix: 'file://' }];
    const good = { getType: () => 'window', getURL: () => 'file://app/index.html' };
    assert(isSenderAllowed(good, rules) === true, 'good sender rejected');
    assert(isSenderAllowed({ getType: () => 'webview', getURL: () => 'file://app/index.html' }, rules) === false, 'webview allowed');
    assert(isSenderAllowed({ getType: () => 'window', getURL: () => 'https://evil.example/' }, rules) === false, 'foreign URL allowed');
    assert(isSenderAllowed({ getType: () => 'window' }, rules) === false, 'sender without getURL allowed');
    assert(isSenderAllowed(good) === true, 'default rules should allow file://');

    const bridge = createIpcBridge({ service: { status: () => ({ ok: true, data: { service: 'automation' } }) }, allowedSenders: rules });
    const denied = await bridge.handle('automation:status', { sender: { getType: () => 'window', getURL: () => 'https://evil.example/' } });
    assert(denied.ok === false && denied.error.code === 'DENY', 'forged sender not denied: ' + JSON.stringify(denied));
    const okRes = await bridge.handle('automation:status', { sender: good });
    assert(okRes.ok === true, 'good sender denied: ' + JSON.stringify(okRes));
  });

  await t('SEC7 IPC channel allowlist is 54; unknown channel refused; register() rejects unknown', async () => {
    assert(ALLOWED_CHANNELS.length === 54, 'allowlist size=' + ALLOWED_CHANNELS.length);
    assert(new Set(ALLOWED_CHANNELS).size === ALLOWED_CHANNELS.length, 'allowlist has duplicates');
    const bridge = createIpcBridge({ service: { status: () => ({ ok: true, data: {} }) } });
    const unknown = await bridge.handle('automation:definitely:not:allowed', { sender: { getType: () => 'window', getURL: () => 'file://x' } });
    assert(unknown.ok === false && unknown.error.code === 'DENY', 'unknown channel not refused: ' + JSON.stringify(unknown));
    let threw = false;
    try {
      bridge.register({ handle: () => {} }, ['automation:nope']);
    } catch (_) {
      threw = true;
    }
    assert(threw, 'register() accepted an unknown channel');
  });

  await t('SEC1 HTTP gateway: bad Host -> 403, no token -> 401, good token -> 200', async () => {
    const api = createHttpApi({ service: { status: () => ({ ok: true, data: { service: 'automation' } }) }, token: 'sec-token', audit: () => {}, rateLimit: { max: 1000, windowMs: 60000 } });
    const srv = await api.start();
    const req = (headers) =>
      new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/automation/status', headers }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        r.on('error', reject);
        r.end();
      });
    try {
      const noTok = await req({});
      assert(noTok.status === 401, 'no token: ' + noTok.status);
      const badHost = await req({ Authorization: 'Bearer sec-token', Host: 'evil.example' });
      assert(badHost.status === 403, 'bad host: ' + badHost.status);
      const ok = await req({ Authorization: 'Bearer sec-token' });
      assert(ok.status === 200, 'good token: ' + ok.status);
    } finally {
      await srv.close();
    }
  });

  // ==========================================================================
  // 8. 供应链/依赖 — automation/runtime/** + sdk/** require ONLY node builtins.
  // ==========================================================================
  await t('SEC8 dependency surface: automation/runtime + sdk require only node builtins', async () => {
    const builtins = new Set(builtinModules.concat(builtinModules.map((m) => 'node:' + m)));
    const repoRoot = path.join(__dirname, '..');
    const roots = [path.join(repoRoot, 'automation', 'runtime'), path.join(repoRoot, 'sdk')];
    const bad = [];
    let scanned = 0;
    // comment/string-aware extractor so a `require('electron')` mentioned in prose is
    // not a false positive, and a real bare specifier in code is not a false negative.
    function extractRequires(src) {
      const out = [];
      let i = 0;
      const n = src.length;
      while (i < n) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
        if (c === "'" || c === '"') { const q = c; i++; while (i < n) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; } continue; }
        if (c === '`') { i++; while (i < n) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === '`') { i++; break; } i++; } continue; }
        if (c === 'r' && src.startsWith('require', i) && (i === 0 || !/[A-Za-z0-9_$]/.test(src[i - 1]))) {
          let j = i + 7;
          while (j < n && /\s/.test(src[j])) j++;
          if (src[j] === '(') {
            j++;
            while (j < n && /\s/.test(src[j])) j++;
            const q = src[j];
            if (q === "'" || q === '"') {
              j++;
              let spec = '';
              while (j < n && src[j] !== q) { if (src[j] === '\\') j++; spec += src[j]; j++; }
              out.push(spec);
              i = j + 1;
              continue;
            }
          }
        }
        i++;
      }
      return out;
    }
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          scanned++;
          for (const spec of extractRequires(fs.readFileSync(p, 'utf8'))) {
            if (spec.startsWith('.') || spec.startsWith('/')) continue;
            if (!builtins.has(spec)) bad.push(path.relative(repoRoot, p) + ' -> ' + spec);
          }
        }
      }
    }
    for (const r of roots) if (fs.existsSync(r)) walk(r);
    assert(scanned > 0, 'scanned zero files');
    assert(bad.length === 0, 'non-builtin bare requires: ' + bad.join(' | '));
  });

  // ==========================================================================
  // 9. 强制终止 — cancel a runaway, and per-run timeout.
  // ==========================================================================
  await t('SEC9 runaway script: runScriptCancellable + cancel -> CANCELLED', async () => {
    const store = createScriptStore({});
    const script = store.create({ name: 'hang', code: 'await new Promise(() => {});', permissions: { browser: false } });
    const manager = createAutomationManager({ store, runnerFactory: () => createScriptRunner({ browserApi: undefined, timeoutMs: 30000 }), audit: () => {} });
    const h = manager.runScriptCancellable(script.id, { profileContext: { id: 'p' } });
    await sleep(60);
    assert(manager.cancel(h.executionId) === true, 'cancel not accepted');
    const rec = await h.promise;
    assert(rec.status === 'CANCELLED', 'status=' + rec.status);
    assert(rec.error && rec.error.name === 'CancelledError', 'error=' + JSON.stringify(rec.error));
  });

  await t('SEC9 runaway script: short timeoutMs -> TIMEOUT (TimeoutError)', async () => {
    const store = createScriptStore({});
    const script = store.create({ name: 'hang2', code: 'await new Promise(() => {});', permissions: { browser: false } });
    const manager = createAutomationManager({ store, runnerFactory: () => createScriptRunner({ browserApi: undefined, timeoutMs: 250 }), audit: () => {} });
    const rec = await manager.runScript(script.id, { profileContext: { id: 'p' } });
    assert(rec.status === 'TIMEOUT', 'status=' + rec.status);
    assert(rec.error && rec.error.name === 'TimeoutError', 'error=' + JSON.stringify(rec.error));
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
