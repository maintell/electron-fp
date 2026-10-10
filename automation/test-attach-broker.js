'use strict';
// Attach-broker P2 tests (doc 17 Part B): per-consumer domain filtering, per-consumer
// event stats, single central listener, ref-count release, share audit, listener
// isolation, and the launcher lifetime hold. PURE node — a fake webContents.debugger
// emits 'message'; no Electron, no real CDP.
const { createAttachBroker } = require('./runtime/attach-broker');
const { createElectronLauncher } = require('./electron/launcher');

let pass = 0;
let fail = 0;

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// fake webContents with an EventEmitter-ish debugger (on/removeListener/listenerCount/emit)
function fakeWc(extra) {
  const listeners = { message: [], detach: [] };
  const dbg = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    listenerCount(ev) { return (listeners[ev] || []).length; },
    emit(ev, ...args) { for (const f of (listeners[ev] || []).slice()) f(...args); },
  };
  return Object.assign({ id: 7, debugger: dbg, _emit: (method, params) => dbg.emit('message', {}, method, params, undefined) }, extra || {});
}

function makeBroker({ audits } = {}) {
  const state = { attaches: 0, detaches: 0, attachToTarget: [], detachFromTarget: [], commands: [] };
  let flatSeq = 0;
  const createSession = () => {
    let attached = false;
    return {
      markReady() {},
      async attach() { state.attaches++; attached = true; },
      async detach() { state.detaches++; attached = false; },
      getState() { return attached ? 'attached' : 'detached'; },
      async sendCommand(method, params, sessionId) {
        state.commands.push({ method, params, sessionId: sessionId || null });
        if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'ROOT', type: 'page' }] };
        if (method === 'Target.attachToTarget') {
          const sid = 'flat-' + (++flatSeq);
          state.attachToTarget.push({ params, sid });
          return { sessionId: sid };
        }
        if (method === 'Target.detachFromTarget') { state.detachFromTarget.push(params); return {}; }
        return {};
      },
      input: { send() {} },
    };
  };
  const broker = createAttachBroker({ createSession, audit: (ev) => { if (audits) audits.push(ev); } });
  return { broker, state };
}

(async () => {
  await t('P2(a) domains:[Network] consumer sees only Network.* events; others filtered', async () => {
    const wc = fakeWc();
    const { broker } = makeBroker();
    const h = broker.acquire({ webContents: wc, consumer: 'net', domains: ['Network'] });
    await h.ready();
    const seen = [];
    h.onMessage((m) => seen.push(m));
    wc._emit('Network.requestWillBeSent', {});
    wc._emit('Page.loadEventFired', {});
    wc._emit('Network.responseReceived', {});
    assert(seen.length === 2 && seen.every((m) => m.startsWith('Network.')), 'seen=' + JSON.stringify(seen));
    const st = h.stats();
    assert(st.delivered === 2 && st.filtered === 1 && st.dropped === 0, 'stats=' + JSON.stringify(st));
  });

  await t('P2(b) no domains consumer sees all events', async () => {
    const wc = fakeWc();
    const { broker } = makeBroker();
    const h = broker.acquire({ webContents: wc, consumer: 'all' });
    await h.ready();
    const seen = [];
    h.onMessage((m) => seen.push(m));
    wc._emit('Network.requestWillBeSent', {});
    wc._emit('Page.loadEventFired', {});
    wc._emit('Runtime.consoleAPICalled', {});
    assert(seen.length === 3, 'seen=' + JSON.stringify(seen));
    assert(h.stats().delivered === 3 && h.stats().filtered === 0, 'stats=' + JSON.stringify(h.stats()));
  });

  await t('P2(c) central message/detach listener count is exactly 1 regardless of consumers', async () => {
    const wc = fakeWc();
    const { broker } = makeBroker();
    const h1 = broker.acquire({ webContents: wc, consumer: 'c1', domains: ['Page'] });
    const h2 = broker.acquire({ webContents: wc, consumer: 'c2', domains: ['Network'] });
    await h1.ready();
    await h2.ready();
    assert(wc.debugger.listenerCount('message') === 1, 'message listeners=' + wc.debugger.listenerCount('message'));
    assert(wc.debugger.listenerCount('detach') === 1, 'detach listeners=' + wc.debugger.listenerCount('detach'));
    const a = [];
    const b = [];
    h1.onMessage((m) => a.push(m));
    h2.onMessage((m) => b.push(m));
    wc._emit('Page.loadEventFired', {});
    wc._emit('Network.requestWillBeSent', {});
    assert(a.length === 1 && a[0] === 'Page.loadEventFired', 'a=' + JSON.stringify(a));
    assert(b.length === 1 && b[0] === 'Network.requestWillBeSent', 'b=' + JSON.stringify(b));
  });

  await t('P2(d) ref-count: release detaches only at 0; one attach total', async () => {
    const wc = fakeWc();
    const { broker, state } = makeBroker();
    const h1 = broker.acquire({ webContents: wc, consumer: 'd1' });
    const h2 = broker.acquire({ webContents: wc, consumer: 'd2' });
    await h1.ready();
    await h2.ready();
    assert(state.attaches === 1, 'attach count=' + state.attaches);
    await h1.release();
    assert(state.detaches === 0, 'detached while a ref remained: ' + state.detaches);
    assert(h2.getState() === 'attached', 'h2 lost the attach after h1 release');
    await h2.release();
    assert(state.detaches === 1, 'not detached at 0 refs: ' + state.detaches);
    assert(wc.debugger.listenerCount('message') === 0, 'central listener not removed on detach');
  });

  await t('P2(e) audit records the consumer (attach-broker-share) + attach/detach', async () => {
    const audits = [];
    const wc = fakeWc();
    const { broker } = makeBroker({ audits });
    const h = broker.acquire({ webContents: wc, consumer: 'audit-consumer', domains: ['Runtime'] });
    await h.ready();
    const share = audits.find((a) => a.type === 'attach-broker-share' && a.consumer === 'audit-consumer');
    assert(share, 'no attach-broker-share audit: ' + JSON.stringify(audits));
    assert(Array.isArray(share.domains) && share.domains[0] === 'Runtime', 'audit domains=' + JSON.stringify(share.domains));
    assert(audits.some((a) => a.type === 'attach-broker-attach'), 'attach audit missing');
    await h.release();
    assert(audits.some((a) => a.type === 'attach-broker-detach'), 'detach audit missing');
  });

  await t('P2(f) a throwing listener does not affect other consumers', async () => {
    const wc = fakeWc();
    const { broker } = makeBroker();
    const bad = broker.acquire({ webContents: wc, consumer: 'bad' });
    const good = broker.acquire({ webContents: wc, consumer: 'good' });
    await bad.ready();
    await good.ready();
    bad.onMessage(() => { throw new Error('listener boom'); });
    const goodSeen = [];
    good.onMessage((m) => goodSeen.push(m));
    wc._emit('Page.loadEventFired', {});
    wc._emit('Network.requestWillBeSent', {});
    assert(goodSeen.length === 2, 'good listener starved: ' + JSON.stringify(goodSeen));
    assert(bad.stats().dropped === 2 && bad.stats().delivered === 0, 'bad stats=' + JSON.stringify(bad.stats()));
    assert(good.stats().delivered === 2 && good.stats().dropped === 0, 'good stats=' + JSON.stringify(good.stats()));
  });

  await t('P2 launcher lifetime hold: start acquires, stop releases, attach persists across runs', async () => {
    const wc = fakeWc({ session: {}, getURL: () => 'about:blank', isLoading: () => false, once: () => {}, removeListener: () => {} });
    const audits = [];
    const { broker, state } = makeBroker();
    const launcher = createElectronLauncher({
      createWindow: async () => ({ webContents: wc, loadURL: async () => {}, isDestroyed: () => false, destroy() {} }),
      broker,
      audit: (ev) => audits.push(ev),
    });
    await launcher.start({ id: 'p' });
    assert(state.attaches === 1, 'launcher did not acquire the attach: ' + state.attaches);
    assert(!!launcher.acquire('p'), 'launcher.acquire returned nothing');
    // a run binds the same webContents: shares the SAME attach (no churn)
    const run = broker.acquire({ webContents: wc, consumer: 'executor:p' });
    await run.ready();
    assert(state.attaches === 1, 'run caused a second attach: ' + state.attaches);
    await launcher.stop('p');
    assert(state.detaches === 0, 'launcher stop detached while the run ref remained: ' + state.detaches);
    assert(run.getState() === 'attached', 'run lost the attach after launcher stop');
    await run.release();
    assert(state.detaches === 1, 'no detach after all refs released: ' + state.detaches);
  });

  // ==========================================================================
  // P3 flat sessions (opt-in): distinct per-consumer sessionId, session-scoped
  // commands/events, flat-session detach on release, root attach stays single.
  // ==========================================================================
  await t('P3 flat: distinct sessionId per consumer; commands carry it; root attach count stays 1', async () => {
    const wc = fakeWc();
    const { broker, state } = makeBroker();
    const a = broker.acquire({ webContents: wc, consumer: 'flat-A', flat: true });
    const b = broker.acquire({ webContents: wc, consumer: 'flat-B', flat: true });
    const c = broker.acquire({ webContents: wc, consumer: 'plain-C' }); // non-flat control
    await a.ready();
    await b.ready();
    await c.ready();
    assert(typeof a.flatSessionId === 'string' && a.flatSessionId.length > 0, 'A flatSessionId=' + a.flatSessionId);
    assert(typeof b.flatSessionId === 'string' && b.flatSessionId.length > 0, 'B flatSessionId=' + b.flatSessionId);
    assert(a.flatSessionId !== b.flatSessionId, 'flat sessionIds not distinct: ' + a.flatSessionId + ' vs ' + b.flatSessionId);
    assert(c.flatSessionId === null, 'non-flat handle must have no flat sessionId: ' + c.flatSessionId);
    assert(state.attaches === 1, 'root attach count=' + state.attaches + ' (expected 1)');
    assert(state.attachToTarget.length === 2, 'attachToTarget calls=' + state.attachToTarget.length);
    await a.sendCommand('Runtime.evaluate', { expression: '1' });
    const sent = state.commands.filter((x) => x.method === 'Runtime.evaluate');
    assert(sent.length === 1 && sent[0].sessionId === a.flatSessionId, 'A command sessionId=' + JSON.stringify(sent));
    assert(sent[0].sessionId !== b.flatSessionId, 'A command used B session');
  });

  await t('P3 flat: events route by sessionId (A never sees B session events; root events reach both)', async () => {
    const wc = fakeWc();
    const { broker } = makeBroker();
    const a = broker.acquire({ webContents: wc, consumer: 'flat-A', flat: true });
    const b = broker.acquire({ webContents: wc, consumer: 'flat-B', flat: true });
    await a.ready();
    await b.ready();
    const aSeen = [];
    const bSeen = [];
    a.onMessage((m) => aSeen.push(m));
    b.onMessage((m) => bSeen.push(m));
    wc._emit('Page.loadEventFired', {}); // root-level (no sessionId) -> both
    wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { s: 'A' }, a.flatSessionId);
    wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { s: 'B' }, b.flatSessionId);
    assert(aSeen.includes('Page.loadEventFired'), 'A missed root event: ' + JSON.stringify(aSeen));
    assert(bSeen.includes('Page.loadEventFired'), 'B missed root event: ' + JSON.stringify(bSeen));
    assert(aSeen.filter((m) => m === 'Runtime.consoleAPICalled').length === 1, 'A event count=' + JSON.stringify(aSeen));
    assert(bSeen.filter((m) => m === 'Runtime.consoleAPICalled').length === 1, 'B event count=' + JSON.stringify(bSeen));
    // crisp isolation: a B-session-only event must never reach A
    aSeen.length = 0;
    bSeen.length = 0;
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {}, b.flatSessionId);
    assert(aSeen.length === 0, 'A saw B session event: ' + JSON.stringify(aSeen));
    assert(bSeen.length === 1 && bSeen[0] === 'Network.requestWillBeSent', 'B missed its own event: ' + JSON.stringify(bSeen));
  });

  await t('P3 flat: release() detaches the flat session before dropping the root ref', async () => {
    const wc = fakeWc();
    const { broker, state } = makeBroker();
    const a = broker.acquire({ webContents: wc, consumer: 'flat-A', flat: true });
    const keep = broker.acquire({ webContents: wc, consumer: 'keep' }); // holds the root ref
    await a.ready();
    await keep.ready();
    const sidA = a.flatSessionId;
    await a.release();
    assert(state.detachFromTarget.some((p) => p && p.sessionId === sidA), 'flat session not detached: ' + JSON.stringify(state.detachFromTarget));
    assert(state.detaches === 0, 'root detached while keep held a ref: ' + state.detaches);
    assert(keep.getState() === 'attached', 'root attach lost after flat release');
    await keep.release();
    assert(state.detaches === 1, 'root not detached at 0 refs: ' + state.detaches);
  });

  await t('P3 flat: flat + non-flat coexist; non-flat unchanged (still sees all events)', async () => {
    const wc = fakeWc();
    const { broker, state } = makeBroker();
    const f = broker.acquire({ webContents: wc, consumer: 'flat', flat: true });
    const p = broker.acquire({ webContents: wc, consumer: 'plain' });
    await f.ready();
    await p.ready();
    assert(state.attaches === 1, 'attach count=' + state.attaches);
    const fSeen = [];
    const pSeen = [];
    f.onMessage((m) => fSeen.push(m));
    p.onMessage((m) => pSeen.push(m));
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {}, f.flatSessionId); // flat-session event
    wc._emit('Page.loadEventFired', {}); // root event
    assert(fSeen.includes('Network.requestWillBeSent') && fSeen.includes('Page.loadEventFired'), 'flat seen=' + JSON.stringify(fSeen));
    assert(pSeen.includes('Network.requestWillBeSent') && pSeen.includes('Page.loadEventFired'), 'non-flat unchanged=' + JSON.stringify(pSeen));
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
