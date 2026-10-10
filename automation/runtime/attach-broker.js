// ponytail: proxy-only single-attach broker (doc 17 Part B). One webContents.debugger attach
// owner for the whole process; every consumer (executor / recorder / CDP-WS bridge / external CDP)
// shares ONE browser session via acquire()/release(). Pure + injectable (NO require('electron'))
// so it stays mock-testable like launcher.js/glue.js. New invariant: only this module decides when
// to attach/detach — a handle exposes sendCommand/getState/onMessage/release but NOT
// attach/detach/close, so a consumer cannot introduce a second attach.
'use strict';

// A consumer may scope its event feed to a set of CDP domains (P2). method is
// '<Domain>.<Event>' — the domain is the segment before the first dot.
function domainOf(method) {
  const s = String(method || '');
  const i = s.indexOf('.');
  return i === -1 ? s : s.slice(0, i);
}
function matchesDomains(domains, method) {
  if (!domains || domains.size === 0) return true; // omitted/empty => all events (back-compat)
  return domains.has(domainOf(method));
}

// P3: resolve the ROOT page target id so a flat session can be opened against it.
// Probe-verified order: Target.getTargets -> the page target; then Target.getTargetInfo;
// then Page.getFrameTree (last resort). Any failure surfaces to ready()'s caller.
async function resolveRootTarget(session) {
  try {
    const t = await session.sendCommand('Target.getTargets', {});
    const infos = (t && t.targetInfos) || [];
    const page = infos.find((i) => i && i.type === 'page');
    if (page && page.targetId) return page.targetId;
  } catch (_) {}
  try {
    const ti = await session.sendCommand('Target.getTargetInfo', {});
    const id = ti && ti.targetInfo && ti.targetInfo.targetId;
    if (id) return id;
  } catch (_) {}
  try {
    const ft = await session.sendCommand('Page.getFrameTree', {});
    const id = ft && ft.frameTree && ft.frameTree.frame && ft.frameTree.frame.id;
    if (id) return id;
  } catch (_) {}
  throw new Error('attach-broker: could not resolve root page target id');
}

function createAttachBroker({ createSession, audit } = {}) {
  if (typeof createSession !== 'function') throw new Error('createSession required');
  const auditFn = typeof audit === 'function' ? audit : () => {};
  const entries = new WeakMap(); // webContents -> entry

  function entryFor(webContents) {
    let e = entries.get(webContents);
    if (!e) {
      e = {
        webContents,
        session: null,
        attachP: null,
        refs: 0,
        consumers: new Set(),
        listeners: new Set(),
        onDbg: null,
        onDetach: null,
        generation: 0,
      };
      entries.set(webContents, e);
    }
    return e;
  }

  function detachListeners(e) {
    const dbg = e.webContents && e.webContents.debugger;
    if (!dbg || typeof dbg.removeListener !== 'function') return;
    try { if (e.onDbg) dbg.removeListener('message', e.onDbg); } catch (_) {}
    try { if (e.onDetach) dbg.removeListener('detach', e.onDetach); } catch (_) {}
    e.onDbg = null;
    e.onDetach = null;
  }

  // Dedupe concurrent attaches via the attachP latch; only the first caller creates the session.
  function ensureAttached(e) {
    if (e.session && typeof e.session.getState === 'function' && e.session.getState() === 'attached') {
      return Promise.resolve(e.session);
    }
    if (e.attachP) return e.attachP;
    const gen = ++e.generation;
    const session = createSession({ webContents: e.webContents, audit: auditFn });
    e.session = session;
    if (typeof session.markReady === 'function') session.markReady();
    e.attachP = Promise.resolve()
      .then(() => session.attach())
      .then(() => {
        e.attachP = null;
        if (e.generation !== gen) return session; // superseded mid-flight (e.g. detach fired)
        const dbg = e.webContents.debugger;
        // ONE central 'message' listener per entry; fan out to each consumer through its
        // domain filter (P2). A throwing listener is isolated: its own dropped counter moves,
        // every other consumer still receives the event.
        e.onDbg = (_ev, method, params, sessionId) => {
          const sid = sessionId || null;
          for (const rec of Array.from(e.listeners)) {
            // P3: a flat consumer only sees its own flat session's events plus root-level
            // (no-sessionId) events; any other session's events are filtered out.
            if (rec.flat) {
              const mine = rec.flatState.sid;
              if (sid && sid !== mine) {
                rec.stats.filtered++;
                continue;
              }
            }
            if (!matchesDomains(rec.domains, method)) {
              rec.stats.filtered++;
              continue;
            }
            try {
              rec.fn(method, params, sessionId);
              rec.stats.delivered++;
            } catch (_) {
              rec.stats.dropped++;
            }
          }
        };
        // The session `detach` event is the invalidation signal (doc 17 B.1): drop the session so
        // the next acquire re-attaches. No RenderFrameHostChanged re-attach logic.
        e.onDetach = (_ev, reason) => {
          if (e.generation !== gen) return;
          e.generation++;
          e.session = null;
          e.attachP = null;
          detachListeners(e);
          auditFn({ type: 'attach-broker-detach', reason: reason == null ? null : String(reason), consumers: e.refs });
        };
        try { dbg.on('message', e.onDbg); } catch (_) {}
        try { dbg.on('detach', e.onDetach); } catch (_) {}
        auditFn({ type: 'attach-broker-attach', consumers: e.refs });
        return session;
      })
      .catch((err) => {
        e.attachP = null;
        if (e.generation === gen) e.session = null;
        throw err;
      });
    return e.attachP;
  }

  async function detachIfIdle(e) {
    if (e.refs > 0) return;
    if (e.attachP) {
      try { await e.attachP; } catch (_) {}
    }
    if (e.refs > 0) return; // re-acquired while awaiting the in-flight attach
    detachListeners(e);
    const session = e.session;
    e.session = null;
    e.attachP = null;
    if (session && typeof session.detach === 'function') {
      try { await session.detach(); } catch (_) {}
    }
    auditFn({ type: 'attach-broker-detach', reason: 'released', consumers: 0 });
  }

  function acquire({ webContents, consumer, domains, flat } = {}) {
    if (!webContents) throw new Error('webContents required');
    const e = entryFor(webContents);
    e.refs++;
    if (consumer) e.consumers.add(consumer);
    // P2: optional per-consumer domain filter. Omitted/empty => all events.
    const domainSet = Array.isArray(domains) && domains.length ? new Set(domains.map(String)) : null;
    // P3: opt-in flat session. When false/omitted the handle is exactly P1/P2.
    const useFlat = flat === true;
    const flatState = { sid: null }; // established asynchronously on ready()/sendCommand()
    const stats = { delivered: 0, dropped: 0, filtered: 0 };
    const records = new Set(); // this handle's onMessage registrations (removed on release)
    auditFn({ type: 'attach-broker-share', consumer: consumer || null, domains: domainSet ? [...domainSet] : null, flat: useFlat, refs: e.refs });

    // P3 setup: open ONE flat session to the root target on the shared attach (never a
    // second attach). Idempotent; resets on failure so a retry is possible.
    let flatP = null;
    function flatReady() {
      if (!useFlat) return ensureAttached(e);
      if (flatP) return flatP;
      flatP = ensureAttached(e)
        .then(async (s) => {
          if (flatState.sid) return flatState.sid;
          const targetId = await resolveRootTarget(s);
          const res = await s.sendCommand('Target.attachToTarget', { targetId, flatten: true });
          const sid = res && res.sessionId;
          if (!sid) throw new Error('attach-broker: attachToTarget returned no sessionId');
          flatState.sid = sid;
          auditFn({ type: 'attach-broker-flat', consumer: consumer || null, sessionId: sid, targetId });
          return sid;
        })
        .catch((err) => {
          flatP = null;
          throw err;
        });
      flatP.catch(() => {}); // callers that only use onMessage() must not crash on unhandled rejection
      return flatP;
    }

    const readyP = ensureAttached(e);
    readyP.catch(() => {}); // callers that only use sendCommand() later must not crash on unhandled rejection
    let released = false;
    return {
      get session() {
        return e.session;
      },
      get flatSessionId() {
        return flatState.sid;
      },
      getState() {
        return e.session && typeof e.session.getState === 'function' ? e.session.getState() : 'detached';
      },
      sendCommand(method, params, sessionId) {
        if (useFlat) return flatReady().then((sid) => e.session.sendCommand(method, params, sid));
        return ensureAttached(e).then((s) => s.sendCommand(method, params, sessionId));
      },
      input: {
        send(ev) {
          if (!e.session || typeof e.session.input !== 'object') throw new Error('attach-broker: not attached');
          return e.session.input.send(ev);
        },
      },
      onMessage(fn) {
        const rec = { fn, stats, domains: domainSet, flat: useFlat, flatState };
        records.add(rec);
        e.listeners.add(rec);
        return () => {
          records.delete(rec);
          e.listeners.delete(rec);
        };
      },
      // P2 observability: per-consumer event counters.
      stats() {
        return { delivered: stats.delivered, dropped: stats.dropped, filtered: stats.filtered };
      },
      ready() {
        if (useFlat) return flatReady().then(() => e.session);
        return ensureAttached(e);
      },
      async release() {
        if (released) return;
        released = true;
        // P3: close the flat session BEFORE releasing the shared root ref, so the root
        // attach outlives every flat session that rides on it.
        if (useFlat && flatState.sid && e.session && typeof e.session.sendCommand === 'function') {
          try {
            await e.session.sendCommand('Target.detachFromTarget', { sessionId: flatState.sid });
          } catch (_) {}
        }
        for (const rec of records) e.listeners.delete(rec);
        records.clear();
        if (consumer) e.consumers.delete(consumer);
        e.refs = Math.max(0, e.refs - 1);
        if (e.refs === 0) await detachIfIdle(e);
      },
    };
  }

  return { acquire };
}

module.exports = { createAttachBroker };
