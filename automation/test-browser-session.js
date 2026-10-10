'use strict';

const { createBrowserSession } = require('./runtime/browser-session');

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

async function assertRejects(p, msgPart) {
  let threw = false;
  let msg = '';
  try {
    await p;
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  assert(threw, 'expected rejection');
  if (msgPart) assert(msg.includes(msgPart), 'wrong error: ' + msg);
  return msg;
}

function makeWc() {
  return {
    debugger: {
      _attached: false,
      _createCalls: 0,
      _lastEvalParams: null,
      attach(v) {
        this._attached = true;
        return Promise.resolve();
      },
      detach() {
        this._attached = false;
        return Promise.resolve();
      },
      sendCommand(m, p) {
        if (m === 'Page.createIsolatedWorld') {
          this._createCalls++;
          return Promise.resolve({ executionContextId: 7 });
        }
        if (m === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'F1' } } });
        if (m === 'Runtime.evaluate' || m === 'Runtime.callFunctionOn') {
          this._lastEvalParams = p;
          return Promise.resolve({ ok: true });
        }
        if (m === 'Page.navigate') return Promise.resolve({ frameId: 'f1' });
        return Promise.resolve({ ok: true });
      },
      on(ev, cb) {
        (this._h = this._h || {})[ev] = cb;
      },
    },
  };
}

function makeWcStale(config = {}) {
  const wc = makeWc();
  const d = wc.debugger;
  const origSend = d.sendCommand.bind(d);
  d._evalCalls = 0;
  d._evalParamsLog = [];
  d.config = Object.assign({ failFirstWith: null }, config);
  d.sendCommand = (m, p) => {
    if (m === 'Page.createIsolatedWorld') {
      d._createCalls++;
      return Promise.resolve({ executionContextId: 7 + d._createCalls }); // 8, 9, ...
    }
    if (m === 'Runtime.evaluate' || m === 'Runtime.callFunctionOn') {
      d._evalCalls++;
      d._evalParamsLog.push(p);
      if (d.config.failFirstWith !== null && d._evalCalls === 1) {
        return Promise.reject(new Error(d.config.failFirstWith));
      }
      return Promise.resolve({ ok: true, eval: d._evalCalls });
    }
    return origSend(m, p);
  };
  return wc;
}

async function main() {
  const audits = [];
  const audit = (row) => audits.push(row);
  const wc = makeWc();
  const s = createBrowserSession({ webContents: wc, audit });

  await check('full path markReady→attach→sendCommand Page.navigate resolves', async () => {
    s.markReady();
    assert(s.getState() === 'ready', 'state after markReady: ' + s.getState());
    await s.attach();
    assert(s.getState() === 'attached', 'state after attach: ' + s.getState());
    const reply = await s.sendCommand('Page.navigate', { url: 'https://example.com' });
    assert(reply.frameId === 'f1', 'reply: ' + JSON.stringify(reply));
    assert(wc.debugger._attached === true, 'debugger attached');
  });

  await check('sendCommand before attach rejects not attached', async () => {
    const s2 = createBrowserSession({ webContents: makeWc(), audit });
    s2.markReady();
    await assertRejects(s2.sendCommand('Page.navigate', { url: 'x' }), 'not attached');
  });

  await check('Browser.close denied + state unchanged', async () => {
    await assertRejects(s.sendCommand('Browser.close'), 'cdp method denied: Browser.close');
    assert(s.getState() === 'attached', 'state: ' + s.getState());
  });

  await check('SystemInfo.getProcessInfo denied', async () => {
    await assertRejects(s.sendCommand('SystemInfo.getProcessInfo'), 'cdp method denied: SystemInfo.getProcessInfo');
    assert(s.getState() === 'attached', 'state: ' + s.getState());
  });

  await check('Runtime.evaluate expression containing FP_CONFIG_DATA rejected fp carrier scrub', async () => {
    await assertRejects(
      s.sendCommand('Runtime.evaluate', { expression: 'console.log(process.env.FP_CONFIG_DATA)' }),
      'fp carrier scrub'
    );
    assert(s.getState() === 'attached', 'state: ' + s.getState());
  });

  await check('Runtime.evaluate clean expression allowed', async () => {
    const reply = await s.sendCommand('Runtime.evaluate', { expression: '1+1', awaitPromise: true });
    assert(reply.ok === true, 'reply: ' + JSON.stringify(reply));
  });

  await check('audit called for deny (and allow)', async () => {
    assert(
      audits.some((a) => a.type === 'cdp-deny' && a.method === 'Browser.close'),
      'missing cdp-deny Browser.close: ' + JSON.stringify(audits)
    );
    assert(
      audits.some((a) => a.type === 'cdp-deny' && a.method === 'SystemInfo.getProcessInfo'),
      'missing cdp-deny SystemInfo'
    );
    assert(
      audits.some((a) => a.type === 'cdp-deny' && a.method === 'Runtime.evaluate' && a.reason === 'fp carrier scrub'),
      'missing fp scrub audit'
    );
    assert(audits.some((a) => a.type === 'cdp-call' && a.method === 'Page.navigate'), 'missing cdp-call');
  });

  await check('isolated world created once then reused (2 evaluates → 1 create call)', async () => {
    const wc3 = makeWc();
    const s3 = createBrowserSession({ webContents: wc3, audit });
    s3.markReady();
    await s3.attach();
    await s3.sendCommand('Runtime.evaluate', { expression: '1+1' });
    await s3.sendCommand('Runtime.evaluate', { expression: '2+2' });
    assert(wc3.debugger._createCalls === 1, 'createCalls=' + wc3.debugger._createCalls);
  });

  await check('evaluate params carry contextId:7 + cdp-call world isolated', async () => {
    const wc4 = makeWc();
    const audits4 = [];
    const s4 = createBrowserSession({ webContents: wc4, audit: (r) => audits4.push(r) });
    s4.markReady();
    await s4.attach();
    await s4.sendCommand('Runtime.evaluate', { expression: '1+1' });
    assert(wc4.debugger._lastEvalParams.contextId === 7, 'params=' + JSON.stringify(wc4.debugger._lastEvalParams));
    assert(
      audits4.some((a) => a.type === 'cdp-call' && a.method === 'Runtime.evaluate' && a.world === 'isolated'),
      'missing isolated cdp-call: ' + JSON.stringify(audits4)
    );
  });

  await check("__world:'main' bypasses contextId + emits cdp-main-world audit", async () => {
    const wc5 = makeWc();
    const audits5 = [];
    const s5 = createBrowserSession({ webContents: wc5, audit: (r) => audits5.push(r) });
    s5.markReady();
    await s5.attach();
    await s5.sendCommand('Runtime.evaluate', { expression: '1+1', __world: 'main' });
    assert(wc5.debugger._createCalls === 0, 'createCalls=' + wc5.debugger._createCalls);
    assert(!('contextId' in wc5.debugger._lastEvalParams), 'leaked contextId');
    assert(!('__world' in wc5.debugger._lastEvalParams), 'leaked hatch: ' + JSON.stringify(wc5.debugger._lastEvalParams));
    assert(
      audits5.some((a) => a.type === 'cdp-main-world' && a.method === 'Runtime.evaluate'),
      'missing cdp-main-world: ' + JSON.stringify(audits5)
    );
    assert(
      audits5.some((a) => a.type === 'cdp-call' && a.method === 'Runtime.evaluate' && a.world === 'main'),
      'missing main cdp-call: ' + JSON.stringify(audits5)
    );
  });

  await check('FP scrub fires before world routing (no world created on scrub)', async () => {
    const wc6 = makeWc();
    const s6 = createBrowserSession({ webContents: wc6, audit });
    s6.markReady();
    await s6.attach();
    await assertRejects(
      s6.sendCommand('Runtime.evaluate', { expression: 'x.FP_CONFIG_DATA' }),
      'fp carrier scrub'
    );
    assert(wc6.debugger._createCalls === 0, 'createCalls=' + wc6.debugger._createCalls);
  });

  await check('crash event → crashed, recover() → ready', async () => {
    const h = wc.debugger._h && wc.debugger._h['message'];
    assert(typeof h === 'function', 'message handler registered');
    h({}, 'Inspector.targetCrashed', {}, 'sess-1');
    assert(s.getState() === 'crashed', 'state: ' + s.getState());
    s.recover();
    assert(s.getState() === 'ready', 'state after recover: ' + s.getState());
  });

  await check('detach → getState closed; sendCommand after closed rejects', async () => {
    await s.detach();
    assert(s.getState() === 'closed', 'state: ' + s.getState());
    await assertRejects(s.sendCommand('Page.navigate', { url: 'x' }), 'not attached');
    await s.detach(); // closed no-op
    assert(s.getState() === 'closed', 'still closed');
  });

  await check('attach failure leaves state ready', async () => {
    const wc2 = makeWc();
    const s2 = createBrowserSession({ webContents: wc2, audit });
    s2.markReady();
    wc2.debugger.attach = () => Promise.reject(new Error('attach boom'));
    await assertRejects(s2.attach(), 'attach boom');
    assert(s2.getState() === 'ready', 'state: ' + s2.getState());
  });

  await check('input.send present -> forwards to wc.sendInputEvent + audit input-event', async () => {
    const wc7 = makeWc();
    const sent = [];
    wc7.sendInputEvent = (ev) => {
      sent.push(ev);
      return 'ok';
    };
    const audits7 = [];
    const s7 = createBrowserSession({ webContents: wc7, audit: (r) => audits7.push(r) });
    const out = s7.input.send({ type: 'mouseMove' });
    assert(out === 'ok', 'out=' + out);
    assert(sent.length === 1 && sent[0].type === 'mouseMove', 'sent=' + JSON.stringify(sent));
    assert(audits7.some((a) => a.type === 'input-event' && a.backend === 'send'), 'audit=' + JSON.stringify(audits7));
  });

  await check('input.send absent -> throws NO_SEND_BACKEND', async () => {
    const wc8 = makeWc();
    delete wc8.sendInputEvent;
    const s8 = createBrowserSession({ webContents: wc8, audit });
    await assertRejects(Promise.resolve().then(() => s8.input.send({ type: 'mouseMove' })), 'NO_SEND_BACKEND');
  });

  await check('stale isolated context: evaluate retries once with a fresh world', async () => {
    const wc = makeWcStale({ failFirstWith: 'Cannot find context with specified id' });
    const s = createBrowserSession({ webContents: wc, audit });
    s.markReady();
    await s.attach();
    const reply = await s.sendCommand('Runtime.evaluate', { expression: '1+1' });
    assert(reply.ok === true, 'reply=' + JSON.stringify(reply));
    assert(wc.debugger._createCalls === 2, 'createCalls=' + wc.debugger._createCalls);
    assert(wc.debugger._evalCalls === 2, 'evalCalls=' + wc.debugger._evalCalls);
    assert(wc.debugger._evalParamsLog[0].contextId === 8, 'first contextId=' + wc.debugger._evalParamsLog[0].contextId);
    assert(wc.debugger._evalParamsLog[1].contextId === 9, 'retry contextId=' + wc.debugger._evalParamsLog[1].contextId);
  });

  await check('Page.frameNavigated resets cached world (next evaluate recreates)', async () => {
    const wc = makeWcStale();
    const s = createBrowserSession({ webContents: wc, audit });
    s.markReady();
    await s.attach();
    await s.sendCommand('Runtime.evaluate', { expression: '1+1' });
    const h = wc.debugger._h && wc.debugger._h['message'];
    assert(typeof h === 'function', 'message handler registered');
    h({}, 'Page.frameNavigated', { frame: { url: 'https://next/' } }, 'sess-x');
    await s.sendCommand('Runtime.evaluate', { expression: '2+2' });
    assert(wc.debugger._createCalls === 2, 'createCalls=' + wc.debugger._createCalls);
    assert(wc.debugger._evalParamsLog[0].contextId === 8, 'ctx1=' + wc.debugger._evalParamsLog[0].contextId);
    assert(wc.debugger._evalParamsLog[1].contextId === 9, 'ctx2=' + wc.debugger._evalParamsLog[1].contextId);
  });

  await check('Runtime.executionContextsCleared resets cached world', async () => {
    const wc = makeWcStale();
    const s = createBrowserSession({ webContents: wc, audit });
    s.markReady();
    await s.attach();
    await s.sendCommand('Runtime.evaluate', { expression: '1+1' });
    const h = wc.debugger._h && wc.debugger._h['message'];
    h({}, 'Runtime.executionContextsCleared', {}, 'sess-y');
    await s.sendCommand('Runtime.evaluate', { expression: '2+2' });
    assert(wc.debugger._createCalls === 2, 'createCalls=' + wc.debugger._createCalls);
    assert(wc.debugger._evalParamsLog[1].contextId === 9, 'ctx2=' + wc.debugger._evalParamsLog[1].contextId);
  });

  await check('non-stale evaluate error surfaces without retry', async () => {
    const wc = makeWcStale({ failFirstWith: 'boom: something else' });
    const s = createBrowserSession({ webContents: wc, audit });
    s.markReady();
    await s.attach();
    const msg = await assertRejects(s.sendCommand('Runtime.evaluate', { expression: '1+1' }));
    assert(msg.includes('boom'), 'msg=' + msg);
    assert(wc.debugger._createCalls === 1, 'createCalls=' + wc.debugger._createCalls);
    assert(wc.debugger._evalCalls === 1, 'evalCalls=' + wc.debugger._evalCalls);
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + e.message);
  process.exit(1);
});
