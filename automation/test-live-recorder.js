// ponytail: unit tests for the live capture path — mock session returns the injection ack,
// location.href, and queued raw-buffer JSON; the real rpa-recorder maps them to AST nodes.
'use strict';

const { createLiveRecorder } = require('./electron/recorder');
const { createAst } = require('./runtime/rpa-ast');

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

function desc(attrs, tag, extra) {
  return Object.assign(
    { tag: tag || 'div', nth: 1, attrs: attrs || {}, text: '', path: [], coords: { x: 1, y: 1 } },
    extra || {}
  );
}

function makeSession() {
  const state = { buffer: '[]', href: 'file:///x.html', scripts: [] };
  return {
    state,
    sendCommand: async (method, params) => {
      const expr = String((params && params.expression) || '');
      state.scripts.push(expr);
      if (expr === 'location.href') return { result: { value: state.href } };
      if (expr.includes('JSON.stringify(b)')) return { result: { value: state.buffer } };
      if (expr.includes("return 'off';")) return { result: { value: 'off' } };
      return { result: { value: 'fp-rec-ok:1' } };
    },
  };
}

function mk(extra) {
  const s = makeSession();
  const audits = [];
  const r = createLiveRecorder(Object.assign({ session: s, audit: (a) => audits.push(a), now: () => 1000 }, extra || {}));
  return { s, audits, r };
}

(async () => {
  await t('start injects a non-empty self-contained listener script + records url0', async () => {
    const { s, audits, r } = mk({ maxBuffer: 42 });
    const okStart = await r.start();
    assert(okStart === true, 'start return');
    const inject = s.state.scripts.find((e) => e.includes('addEventListener') && e.includes('__fpRec'));
    assert(inject && inject.length > 800, 'inject len=' + (inject ? inject.length : 0));
    assert(/addEventListener\('click'/.test(inject), 'click listener');
    assert(/addEventListener\('input'/.test(inject), 'input listener');
    assert(/addEventListener\('change'/.test(inject), 'change listener');
    assert(/addEventListener\('keydown'/.test(inject), 'keydown listener');
    assert(/addEventListener\('scroll'/.test(inject), 'scroll listener');
    assert(/pushState/.test(inject) && /replaceState/.test(inject) && /popstate/.test(inject), 'history hooks');
    assert(/splice\(0, b\.length - maxBuffer\)/.test(inject), 'buffer cap present');
    assert(inject.includes('(42)'), 'maxBuffer threaded: ' + inject.slice(-12));
    assert(!/require\(|Math\.random/.test(inject), 'self-contained + no Math.random');
    assert(audits.some((a) => a.type === 'recorder-start'), 'recorder-start audit');
    assert(r.ast().meta.url0 === 'file:///x.html', 'url0=' + r.ast().meta.url0);
  });

  await t('drain maps each raw kind → recorder evt + appends ordered nodes', async () => {
    const { s, r } = mk();
    s.state.buffer = JSON.stringify([
      { ts: 1000, kind: 'navigate', url: 'file:///x.html' },
      { ts: 1100, kind: 'click', clickCount: 1, target: desc({ id: 'go' }, 'button', { text: 'go' }) },
      { ts: 1200, kind: 'input', value: 'a', target: desc({ id: 'user' }, 'input') },
      { ts: 1230, kind: 'input', value: 'al', target: desc({ id: 'user' }, 'input') },
      { ts: 1260, kind: 'input', value: 'alice', target: desc({ id: 'user' }, 'input') },
      { ts: 1300, kind: 'select', value: 'b', target: desc({ id: 'pick' }, 'select') },
      { ts: 1400, kind: 'keydown', key: 'Enter', target: desc({ id: 'user' }, 'input') },
      { ts: 1500, kind: 'scroll', dy: 400, target: desc({}, 'html') },
    ]);
    await r.start();
    const got = await r.drain();
    assert(got.length === 6, 'count=' + got.length + ' types=' + JSON.stringify(got.map((n) => n.type)));
    assert(
      JSON.stringify(got.map((n) => n.type)) === JSON.stringify(['goto', 'click', 'fill', 'select', 'press', 'scroll']),
      'types=' + JSON.stringify(got.map((n) => n.type))
    );
    assert(got[0].url === 'file:///x.html', 'goto url=' + got[0].url);
    assert(got[1].selector === '#go' && got[1].selectorType === 'id' && got[1].quality === 90, 'click=' + JSON.stringify(got[1]));
    assert(got[2].selector === '#user' && got[2].value === 'alice', 'fill=' + JSON.stringify(got[2]));
    assert(got[3].selector === '#pick' && got[3].value === 'b', 'select=' + JSON.stringify(got[3]));
    assert(got[4].selector === '#user' && got[4].key === 'Enter', 'press=' + JSON.stringify(got[4]));
    assert(got[5].y === 400 && typeof got[5].selector === 'string', 'scroll=' + JSON.stringify(got[5]));
    assert(r.nodes.length === 6, 'nodes getter=' + r.nodes.length);
  });

  await t('two rapid inputs merge into one fill (debounce inherited)', async () => {
    const { s, r } = mk();
    s.state.buffer = JSON.stringify([
      { ts: 1000, kind: 'input', value: 'a', target: desc({ id: 'u' }, 'input') },
      { ts: 1100, kind: 'input', value: 'ab', target: desc({ id: 'u' }, 'input') },
    ]);
    await r.start();
    const got = await r.drain();
    assert(got.length === 1 && got[0].type === 'fill' && got[0].value === 'ab', 'got=' + JSON.stringify(got));
  });

  await t('empty / malformed buffer → no nodes, no crash', async () => {
    const a = mk();
    a.s.state.buffer = '[]';
    await a.r.start();
    assert((await a.r.drain()).length === 0, 'empty');
    assert(a.r.nodes.length === 0, 'nodes empty');
    const b = mk();
    b.s.state.buffer = 'not-json{';
    await b.r.start();
    assert((await b.r.drain()).length === 0, 'malformed');
    const c = mk();
    c.s.state.buffer = undefined;
    await c.r.start();
    assert((await c.r.drain()).length === 0, 'missing');
    assert(c.r.nodes.length === 0, 'missing -> no nodes');
  });

  await t('stop() flushes pending buffer + uninstalls + audits', async () => {
    const { s, audits, r } = mk();
    s.state.buffer = JSON.stringify([{ ts: 1, kind: 'click', clickCount: 1, target: desc({ id: 'x' }, 'button') }]);
    await r.start();
    await r.drain();
    s.state.buffer = JSON.stringify([{ ts: 2, kind: 'click', clickCount: 1, target: desc({ id: 'y' }, 'button') }]);
    const a = await r.stop();
    assert(a.nodes.some((n) => n.selector === '#y'), 'stop flushed #y: ' + JSON.stringify(a.nodes));
    assert(a.nodes.some((n) => n.selector === '#x'), 'earlier node kept');
    assert(audits.some((x) => x.type === 'recorder-stop' && x.nodes >= 2), 'stop audit=' + JSON.stringify(audits));
    assert(s.state.scripts.some((e) => e.includes('window.__fpRecOff = null')), 'uninstall injected');
  });

  await t('ast() shape passes rpa-ast validate()', async () => {
    const { s, r } = mk();
    s.state.buffer = JSON.stringify([
      { ts: 1, kind: 'navigate', url: 'file:///x.html' },
      { ts: 2, kind: 'click', clickCount: 2, target: desc({ id: 'go' }, 'button') },
    ]);
    await r.start();
    await r.drain();
    const a = r.ast();
    assert(Array.isArray(a.nodes) && typeof a.meta.recordedAt === 'number' && 'url0' in a.meta, 'shape=' + JSON.stringify(a.meta));
    const v = createAst().fromJson(a).validate();
    assert(v.ok === true, 'validate errors=' + JSON.stringify(v.errors));
    assert(a.nodes.filter((n) => n.type === 'click').length === 2, 'double-click → two clicks');
  });

  await t('selector quality respected: data-testid beats id/nth-child', async () => {
    const { s, r } = mk();
    s.state.buffer = JSON.stringify([
      { ts: 1, kind: 'click', clickCount: 1, target: desc({ 'data-testid': 'go', id: 'also-id' }, 'button') },
    ]);
    await r.start();
    const got = await r.drain();
    assert(got[0].selector === '[data-testid="go"]', 'selector=' + got[0].selector);
    assert(got[0].selectorType === 'data-testid' && got[0].quality === 100, 'q=' + JSON.stringify(got[0]));
  });

  // --- cross-document navigation survival (webContents emitter) ---
  const { EventEmitter } = require('events');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function makeNavSession(opts) {
    const base = makeSession();
    const state = base.state;
    state.present = !!opts.present;
    state.injectCalls = 0;
    state.failFirstCheck = !!opts.failFirstCheck;
    let checks = 0;
    const orig = base.sendCommand;
    base.sendCommand = async (method, params) => {
      const expr = String((params && params.expression) || '');
      if (expr === '!!window.__fpRec') {
        checks++;
        if (state.failFirstCheck && checks === 1) throw new Error('mid-load');
        return { result: { value: state.present } };
      }
      if (expr.includes('function CAPTURE')) state.injectCalls++;
      return orig(method, params);
    };
    return base;
  }

  await t('cross-doc: did-navigate queues navigate + re-injects when buffer missing', async () => {
    const s = makeNavSession({ present: false });
    const wc = new EventEmitter();
    const r = createLiveRecorder({ session: s, webContents: wc, audit: () => {}, now: () => 1000 });
    await r.start();
    s.state.injectCalls = 0;
    wc.emit('did-navigate', {}, 'file:///second.html');
    await sleep(120);
    assert(s.state.injectCalls === 1, 'injectCalls=' + s.state.injectCalls);
    const got = await r.drain();
    // cross-document mode queues navigate records locally: start URL + did-navigate URL
    assert(got.length === 2 && got[0].type === 'goto' && got[1].url === 'file:///second.html', 'got=' + JSON.stringify(got));
  });

  await t('cross-doc: guard skips re-injection when __fpRec present', async () => {
    const s = makeNavSession({ present: true });
    const wc = new EventEmitter();
    const r = createLiveRecorder({ session: s, webContents: wc, audit: () => {}, now: () => 1 });
    await r.start();
    s.state.injectCalls = 0;
    wc.emit('did-navigate', {}, 'file:///a.html');
    wc.emit('did-navigate', {}, 'file:///b.html');
    await sleep(120);
    assert(s.state.injectCalls === 0, 'unexpected injections=' + s.state.injectCalls);
    const got = await r.drain();
    assert(
      got.length === 3 && got[0].type === 'goto' && got[1].url === 'file:///a.html' && got[2].url === 'file:///b.html',
      'got=' + JSON.stringify(got.map((n) => n.url))
    );
  });

  await t('cross-doc: did-start-navigation drains main-frame only (not in-place/subframe)', async () => {
    const s = makeNavSession({ present: true });
    const wc = new EventEmitter();
    const r = createLiveRecorder({ session: s, webContents: wc, audit: () => {}, now: () => 1 });
    await r.start();
    const reads = () => s.state.scripts.filter((e) => e.includes('JSON.stringify(b)')).length;
    const base = reads();
    wc.emit('did-start-navigation', {}, 'file:///x', true, true); // in-place
    wc.emit('did-start-navigation', {}, 'file:///x', false, false); // subframe
    await sleep(80);
    assert(reads() === base, 'in-place/subframe triggered drain: ' + (reads() - base));
    wc.emit('did-start-navigation', {}, 'file:///x', false, true); // main-frame cross-doc
    await sleep(80);
    assert(reads() === base + 1, 'main-frame drain missing: ' + (reads() - base));
  });

  await t('cross-doc: mid-load check retries once then injects', async () => {
    const s = makeNavSession({ present: false, failFirstCheck: true });
    const wc = new EventEmitter();
    const r = createLiveRecorder({ session: s, webContents: wc, audit: () => {}, now: () => 1 });
    await r.start();
    s.state.injectCalls = 0;
    wc.emit('did-navigate', {}, 'file:///retry.html');
    await sleep(320);
    assert(s.state.injectCalls === 1, 'injectCalls=' + s.state.injectCalls);
  });

  await t('cross-doc: stop() removes navigation listeners', async () => {
    const s = makeNavSession({ present: false });
    const wc = new EventEmitter();
    const r = createLiveRecorder({ session: s, webContents: wc, audit: () => {}, now: () => 1 });
    await r.start();
    assert(wc.listenerCount('did-navigate') === 1 && wc.listenerCount('did-start-navigation') === 1, 'listeners bound');
    await r.stop();
    assert(wc.listenerCount('did-navigate') === 0 && wc.listenerCount('did-start-navigation') === 0, 'listeners not removed');
    s.state.injectCalls = 0;
    wc.emit('did-navigate', {}, 'file:///late.html');
    await sleep(80);
    assert(s.state.injectCalls === 0, 'listener alive after stop: injectCalls=' + s.state.injectCalls);
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
