'use strict';

const { createScriptRunner, listErrors } = require('./runtime/script-runner');

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

function makeApi() {
  const calls = [];
  return {
    calls,
    browserApi: {
      browser: {
        goto: async (u) => {
          calls.push('goto ' + u);
        },
        screenshot: async () => Buffer.from('png'),
      },
      page: { evaluate: async () => 42 },
    },
  };
}

function spec(over) {
  return Object.assign(
    {
      id: 's1',
      name: 'test-script',
      version: '1.0.0',
      code: '',
      parameters: [],
      permissions: { browser: true },
      profileContext: {
        id: 'p1',
        name: 'P1',
        groupId: null,
        proxy: null,
        platform: 'win32',
        browserVersion: '1.0',
        fingerprint: {},
        sessionId: 'sess1',
      },
    },
    over
  );
}

async function main() {
  const audits = [];
  const audit = (row) => audits.push(row);
  const { calls, browserApi } = makeApi();
  const runner = createScriptRunner({ browserApi, audit });

  await check('happy path: SUCCESS, step, logs, params, duration', async () => {
    const rec = await runner.run(
      spec({ code: "step('go'); await browser.goto('https://x'); return params.account;" }),
      { account: 'acc-1' }
    );
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.currentStep === 'go', 'currentStep: ' + rec.currentStep);
    assert(rec.result === 'acc-1', 'result: ' + rec.result);
    assert(rec.durationMs > 0, 'durationMs: ' + rec.durationMs);
    assert(rec.endTime !== null && rec.error === null, 'endTime/error');
    const dump = JSON.stringify(rec.logs);
    assert(dump.includes('goto') && dump.includes('https://x'), 'logs missing goto: ' + dump);
    assert(calls.includes('goto https://x'), 'mock not called: ' + JSON.stringify(calls));
    assert(rec.scriptId === 's1' && rec.scriptVersion === '1.0.0' && rec.profileId === 'p1', 'record ids');
    assert(audits.some((a) => a.type === 'script-exec' && a.status === 'SUCCESS'), 'audit script-exec');
  });

  await check('listErrors returns 9 taxonomy names', () => {
    const names = listErrors();
    assert(names.length === 9, 'len: ' + names.length);
    assert(names.includes('PermissionError') && names.includes('TimeoutError') && names.includes('UploadError'), names.join(','));
  });

  await check('permissions.browser false → browser proxy throws PermissionError, FAILED', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "await browser.goto('https://x');", permissions: { browser: false } }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('permissions.browser false → page proxy throws PermissionError', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "await page.evaluate('1');", permissions: { browser: false } }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('browserApi missing while permissions.browser true → ScriptError', async () => {
    const r = createScriptRunner({ audit });
    const rec = await r.run(spec({ code: 'return 1;' }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'ScriptError', 'error: ' + JSON.stringify(rec.error));
    assert(rec.error.message.includes('browserApi is required'), 'msg: ' + rec.error.message);
  });

  await check('browser:true exposes page (same group)', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: 'return typeof page.evaluate;' }));
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.result === 'function', 'result: ' + rec.result);
  });

  await check('filesystem false/absent → filesystem get throws PermissionError', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "return filesystem.readFile('/x');", permissions: { browser: true } }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('filesystem:true without trusted → still PermissionError (gate)', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "return filesystem.readFile('/x');", permissions: { browser: true, filesystem: true } }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('process:true without trusted → still PermissionError (gate)', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "return process.exit(0);", permissions: { browser: true, process: true } }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'PermissionError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('filesystem:true + trusted:true + fs api injected → gate open, works', async () => {
    const api = {
      browser: browserApi.browser,
      page: browserApi.page,
      filesystem: { readFile: async (p) => 'data:' + p },
    };
    const r = createScriptRunner({ browserApi: api, audit });
    const rec = await r.run(spec({ code: "return await filesystem.readFile('/f');", permissions: { browser: true, filesystem: true }, trusted: true }));
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.result === 'data:/f', 'result: ' + rec.result);
  });

  await check('filesystem:true + trusted:true but no fs api → gate open, fails cleanly (not PermissionError)', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "return filesystem.readFile('/f');", permissions: { browser: true, filesystem: true }, trusted: true }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name !== 'PermissionError', 'gate should be open: ' + JSON.stringify(rec.error));
    assert(rec.error && /readFile/.test(rec.error.message), 'msg: ' + (rec.error && rec.error.message));
  });

  await check('T3 wash: __proto__ param key dies, host Object.prototype untouched', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const evil = {};
    evil.__proto__ = { polluted: 1 }; // eslint-disable-line no-proto
    const rec = await r.run(
      spec({ code: 'return ({}).polluted === undefined && params.safe === 1;', permissions: { browser: true } }),
      Object.assign({ safe: 1 }, JSON.parse('{"__proto__":{"polluted":1}}'))
    );
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.result === true, 'vm host prototype clean + safe param intact');
    assert(({}).polluted === undefined, 'host polluted!');
  });

  await check('secret params scrubbed from logs + error.message, values intact for script', async () => {
    const secSpec = spec({
      code: "console.log('pw is ' + params.pw); throw new Error('leak ' + params.pw);",
      permissions: { browser: true },
      parameters: [{ name: 'pw', type: 'secret', required: true }],
    });
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(secSpec, { pw: 'hunter2-secret' });
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    const dump = JSON.stringify(rec.logs) + ' ' + JSON.stringify(rec.error);
    assert(!dump.includes('hunter2-secret'), 'secret leaked: ' + dump);
    assert(dump.includes('***'), 'scrub marker missing: ' + dump);
    // values intact inside the script: return the secret, compare outside
    const r2 = createScriptRunner({ browserApi, audit });
    const rec2 = await r2.run(
      spec({ code: 'return params.pw;', permissions: { browser: true }, parameters: [{ name: 'pw', type: 'secret', required: true }] }),
      { pw: 'hunter2-secret' }
    );
    assert(rec2.status === 'SUCCESS' && rec2.result === 'hunter2-secret', 'value must reach script: ' + JSON.stringify(rec2));
  });

  await check('trustResolver wired: store trust wins, spec.trusted ignored', async () => {
    const api = { browser: browserApi.browser, page: browserApi.page, filesystem: { readFile: async (p) => 'data:' + p } };
    // store says trusted, spec omits the flag -> gate opens
    const r1 = createScriptRunner({ browserApi: api, audit, trustResolver: async () => true });
    const ok = await r1.run(spec({ id: 's-trust', code: "return await filesystem.readFile('/f');", permissions: { browser: true, filesystem: true } }));
    assert(ok.status === 'SUCCESS', 'resolver trust opens gate: ' + ok.status + ' ' + JSON.stringify(ok.error));
    // store says untrusted even though spec claims trusted:true -> gate stays shut
    const r2 = createScriptRunner({ browserApi: api, audit, trustResolver: async () => false });
    const denied = await r2.run(spec({ id: 's-trust', code: "return filesystem.readFile('/f');", permissions: { browser: true, filesystem: true }, trusted: true }));
    assert(denied.status === 'FAILED', 'status: ' + denied.status);
    assert(denied.error && denied.error.name === 'PermissionError', 'spec.trusted must not override store: ' + JSON.stringify(denied.error));
    // resolver throws -> fail-closed (deny, never open)
    const r3 = createScriptRunner({ browserApi: api, audit, trustResolver: async () => { throw new Error('store down'); } });
    const closed = await r3.run(spec({ id: 's-trust', code: "return filesystem.readFile('/f');", permissions: { browser: true, filesystem: true }, trusted: true }));
    assert(closed.status === 'FAILED', 'status: ' + closed.status);
    assert(closed.error && closed.error.name === 'PermissionError', 'resolver failure must deny: ' + JSON.stringify(closed.error));
  });

  await check('timeout: hanging await → TIMEOUT + TimeoutError', async () => {
    const r = createScriptRunner({ browserApi, audit, timeoutMs: 200 });
    const t0 = Date.now();
    const rec = await r.run(spec({ code: 'await new Promise(() => {});' }));
    assert(rec.status === 'TIMEOUT', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.error && rec.error.name === 'TimeoutError', 'error: ' + JSON.stringify(rec.error));
    assert(Date.now() - t0 < 5000, 'took too long');
  });

  await check('syntax error in code → ScriptError, FAILED', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: 'const = broken;' }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'ScriptError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('explicit throw ProfileError → error.name ProfileError', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "throw new ProfileError('nope');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'ProfileError', 'error: ' + JSON.stringify(rec.error));
    assert(rec.error.message === 'nope', 'msg: ' + rec.error.message);
  });

  await check('vm escape: process is deny-proxy (not host), require undefined', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(
      spec({
        code:
          "const req = typeof require; let p; try { process.exit; p = 'LEAK'; } catch (e) { p = 'blocked:' + e.name; } let hp; try { globalThis.process.pid; hp = 'LEAK'; } catch (e) { hp = 'blocked:' + e.name; } return req + '|' + p + '|' + hp;",
      })
    );
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.result === 'undefined|blocked:PermissionError|blocked:PermissionError', 'result: ' + rec.result);
  });

  await check('vm escape: Function constructor codegen blocked', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(
      spec({
        code:
          "try { const F = (function () {}).constructor; F('return process')(); return 'ESCAPED'; } catch (e) { return 'blocked'; }",
      })
    );
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.result === 'blocked', 'result: ' + rec.result);
  });

  await check('console.log captured → logs level info', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const rec = await r.run(spec({ code: "console.log('hi');" }));
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status);
    const entry = rec.logs.find((l) => l.level === 'info' && Array.isArray(l.args) && l.args.includes('hi'));
    assert(entry, 'missing hi log: ' + JSON.stringify(rec.logs));
    assert(typeof entry.ts === 'number', 'ts missing');
  });

  await check('cancel pre-start → CANCELLED, script not executed', async () => {
    const r = createScriptRunner({ browserApi, audit });
    r.cancel();
    const before = calls.length;
    const rec = await r.run(spec({ code: "await browser.goto('https://never');" }));
    assert(rec.status === 'CANCELLED', 'status: ' + rec.status);
    assert(calls.length === before, 'script ran despite cancel');
    assert(audits.some((a) => a.type === 'script-exec' && a.status === 'CANCELLED'), 'audit CANCELLED');
  });

  await check('abort signal pre-start → CANCELLED, script not executed', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const c = new AbortController();
    c.abort();
    const before = calls.length;
    const rec = await r.run(spec({ code: "await browser.goto('https://never-signal');" }), {}, { signal: c.signal });
    assert(rec.status === 'CANCELLED', 'status: ' + rec.status);
    assert(rec.error && rec.error.name === 'CancelledError', 'error: ' + JSON.stringify(rec.error));
    assert(calls.length === before, 'script ran despite aborted signal');
    assert(audits.some((a) => a.type === 'script-exec' && a.status === 'CANCELLED'), 'audit CANCELLED');
  });

  await check('abort mid-hang → CANCELLED (timeoutMs large, abort wins)', async () => {
    const r = createScriptRunner({ browserApi, audit, timeoutMs: 30000 });
    const c = new AbortController();
    const pr = r.run(spec({ code: 'await new Promise(() => {});' }), {}, { signal: c.signal });
    setTimeout(() => c.abort(), 50);
    const rec = await pr;
    assert(rec.status === 'CANCELLED', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.error && rec.error.name === 'CancelledError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('no-signal hang still TIMEOUT (control)', async () => {
    const r = createScriptRunner({ browserApi, audit, timeoutMs: 200 });
    const rec = await r.run(spec({ code: 'await new Promise(() => {});' }));
    assert(rec.status === 'TIMEOUT', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.error && rec.error.name === 'TimeoutError', 'error: ' + JSON.stringify(rec.error));
  });

  await check('step boundary aborts cooperatively → CANCELLED', async () => {
    const c = new AbortController();
    const api = { browser: { goto: async () => c.abort() }, page: browserApi.page };
    const r = createScriptRunner({ browserApi: api, audit });
    const rec = await r.run(
      spec({ code: "step('a'); await browser.goto('x'); step('b'); return 'done';" }),
      {},
      { signal: c.signal }
    );
    assert(rec.status === 'CANCELLED', 'status: ' + rec.status + ' err: ' + JSON.stringify(rec.error));
    assert(rec.error && rec.error.name === 'CancelledError', 'error: ' + JSON.stringify(rec.error));
    assert(rec.currentStep === 'a', 'currentStep should stick at a: ' + rec.currentStep);
  });

  await check('FAILED captures screenshot artifact (bytes); SUCCESS leaves artifacts empty', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const bad = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(bad.status === 'FAILED', 'status: ' + bad.status);
    assert(Array.isArray(bad.artifacts) && bad.artifacts.length === 1, 'one artifact: ' + JSON.stringify(bad.artifacts));
    assert(bad.artifacts[0].kind === 'screenshot' && bad.artifacts[0].bytes === 3, 'bytes: ' + JSON.stringify(bad.artifacts[0]));
    const good = await r.run(spec({ code: 'return 1;' }));
    assert(good.status === 'SUCCESS', 'status: ' + good.status);
    assert(Array.isArray(good.artifacts) && good.artifacts.length === 0, 'empty on success');
  });

  await check('screenshot throw lands as error artifact, never fails record', async () => {
    const api = { browser: { screenshot: async () => { throw new Error('no page'); } } };
    const r = createScriptRunner({ browserApi: api, audit });
    const rec = await r.run(spec({ code: "throw new Error('x');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.artifacts.length === 1 && rec.artifacts[0].error === 'no page', 'error artifact: ' + JSON.stringify(rec.artifacts));
  });

  await check('no screenshot fn -> artifacts empty, record still FAILED', async () => {
    const r = createScriptRunner({ browserApi: { browser: {} }, audit });
    const rec = await r.run(spec({ code: "throw new Error('x');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(Array.isArray(rec.artifacts) && rec.artifacts.length === 0, 'empty');
  });

  await check('onLog streams console lines live; throwing onLog never breaks run', async () => {
    const r = createScriptRunner({ browserApi, audit });
    const seen = [];
    const rec = await r.run(spec({ code: "console.log('hi');" }), {}, { onLog: (l) => seen.push(l) });
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status);
    assert(seen.length === 1 && seen[0].level === 'info' && seen[0].args.includes('hi'), 'live line: ' + JSON.stringify(seen));
    assert(typeof seen[0].ts === 'number', 'ts missing');
    const rec2 = await r.run(spec({ code: "console.log('x'); return 1;" }), {}, { onLog: () => { throw new Error('dead listener'); } });
    assert(rec2.status === 'SUCCESS' && rec2.result === 1, 'throwing onLog broke run: ' + rec2.status);
  });

  await check('forensics: failure yields trace with html + network + url', async () => {
    const api = {
      browser: { screenshot: async () => Buffer.from('png') },
      page: { evaluate: async () => '<html><body>E2E</body></html>', getCurrentUrl: async () => 'file:///x.html' },
      network: { recent: () => [{ url: 'file:///x.html', ts: 1 }] },
    };
    const r = createScriptRunner({ browserApi: api, audit });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.trace && rec.trace.sources.html && rec.trace.sources.network && rec.trace.sources.url, 'sources: ' + JSON.stringify(rec.trace && rec.trace.sources));
    assert(rec.trace.html === '<html><body>E2E</body></html>', 'html: ' + rec.trace.html);
    assert(rec.trace.url === 'file:///x.html', 'url: ' + rec.trace.url);
    assert(rec.trace.network.length === 1, 'network: ' + JSON.stringify(rec.trace.network));
    assert(rec.trace.ts && rec.artifacts.length === 1, 'ts/artifacts');
  });

  await check('forensics: missing APIs → FAILED, trace.sources all false, zero throw', async () => {
    const r = createScriptRunner({ browserApi: { browser: { screenshot: async () => Buffer.from('x') } }, audit });
    const rec = await r.run(spec({ code: "throw new Error('x');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.trace && rec.trace.sources.html === false && rec.trace.sources.network === false && rec.trace.sources.url === false, 'sources: ' + JSON.stringify(rec.trace && rec.trace.sources));
    assert(rec.trace.html === undefined, 'html should be omitted: ' + JSON.stringify(rec.trace.html));
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + e.message);
  process.exit(1);
});
