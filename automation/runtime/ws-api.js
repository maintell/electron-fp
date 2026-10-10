// ponytail: dependency-free WS transport over the same Service Layer (architecture.md §7).
// No 'ws' package on purpose — server speaks just enough RFC6455 (masked text
// frames in, unmasked text out, ping/pong, close) for panel push + RPC. Loopback
// + Bearer gates mirror http-api.js (canonical); token travels in ?token=
// because browsers cannot set Authorization on a WS handshake.
'use strict';

const crypto = require('crypto');
const { createTokenStore } = require('./token-store');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 1024 * 1024; // 1MB, same as HTTP body cap

// mirrors http-api.js gates (canonical there)
function hostOk(h) {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(h || ''));
}
function tokenEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

// minimal frame parser: accumulates until a full FIN text message (opcodes
// 0x1/0x0 continuation). Control frames handled inline. Returns {messages[],
// error?} and keeps leftover in state.buf.
function createParser(onMessage, onControl) {
  const state = { buf: Buffer.alloc(0), frag: [] };
  function feed(chunk) {
    state.buf = Buffer.concat([state.buf, chunk]);
    for (;;) {
      if (state.buf.length < 2) return {};
      const b0 = state.buf[0];
      const b1 = state.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (state.buf.length < 4) return {};
        len = state.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (state.buf.length < 10) return {};
        const hi = state.buf.readUInt32BE(2);
        const lo = state.buf.readUInt32BE(6);
        if (hi !== 0 || lo > MAX_MSG) return { error: 'frame too large' };
        len = lo;
        off = 10;
      }
      if (!masked) return { error: 'client frames must be masked' };
      if (state.buf.length < off + 4 + len) return {};
      const mask = state.buf.subarray(off, off + 4);
      const payload = state.buf.subarray(off + 4, off + 4 + len);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      state.buf = state.buf.subarray(off + 4 + len);
      if (op === 0x8) return { closed: payload };
      if (op === 0x9) {
        onControl('ping', payload);
        continue;
      }
      if (op === 0xa) continue; // pong: ignore
      if (op === 0x2) return { error: 'binary frames unsupported' };
      if (op !== 0x0 && op !== 0x1) return { error: 'bad opcode ' + op };
      state.frag.push(payload);
      if (!fin) continue;
      const msg = Buffer.concat(state.frag).toString('utf8');
      state.frag = [];
      if (Buffer.byteLength(msg) > MAX_MSG) return { error: 'message too large' };
      onMessage(msg);
    }
  }
  return { feed };
}

function sendText(socket, text) {
  const body = Buffer.from(text, 'utf8');
  let header;
  if (body.length < 126) header = Buffer.from([0x81, body.length]);
  else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(body.length, 6);
  }
  try {
    socket.write(Buffer.concat([header, body]));
    return true;
  } catch {
    return false;
  }
}

function sendClose(socket, code) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code || 1000, 0);
  try {
    socket.write(Buffer.concat([Buffer.from([0x88, 0x02]), body]));
  } catch (_) {}
}

function sendPong(socket, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const h = p.length < 126 ? Buffer.from([0x8a, p.length]) : Buffer.from([0x8a, 0]);
  try {
    socket.write(Buffer.concat([h, p]));
  } catch (_) {}
}

// read-only surface (viewer may call); writes need the admin token.
function buildMethods(service) {
  const read = {
    status: () => service.status(),
    'executions:list': (p) => service.run.listExecutions(p || {}),
    'executions:get': (p) => service.run.getExecution(p && p.id),
    'executions:logs': (p) => service.run.getLogs(p && p.id),
    'tasks:list': (p) => service.tasks.listTasks(p || {}),
    'tasks:get': (p) => service.tasks.getTask(p && p.id),
    'schedules:list': (p) => service.schedules.listSchedules(p || {}),
    'profiles:list': (p) => service.profiles.list(p || {}),
    'profiles:get': (p) => service.profiles.get(p && p.id),
    'profiles:status': (p) => service.profiles.status(p && p.id),
    'profiles:cdp': (p) => {
      const st = service.profiles.status(p && p.id);
      if (!st.ok) return st;
      const ep = st.data && st.data.endpoint;
      if (!ep) return { ok: false, error: { code: 'NOT_FOUND', message: 'no live endpoint' } };
      return { ok: true, data: { id: (p && p.id) || null, status: st.data.status, endpoint: ep } };
    },
  };
  const write = {
    'tasks:pause': (p) => service.tasks.pauseTask(p && p.id, { interrupt: p && p.interrupt }),
    'tasks:resume': (p) => service.tasks.resumeTask(p && p.id),
    'tasks:retry': (p) => service.tasks.retryTask(p && p.id, p && p.opts),
    'tasks:cancel': (p) => service.tasks.cancelTask(p && p.id),
    'run:stop': (p) => service.run.stop(p && p.id),
  };
  return { read, write };
}

function createWsApi({ service, token, readToken, jwtSecret, creds: credsOpt, graceMs, now, audit } = {}) {
  if (!service) throw new Error('service required');
  const creds =
    credsOpt && typeof credsOpt.verify === 'function'
      ? credsOpt
      : createTokenStore({ token, readToken, jwtSecret, graceMs, now });
  if (!credsOpt && (token == null || token === '')) throw new Error('token required');
  const auditFn = typeof audit === 'function' ? audit : () => {};
  const methods = buildMethods(service);

  function upgradeHandler(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      url = null;
    }
    const deny = (code, text) => {
      try {
        socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch (_) {}
      try {
        socket.destroy();
      } catch (_) {}
    };
    if (!url || url.pathname !== '/api/ws') return deny(404, 'Not Found');
    if (!hostOk(req.headers.host)) {
      auditFn({ type: 'ws', path: '/api/ws', status: 403 });
      return deny(403, 'Forbidden');
    }
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny(426, 'Upgrade Required');
    if (req.headers['sec-websocket-version'] !== '13') return deny(426, 'Upgrade Required');
    const key = req.headers['sec-websocket-key'];
    if (!key) return deny(400, 'Bad Request');
    const tok = url.searchParams.get('token');
    const role = tok ? creds.verify(tok).role : null;
    if (!role) {
      auditFn({ type: 'ws', path: '/api/ws', status: 401 });
      return deny(401, 'Unauthorized');
    }
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          wsAccept(key) +
          '\r\n\r\n'
      );
    } catch {
      return;
    }
    if (head && head.length) socket.unshift(head);
    auditFn({ type: 'ws', path: '/api/ws', status: 101, role });
    runSocket(socket, role);
  }

  function runSocket(socket, role) {
    const subs = new Map(); // executionId -> { timer, lastStatus, lastLogs }
    let alive = true;
    const close = (code) => {
      if (!alive) return;
      alive = false;
      for (const s of subs.values()) clearInterval(s.timer);
      subs.clear();
      sendClose(socket, code || 1000);
      setTimeout(() => {
        try {
          socket.destroy();
        } catch (_) {}
      }, 500);
    };
    const send = (obj) => {
      if (alive) sendText(socket, JSON.stringify(obj));
    };
    const parser = createParser(
      (text) => onRpc(text),
      (kind, payload) => {
        if (kind === 'ping') sendPong(socket, payload);
      }
    );

    function onRpc(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return send({ id: null, ok: false, error: { code: 'VALIDATION', message: 'malformed JSON' } });
      }
      const { id = null, method, params } = msg || {};
      if (typeof method !== 'string') {
        return send({ id, ok: false, error: { code: 'VALIDATION', message: 'method required' } });
      }
      if (method === 'subscribe') return onSubscribe(id, params);
      if (method === 'unsubscribe') return onUnsubscribe(id, params);
      const fn = methods.read[method] || (role === 'admin' ? methods.write[method] : null);
      if (!fn) {
        const code = methods.write[method] ? 'FORBIDDEN' : 'NOT_FOUND';
        return send({ id, ok: false, error: { code, message: code === 'FORBIDDEN' ? 'read-only token' : 'unknown method: ' + method } });
      }
      let out;
      try {
        out = fn(params || {});
      } catch (e) {
        return send({ id, ok: false, error: { code: 'INTERNAL', message: String((e && e.message) || e) } });
      }
      Promise.resolve(out).then(
        (env) => {
          if (env && typeof env.ok === 'boolean') {
            if (env.ok) send({ id, ok: true, data: env.data });
            else send({ id, ok: false, error: env.error || { code: 'INTERNAL', message: 'failed' } });
          } else {
            send({ id, ok: true, data: env });
          }
        },
        (e) => send({ id, ok: false, error: { code: 'INTERNAL', message: String((e && e.message) || e) } })
      );
    }

    function snapshot(execId) {
      const r = service.run.getExecution(execId);
      if (!r.ok) return null;
      const d = r.data;
      return { status: d.status, logCount: Array.isArray(d.logs) ? d.logs.length : 0 };
    }

    function onSubscribe(id, params) {
      const execId = params && params.executionId;
      if (!execId) return send({ id, ok: false, error: { code: 'VALIDATION', message: 'executionId required' } });
      if (subs.has(execId)) return send({ id, ok: true, data: { subscribed: execId } });
      if (subs.size >= 10) return send({ id, ok: false, error: { code: 'LIMIT', message: 'too many subscriptions' } });
      const cur = snapshot(execId);
      if (!cur) return send({ id, ok: false, error: { code: 'NOT_FOUND', message: 'execution not found' } });
      const sub = { lastStatus: cur.status, lastLogs: cur.logCount, timer: null };
      sub.timer = setInterval(() => {
        if (!alive) return;
        const s = snapshot(execId);
        if (!s) {
          send({ event: 'execution', executionId: execId, gone: true });
          clearInterval(sub.timer);
          subs.delete(execId);
          return;
        }
        if (s.status !== sub.lastStatus || s.logCount !== sub.lastLogs) {
          sub.lastStatus = s.status;
          sub.lastLogs = s.logCount;
          send({ event: 'execution', executionId: execId, status: s.status, logCount: s.logCount });
        }
      }, 250);
      if (sub.timer.unref) sub.timer.unref();
      subs.set(execId, sub);
      auditFn({ type: 'ws-sub', executionId: execId, role });
      return send({ id, ok: true, data: { subscribed: execId, status: cur.status, logCount: cur.logCount } });
    }

    function onUnsubscribe(id, params) {
      const execId = params && params.executionId;
      const sub = subs.get(execId);
      if (sub) {
        clearInterval(sub.timer);
        subs.delete(execId);
      }
      return send({ id, ok: true, data: { unsubscribed: execId || null } });
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
        send({ id: null, ok: false, error: { code: 'VALIDATION', message: r.error } });
        close(1003);
      } else if (r && r.closed) close(1000);
    });
    socket.on('close', () => {
      alive = false;
      for (const s of subs.values()) clearInterval(s.timer);
      subs.clear();
    });
    socket.on('error', () => {});
  }

  return { attach: (server) => server.on('upgrade', upgradeHandler), upgradeHandler };
}

// additive exports: RFC6455 primitives reused by the CDP-over-WS bridge (cdp-ws.js);
// no behavior change to createWsApi.
module.exports = { createWsApi, hostOk, tokenEqual, wsAccept, createParser, sendText, sendClose, sendPong };
