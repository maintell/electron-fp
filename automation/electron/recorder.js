// ponytail: live capture path for RPA recording. One self-contained IIFE is injected into
// the page's (isolated) world via the gated session; raw events accumulate in window.__fpRec
// and are drained, mapped to rpa-recorder's evt contract, and fed through the EXISTING
// createRecorder/generateSelector (no AST logic duplicated here). No deps, no Math.random.
'use strict';

const { createRecorder, generateSelector } = require('../runtime/rpa-recorder');
const { createRng } = require('../runtime/seeded-rng');

// Injected verbatim (toString) into the page; must stay self-contained: no outer refs.
function CAPTURE(maxBuffer, suppressInitialNav) {
  if (window.__fpRecOff) {
    try {
      window.__fpRecOff();
    } catch (e) {}
  }
  window.__fpRec = [];
  window.__fpRecSeq = 0;

  function push(rec) {
    var b = window.__fpRec;
    b.push(rec);
    if (b.length > maxBuffer) b.splice(0, b.length - maxBuffer);
    window.__fpRecSeq = (window.__fpRecSeq || 0) + 1;
  }
  function nthOf(el) {
    var n = 1;
    var p = el.previousElementSibling;
    while (p) {
      if (p.tagName === el.tagName) n++;
      p = p.previousElementSibling;
    }
    return n;
  }
  function pathOf(el) {
    var path = [];
    var node = el.parentElement;
    while (node && node.tagName) {
      path.unshift({ tag: node.tagName.toLowerCase(), nth: nthOf(node) });
      node = node.parentElement;
    }
    return path;
  }
  function targetOf(el, includeText) {
    var names = ['id', 'name', 'type', 'role', 'aria-label', 'data-testid', 'data-test', 'class', 'href', 'placeholder'];
    var attrs = {};
    for (var i = 0; i < names.length; i++) {
      if (!el.getAttribute) break;
      var v = el.getAttribute(names[i]);
      if (v !== null && v !== undefined && v !== '') attrs[names[i]] = String(v);
    }
    var text = '';
    if (includeText) {
      try {
        text = String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      } catch (e) {}
    }
    var coords;
    try {
      var r = el.getBoundingClientRect();
      coords = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    } catch (e) {}
    return { tag: el.tagName ? el.tagName.toLowerCase() : 'html', nth: nthOf(el), attrs: attrs, text: text, path: pathOf(el), coords: coords };
  }
  function describe(el, includeText) {
    return { ts: Date.now(), kind: '', target: targetOf(el, includeText) };
  }

  function onClick(e) {
    if (!e.target || !e.target.tagName) return;
    var r = describe(e.target, true);
    r.kind = 'click';
    r.clickCount = e.detail || 1;
    push(r);
  }
  function onInput(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    var r = describe(el, false);
    r.kind = 'input';
    r.value = el.value != null ? String(el.value) : '';
    push(r);
  }
  function onChange(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    if (el.tagName === 'SELECT') {
      var r = describe(el, false);
      r.kind = 'select';
      r.value = el.value;
      push(r);
      return;
    }
    if (el.type === 'file') {
      var r2 = describe(el, false);
      r2.kind = 'change';
      var files = [];
      for (var i = 0; i < (el.files || []).length; i++) files.push(el.files[i].name);
      r2.files = files;
      push(r2);
    }
  }
  var MODS = { Control: 1, Shift: 1, Alt: 1, Meta: 1, CapsLock: 1, Dead: 1, Unidentified: 1 };
  function onKeyDown(e) {
    var k = e.key;
    if (!k || MODS[k]) return;
    if (k.length === 1) return; // printable chars are captured by input; keep Enter/Tab/arrows/Escape
    var el = e.target && e.target.tagName ? e.target : document.documentElement;
    var r = describe(el, false);
    r.kind = 'keydown';
    r.key = k;
    push(r);
  }
  var lastScroll = 0;
  var lastX = 0;
  var lastY = 0;
  function onScroll(e) {
    var now = Date.now();
    if (now - lastScroll < 200) return; // throttle: accepted event's delta spans skipped moves
    var x = window.scrollX || 0;
    var y = window.scrollY || 0;
    var dx = x - lastX;
    var dy = y - lastY;
    lastScroll = now;
    lastX = x;
    lastY = y;
    if (dx === 0 && dy === 0) return;
    var el = document.scrollingElement || document.documentElement;
    var r = describe(el, false);
    r.kind = 'scroll';
    r.dx = dx;
    r.dy = dy;
    r.toEnd = document.body ? y + window.innerHeight >= document.body.scrollHeight : false;
    push(r);
  }
  function onNav() {
    push({ ts: Date.now(), kind: 'navigate', url: location.href });
  }

  var hp = history.pushState;
  var hr = history.replaceState;
  history.pushState = function () {
    var out = hp.apply(this, arguments);
    onNav();
    return out;
  };
  history.replaceState = function () {
    var out = hr.apply(this, arguments);
    onNav();
    return out;
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('popstate', onNav, true);
  window.addEventListener('hashchange', onNav, true);

  window.__fpRecOff = function () {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('popstate', onNav, true);
    window.removeEventListener('hashchange', onNav, true);
    history.pushState = hp;
    history.replaceState = hr;
  };

  // initial URL as the first navigate record; suppressed on cross-document re-injection
  // (the webContents emitter already queued that navigation record)
  if (!suppressInitialNav) push({ ts: Date.now(), kind: 'navigate', url: location.href });
  return 'fp-rec-ok:' + (window.__fpRecSeq || 0);
}

const READ_BUFFER = "(() => { const b = window.__fpRec || []; window.__fpRec = []; const s = window.__fpRecSeq || 0; window.__fpRecSeq = 0; return JSON.stringify(b); })()";
const UNINSTALL = "(() => { if (typeof window.__fpRecOff === 'function') { window.__fpRecOff(); window.__fpRecOff = null; } return 'off'; })()";

function descOf(t) {
  if (!t) return undefined;
  return {
    tag: t.tag,
    nth: t.nth,
    attrs: t.attrs || {},
    text: t.text || '',
    path: t.path || [],
    coords: t.coords,
  };
}

// raw record -> rpa-recorder evt (kind-faithful)
function toEvt(raw) {
  if (!raw || typeof raw.kind !== 'string') return null;
  const desc = descOf(raw.target);
  switch (raw.kind) {
    case 'click':
      return { kind: 'click', desc, button: raw.button, clickCount: raw.clickCount };
    case 'input':
      return { kind: 'input', desc, value: raw.value };
    case 'select':
      return { kind: 'select', desc, value: raw.value };
    case 'change':
      return { kind: 'change', desc, files: Array.isArray(raw.files) ? raw.files : [] };
    case 'keydown':
      return { kind: 'keydown', desc, key: raw.key };
    case 'scroll':
      return { kind: 'scroll', desc, y: raw.dy, toEnd: raw.toEnd };
    case 'navigate':
      return { kind: 'navigate', url: raw.url };
    default:
      return null;
  }
}

function createLiveRecorder({ session, page, driver, rng, audit, now, maxBuffer = 500, webContents } = {}) {
  if (!session || typeof session.sendCommand !== 'function') throw new Error('session required');
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const auditFn = typeof audit === 'function' ? audit : () => {};
  // fixed dev seed when no rng injected (deterministic gap jitter); never Math.random
  const rngFn = rng || createRng('fp-live-recorder-dev');

  let feedTs = null;
  const rec = createRecorder({
    generateSelector,
    now: () => (feedTs != null ? feedTs : nowFn()),
    rng: rngFn,
  });
  let nodes = [];
  let url0 = null;
  let started = false;
  let listenersBound = false;
  const pendingRaw = []; // cross-document navigate records pushed from the webContents emitter
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const injectionScript = (suppressInitialNav) =>
    '(' + CAPTURE.toString() + ')(' + Number(maxBuffer) + (suppressInitialNav ? ', true' : '') + ')';

  function evaluate(expression) {
    return session
      .sendCommand('Runtime.evaluate', { expression, returnByValue: true })
      .then((res) => (res && res.result ? res.result.value : undefined));
  }

  // Cross-document survival: a full load destroys window.__fpRec + its listeners with the old
  // document. After commit we re-inject the SAME script into the fresh document, guarded by
  // the marker so a live buffer is never clobbered. One 150ms retry covers mid-load evaluates,
  // then give up silently (ceiling: records until the next navigation/drain are lost).
  async function ensureInjected() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const present = await evaluate('!!window.__fpRec');
        if (present) return true;
        await evaluate(injectionScript(true)); // suppress duplicate nav record
        return true;
      } catch (_) {
        if (attempt === 0) await sleepMs(150);
      }
    }
    return false;
  }

  function onDidStartNavigation(_e, _url, isInPlace, isMainFrame) {
    if (!isMainFrame || isInPlace) return;
    // last moment the OLD document (and its buffer) is still reachable: pre-commit drain.
    // Fire-and-forget; a failed evaluate here is acceptable and must not throw.
    Promise.resolve()
      .then(() => drain())
      .catch(() => {});
  }

  function onDidNavigate(_e, url) {
    // page JS is gone now — queue the navigate record from the emitter, not from the page.
    pendingRaw.push({ ts: nowFn(), kind: 'navigate', url });
    ensureInjected().catch(() => {});
  }

  async function start() {
    if (webContents) {
      // cross-document mode: the IIFE does NOT self-record the initial URL; navigate
      // records come from the emitter/local queue so they survive the pre-commit drain
      // race (the Page.navigate is already in flight when did-start-navigation arrives,
      // so the old document's buffer read may lose to the commit).
      await evaluate(injectionScript(true));
    } else {
      await evaluate(injectionScript()); // legacy: IIFE pushes its own initial navigate
    }
    started = true;
    if (webContents && typeof webContents.on === 'function' && !listenersBound) {
      webContents.on('did-start-navigation', onDidStartNavigation);
      webContents.on('did-navigate', onDidNavigate);
      listenersBound = true;
    }
    try {
      url0 = await evaluate('location.href');
    } catch (_) {
      url0 = null;
    }
    if (webContents && url0) pendingRaw.push({ ts: nowFn(), kind: 'navigate', url: url0 });
    auditFn({ type: 'recorder-start' });
    return true;
  }

  async function doDrain() {
    if (!started) return [];
    const localRaw = pendingRaw.splice(0, pendingRaw.length);
    let pageRaw = [];
    try {
      const rawText = await evaluate(READ_BUFFER);
      if (rawText && typeof rawText === 'string') {
        const parsed = JSON.parse(rawText);
        if (Array.isArray(parsed)) pageRaw = parsed;
      }
    } catch (_) {
      pageRaw = [];
    }
    const raw = localRaw.concat(pageRaw);
    if (raw.length === 0) return [];
    const before = rec.events().length;
    for (const r of raw) {
      feedTs = r && typeof r.ts === 'number' ? r.ts : nowFn();
      const evt = toEvt(r);
      if (evt) rec.record(evt);
    }
    feedTs = null;
    const all = rec.events();
    nodes = all.slice();
    return all.slice(before);
  }

  // serialize drains: the pre-commit navigation drain races user-initiated drains
  let drainTail = Promise.resolve();
  function drain() {
    const p = drainTail.then(() => doDrain());
    drainTail = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  async function stop() {
    await drain();
    if (listenersBound && webContents) {
      try {
        webContents.removeListener('did-start-navigation', onDidStartNavigation);
      } catch (_) {}
      try {
        webContents.removeListener('did-navigate', onDidNavigate);
      } catch (_) {}
      listenersBound = false;
    }
    try {
      await evaluate(UNINSTALL);
    } catch (_) {}
    started = false;
    auditFn({ type: 'recorder-stop', nodes: nodes.length });
    return ast();
  }

  function ast() {
    return { nodes: nodes.slice(), meta: { recordedAt: nowFn(), url0 } };
  }

  return {
    start,
    drain,
    stop,
    ast,
    get nodes() {
      return nodes.slice();
    },
  };
}

module.exports = { createLiveRecorder, toEvt, descOf };
