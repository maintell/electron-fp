// ponytail: token-gated loopback-only CDP-over-WebSocket bridge. Reuses ws-api's RFC6455
// codec (handshake/frames) and browser-session's allowlist-gated debugger (gate + FP scrub
// + audit). Browser-level introspection is synthesized for a single page target; control
// methods stay denied by core.js. No new deps (node:http + ws-api codec only).
'use strict';

const http = require('http');
const { createBrowserSession } = require('./browser-session');
const { createAttachBroker } = require('./attach-broker');
const { hostOk, wsAccept, createParser, sendText, sendClose, sendPong } = require('./ws-api');
const { createTokenStore } = require('./token-store');

const PAGE_PREFIXES = ['Page.', 'DOM.', 'Input.', 'Network.', 'Runtime.', 'Storage.'];

// Methods Playwright sends unconditionally during attach/connect; they must answer (a rejection
// kills its connect Promise.all) but are accepted-and-IGNORED on purpose: nothing is
// forwarded, so no capability is granted. Emulation / ignore-certificate / download-policy
// effects are an explicit out-of-scope boundary for this bridge.
// playwright-core v1.63 crPage.ts: Log.enable:532, setIgnoreCertificateErrors:553,
// setFocusEmulationEnabled:548, setGeolocationOverride:568, setEmulatedMedia:570.
// Browser-level, at connect: crBrowser.ts CRBrowserContext.initialize awaits
// Browser.setDownloadBehavior (download policy; no forwarding, no capability);
// crBrowser.ts connect (connectOverCDP/persistent path) awaits Target.getTargetInfo
// after setAutoAttach (target introspection; result unused, no forwarding).
const ACCEPT_IGNORED = new Set([
  'Log.enable',
  'Emulation.setFocusEmulationEnabled',
  'Emulation.setGeolocationOverride',
  'Emulation.setEmulatedMedia',
  'Security.setIgnoreCertificateErrors',
  'Browser.setDownloadBehavior',
  'Target.getTargetInfo',
]);

function chromeProduct() {
  const v = process.versions && process.versions.chrome;
  return 'Chrome/' + (v || 'electron');
}

function targetInfo(state) {
  return {
    targetId: state.targetId,
    type: 'page',
    title: typeof state.getTitle === 'function' ? String(state.getTitle() || '') : '',
    url: typeof state.getUrl === 'function' ? String(state.getUrl() || '') : '',
    attached: !!state.attached,
    // Single-context bridge: Playwright's CRBrowser._onAttachedToTarget asserts
    // targetInfo.browserContextId is present and falls back to its default
    // context when the id is unknown. Without this field the handler throws
    // before creating the page, so connectOverCDP discovers zero pages.
    browserContextId: 'default',
  };
}

// Resolve the REAL main-frame id for use as the target id. Playwright keys its
// per-frame sessions by targetId and registers frames by the real frame id from
// Page.getFrameTree (crPage.ts _sessionForFrame/_handleFrameTree); a synthetic id
// ('page-' + wc.id) never matches, so every frame lookup throws
// "Frame has been detached." Fetch once at attach; fall back to the synthetic id
// if the debugger cannot answer (the connection must not fail on this).
async function resolveTargetId(session, fallbackId) {
  let timer = null;
  try {
    const tree = await Promise.race([
      session.sendCommand('Page.getFrameTree', {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('getFrameTree timeout')), 5000); }),
    ]);
    const id = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
    if (typeof id === 'string' && id.length) return id;
  } catch (_) {}
  finally { if (timer) clearTimeout(timer); }
  return fallbackId;
}

// Pure router: no socket access; returns {reply, events} and mutates only session state
// (attached/sessionId). Unit-tested directly with a mock session.
async function routeMessage(state, msg) {
  const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null;
  const method = msg && msg.method;
  if (typeof method !== 'string') {
    return { reply: { id, error: { code: -32600, message: 'invalid request' } }, events: [] };
  }
  const params = (msg && msg.params) || {};
  const deny = () => {
    if (typeof state.audit === 'function') {
      state.audit({ type: 'cdp-ws-deny', method, profileId: state.profileId });
    }
    return { reply: { id, error: { code: -32601, message: 'method not allowed: ' + method } }, events: [] };
  };

  if (method === 'Browser.getVersion') {
    if (state.session && typeof state.session.sendCommand === 'function') {
      try {
        return { reply: { id, result: await state.session.sendCommand('Browser.getVersion', params) }, events: [] };
      } catch (_) {
        // fall through to synthesis when forwarding is unavailable
      }
    }
    return { reply: { id, result: { protocolVersion: '1.3', product: chromeProduct(), revision: '', jsVersion: '' } }, events: [] };
  }
  if (method === 'Target.getTargets') {
    return { reply: { id, result: { targetInfos: [targetInfo(state)] } }, events: [] };
  }
  if (method === 'Target.setDiscoverTargets') {
    return {
      reply: { id, result: {} },
      events: [{ method: 'Target.targetCreated', params: { targetInfo: targetInfo(state) } }],
    };
  }
  if (method === 'Target.attachToTarget') {
    if (params.targetId && params.targetId !== state.targetId) {
      return { reply: { id, error: { code: -32000, message: 'no such target: ' + params.targetId } }, events: [] };
    }
    state.attached = true;
    state.sessionId = state.synthId || 'cdp-sess-1';
    return { reply: { id, result: { sessionId: state.sessionId } }, events: [] };
  }
  if (method === 'Target.detachFromTarget') {
    state.attached = false;
    state.sessionId = null;
    return { reply: { id, result: {} }, events: [] };
  }
  if (method === 'Target.getBrowserContexts') return { reply: { id, result: { browserContextIds: [] } }, events: [] };
  if (method === 'Target.setAutoAttach') {
    // Playwright discovers pages ONLY via the attachedToTarget events triggered by this call
    // (playwright-core v1.63 crBrowser.ts:84,106,165 - it never uses Target.attachToTarget).
    // Attach with the same semantics as attachToTarget so the emitted flat sessionId routes the
    // session-scoped page calls that follow.
    //   - page-level calls (msg.sessionId; Playwright sends them for OOPIF children, crPage.ts:540)
    //     are tolerated no-ops: the single-target bridge cannot see child targets, and re-emitting
    //     our page session would be a duplicate announcement.
    //   - emission is first-attach-only per connection: a repeat call must not re-announce the
    //     same sessionId (a real Chrome announces each session once).
    if (msg && msg.sessionId) return { reply: { id, result: {} }, events: [] };
    if (params.autoAttach === false) return { reply: { id, result: {} }, events: [] };
    const first = !state.attached || !state.sessionId;
    state.attached = true;
    state.sessionId = state.sessionId || state.synthId || 'cdp-sess-1';
    return {
      reply: { id, result: {} },
      events: first
        ? [{
            method: 'Target.attachedToTarget',
            params: { sessionId: state.sessionId, targetInfo: targetInfo(state), waitingForDebugger: false },
          }]
        : [],
    };
  }
  if (ACCEPT_IGNORED.has(method)) return { reply: { id, result: {} }, events: [] };
  if (method === 'Browser.getWindowForTarget') {
    // Playwright swallows errors here (crPage.ts:472) but logs them; answer with stub bounds.
    return { reply: { id, result: { windowId: 1, bounds: { left: 0, top: 0, width: 0, height: 0 } } }, events: [] };
  }

  if (PAGE_PREFIXES.some((p) => method.startsWith(p))) {
    if (!state.session || typeof state.session.sendCommand !== 'function') {
      return { reply: { id, error: { code: -32000, message: 'no session' } }, events: [] };
    }
    const fwd = Object.assign({}, params);
    delete fwd.sessionId; // single-target debugger: no flat-session routing
    try {
      const reply = { id, result: await state.session.sendCommand(method, fwd) };
      if (msg && msg.sessionId) reply.sessionId = msg.sessionId; // re-add so the client can correlate
      return { reply, events: [] };
    } catch (e) {
      return { reply: { id, error: { code: -32000, message: String((e && e.message) || e) } }, events: [] };
    }
  }
  return deny();
}

// shape of an event pushed to the client (sessionId only once attached)
function eventMessage(state, method, params) {
  const ev = { method, params };
  if (state.sessionId) ev.sessionId = state.sessionId;
  return ev;
}

function createCdpWs({ resolve, token, creds: credsOpt, graceMs, host = '127.0.0.1', port = 0, audit, now, broker } = {}) {
  if (typeof resolve !== 'function') throw new Error('resolve(profileId) required');
  const auditFn = typeof audit === 'function' ? audit : () => {};
  const ts = typeof now === 'function' ? now : () => Date.now();
  const creds =
    credsOpt && typeof credsOpt.verify === 'function'
      ? credsOpt
      : createTokenStore({ token, graceMs, now: ts });
  if (!credsOpt && (token == null || token === '')) throw new Error('token required');
  // token advertised in discovery URLs (one-time-revealed raw value when the store
  // still holds it; empty after a file-loaded restart, where only the hash survives).
  const advertisedToken = () => (typeof creds.rawToken === 'function' ? creds.rawToken() : token) || '';
  const sockets = new Set();
  let boundPort = 0;
  let connSeq = 0;
  // Proxy-only single-attach broker (doc 17 Part B): every external client joins the ONE shared
  // attach instead of creating+attaching its own session. A host can inject a process-wide broker
  // so built-in automation + external CDP share it; without one we build a local broker (still a
  // single owner for this bridge).
  const attachBroker =
    broker && typeof broker.acquire === 'function'
      ? broker
      : createAttachBroker({ createSession: createBrowserSession, audit: auditFn });

  function authOk(req, url) {
    const h = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null;
    const tok = bearer || url.searchParams.get('token');
    return !!tok && !!creds.verify(tok).role;
  }
  function profileIdOf(url) {
    return url.searchParams.get('profile') || 'default';
  }
  function sendJson(res, code, obj) {
    const text = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }
  function denyHttp(res, code, text) {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: text }));
    } catch (_) {}
  }

  function handler(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      url = null;
    }
    if (!url || (url.pathname !== '/json/version' && url.pathname !== '/json/list')) return false; // not ours
    if (!hostOk(req.headers.host)) {
      auditFn({ type: 'cdp-ws-deny', reason: 'host', ts: ts() });
      denyHttp(res, 403, 'forbidden');
      return true;
    }
    if (!authOk(req, url)) {
      auditFn({ type: 'cdp-ws-deny', reason: 'token', ts: ts() });
      denyHttp(res, 401, 'unauthorized');
      return true;
    }
    const profileId = profileIdOf(url);
    const live = resolve(profileId);
    const wc = live && live.webContents;
    const wsUrl =
      'ws://' + host + ':' + boundPort + '/api/cdp/' + encodeURIComponent(profileId) + '?token=' + encodeURIComponent(advertisedToken());
    if (url.pathname === '/json/version') {
      if (!wc) {
        auditFn({ type: 'cdp-ws-deny', reason: 'profile', profileId, ts: ts() });
        denyHttp(res, 404, 'no such profile: ' + profileId);
        return true;
      }
      sendJson(res, 200, {
        Browser: chromeProduct(),
        'Protocol-Version': '1.3',
        'User-Agent': typeof wc.getUserAgent === 'function' ? wc.getUserAgent() : 'Mozilla/5.0',
        webSocketDebuggerUrl: wsUrl,
      });
      return true;
    }
    sendJson(
      res,
      200,
      wc
        ? [
            {
              id: 'page-' + wc.id,
              type: 'page',
              title: typeof wc.getTitle === 'function' ? wc.getTitle() : '',
              url: typeof wc.getURL === 'function' ? wc.getURL() : '',
              webSocketDebuggerUrl: wsUrl,
            },
          ]
        : []
    );
    return true;
  }

  async function upgradeHandler(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      url = null;
    }
    if (!url || !url.pathname.startsWith('/api/cdp/')) return; // not ours (co-mountable with ws-api)
    const deny = (code, text) => {
      try {
        socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch (_) {}
      try {
        socket.destroy();
      } catch (_) {}
    };
    if (!hostOk(req.headers.host)) {
      auditFn({ type: 'cdp-ws-deny', reason: 'host', ts: ts() });
      return deny(403, 'Forbidden');
    }
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny(426, 'Upgrade Required');
    if (req.headers['sec-websocket-version'] !== '13') return deny(426, 'Upgrade Required');
    const key = req.headers['sec-websocket-key'];
    if (!key) return deny(400, 'Bad Request');
    if (!authOk(req, url)) {
      auditFn({ type: 'cdp-ws-deny', reason: 'token', ts: ts() });
      return deny(401, 'Unauthorized');
    }
    const profileId = decodeURIComponent(url.pathname.slice('/api/cdp/'.length));
    const live = resolve(profileId);
    if (!live || !live.webContents) {
      auditFn({ type: 'cdp-ws-deny', reason: 'profile', profileId, ts: ts() });
      return deny(404, 'Not Found');
    }
    const seq = ++connSeq;
    let handle;
    try {
      handle = attachBroker.acquire({ webContents: live.webContents, consumer: 'cdp-ws:' + profileId + ':' + seq });
      await handle.ready();
    } catch (e) {
      auditFn({ type: 'cdp-ws-deny', reason: 'attach', profileId, message: String((e && e.message) || e), ts: ts() });
      return deny(500, 'Internal Server Error');
    }
    // Real main-frame id (see resolveTargetId); falls back to the synthetic id.
    const targetId = await resolveTargetId(handle.session, 'page-' + live.webContents.id);
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          wsAccept(key) +
          '\r\n\r\n'
      );
    } catch {
      Promise.resolve(handle.release()).catch(() => {});
      return;
    }
    if (head && head.length) socket.unshift(head);
    sockets.add(socket);
    auditFn({ type: 'cdp-ws-open', profileId, ts: ts() });
    auditFn({ type: 'cdp-ws-share', profileId, ts: ts() });
    runSocket(socket, handle, live.webContents, profileId, targetId, seq);
  }

  function runSocket(socket, handle, wc, profileId, targetId, seq) {
    let alive = true;
    let closed = false;
    const state = {
      profileId,
      targetId: targetId || ('page-' + wc.id),
      synthId: 'cdp-sess-' + seq,
      getTitle: () => (typeof wc.getTitle === 'function' ? wc.getTitle() : ''),
      getUrl: () => (typeof wc.getURL === 'function' ? wc.getURL() : ''),
      attached: false,
      sessionId: null,
      audit: auditFn,
    };
    // Always resolve through the broker handle so a detach/re-attach never leaves a stale session.
    Object.defineProperty(state, 'session', { get: () => handle.session, enumerable: true });
    const send = (obj) => {
      if (alive) sendText(socket, JSON.stringify(obj));
    };
    let offMessage = null;
    try {
      offMessage = handle.onMessage((method, params) => send(eventMessage(state, method, params)));
    } catch (_) {}

    const close = (code) => {
      if (closed) return;
      closed = true;
      alive = false;
      try {
        if (offMessage) offMessage();
      } catch (_) {}
      // MUST release the broker handle (not session.detach()): detaching would kill every other
      // consumer sharing the single attach (doc 17 B.5, the most critical line of the refactor).
      Promise.resolve()
        .then(() => handle.release())
        .catch(() => {});
      sendClose(socket, code || 1000);
      setTimeout(() => {
        try {
          socket.destroy();
        } catch (_) {}
      }, 500);
      auditFn({ type: 'cdp-ws-close', profileId, ts: ts() });
    };

    const parser = createParser(
      (text) => {
        onText(text);
      },
      (kind, payload) => {
        if (kind === 'ping') sendPong(socket, payload);
      }
    );

    async function onText(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return send({ id: null, error: { code: -32700, message: 'parse error' } });
      }
      let out;
      try {
        out = await routeMessage(state, msg);
      } catch (e) {
        out = {
          reply: { id: msg && msg.id != null ? msg.id : null, error: { code: -32603, message: String((e && e.message) || e) } },
          events: [],
        };
      }
      if (out.reply) send(out.reply);
      for (const ev of out.events || []) send(ev);
    }

    socket.on('data', (chunk) => {
      let r;
      try {
        r = parser.feed(chunk);
      } catch {
        close(1002);
        return;
      }
      if (r && r.error) {
        send({ id: null, error: { code: -32600, message: r.error } });
        close(1003);
      } else if (r && r.closed) close(1000);
    });
    socket.on('close', () => close(1000));
    // Electron's upgraded socket emits 'end' (peer FIN) but not always 'close' promptly; release
    // the broker handle on either so an external client disconnect cannot leak a ref (close is idempotent).
    socket.on('end', () => close(1000));
    socket.on('error', () => {});
  }

  async function start() {
    if (!hostOk(host)) throw new Error('refusing non-loopback host: ' + host);
    const server = http.createServer((req, res) => {
      try {
        if (!handler(req, res)) denyHttp(res, 404, 'not found');
      } catch (_) {
        denyHttp(res, 500, 'handler crash');
      }
    });
    server.on('upgrade', upgradeHandler);
    await new Promise((resolve2, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve2();
      });
    });
    boundPort = server.address().port;
    const url = 'ws://' + host + ':' + boundPort + '/api/cdp/default?token=' + encodeURIComponent(advertisedToken());
    return {
      port: boundPort,
      url,
      close: () =>
        new Promise((resolve2) => {
          for (const s of sockets) {
            try {
              s.destroy();
            } catch (_) {}
          }
          sockets.clear();
          if (server.closeAllConnections) server.closeAllConnections();
          server.close(() => resolve2());
        }),
    };
  }

  return { start, handler, upgradeHandler, routeMessage, eventMessage };
}

module.exports = { createCdpWs, routeMessage, eventMessage, targetInfo, resolveTargetId };
