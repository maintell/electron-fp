// ponytail: WS transport tests with a raw-socket client (no 'ws' dep anywhere,
// not even in tests). Covers handshake gates, role split, RPC, subscribe push.
'use strict';

const net = require('net');
const crypto = require('crypto');
const { createScriptStore } = require('./runtime/script-store');
const { createScriptRunner } = require('./runtime/script-runner');
const { createAutomationManager } = require('./runtime/automation-manager');
const { createTaskQueue } = require('./runtime/task-queue');
const { createScheduler } = require('./runtime/scheduler');
const { createAutomationService } = require('./runtime/automation-service');
const { createHttpApi } = require('./runtime/http-api');
const { createWsApi } = require('./runtime/ws-api');

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

// minimal WS client: handshake, masked text send, unmasked frame parse.
function connect({ port, token, host, path }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const q = token !== undefined ? '?token=' + encodeURIComponent(token) : '';
      socket.write(
        'GET ' + (path || '/api/ws') + q + ' HTTP/1.1\r\n' +
        'Host: ' + (host || '127.0.0.1:' + port) + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    const st = { buf: Buffer.alloc(0), open: false, queue: [], waiters: [], status: null, raw: '' };
    socket.on('data', (chunk) => {
      if (!st.open) {
        st.raw += chunk.toString('latin1');
        const i = st.raw.indexOf('\r\n\r\n');
        if (i === -1) return;
        st.status = Number(st.raw.slice(0, st.raw.indexOf('\r\n')).split(' ')[1]);
        st.open = st.status === 101;
        const rest = Buffer.from(st.raw.slice(i + 4), 'latin1');
        st.raw = '';
        if (!st.open) {
          socket.destroy();
          resolve(st);
          return;
        }
        if (rest.length) onFrame(rest);
        resolve(st);
        return;
      }
      onFrame(chunk);
    });
    function onFrame(chunk) {
      st.buf = Buffer.concat([st.buf, chunk]);
      for (;;) {
        if (st.buf.length < 2) return;
        const op = st.buf[0] & 0x0f;
        let len = st.buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (st.buf.length < 4) return;
          len = st.buf.readUInt16BE(2);
          off = 4;
        }
        if (st.buf.length < off + len) return;
        const payload = st.buf.subarray(off, off + len).toString('utf8');
        st.buf = st.buf.subarray(off + len);
        if (op === 0x8) {
          st.closed = true;
          socket.destroy();
          return;
        }
        if (op === 0x9) continue; // server ping (none sent); ignore
        if (op === 0xa) {
          st.pongs = (st.pongs || 0) + 1;
          continue;
        }
        if (op !== 0x1) continue;
        let obj = null;
        try { obj = JSON.parse(payload); } catch { obj = { _raw: payload }; }
        const w = st.waiters.shift();
        if (w) w(obj);
        else st.queue.push(obj);
      }
    }
    st.send = (obj) => st.sendRaw(JSON.stringify(obj));
    st.sendRaw = (text) => {
      const body = Buffer.from(String(text), 'utf8');
      const mask = crypto.randomBytes(4);
      const h = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : (() => {
        const b = Buffer.alloc(4);
        b[0] = 0x81; b[1] = 0x80 | 126; b.writeUInt16BE(body.length, 2);
        return b;
      })();
      const masked = Buffer.from(body);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([h, mask, masked]));
    };
    st.ping = () => {
      const mask = crypto.randomBytes(4);
      socket.write(Buffer.concat([Buffer.from([0x89, 0x80]), mask]));
    };
    st.next = (ms) => new Promise((res, rej) => {
      if (st.queue.length) return res(st.queue.shift());
      const timer = setTimeout(() => rej(new Error('ws reply timeout')), ms || 3000);
      st.waiters.push((o) => { clearTimeout(timer); res(o); });
    });
    st.close = () => socket.destroy();
    socket.on('error', () => {});
    socket.on('close', () => {
      while (st.waiters.length) st.waiters.shift()({ _closed: true });
    });
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}

(async () => {
  const TOKEN = 'ws-admin';
  const store = createScriptStore();
  const manager = createAutomationManager({
    store,
    runnerFactory: () => createScriptRunner({ browserApi: { browser: { goto: async () => {} } }, timeoutMs: 30000 }),
    audit: () => {},
  });
  const queue = createTaskQueue({ audit: () => {} });
  const scheduler = createScheduler({ audit: () => {}, onFire: () => {} });
  const svc = createAutomationService({ store, manager, queue, scheduler });
  const ws = createWsApi({ service: svc, token: TOKEN, readToken: 'ws-ro', audit: () => {} });
  const api = createHttpApi({ service: svc, token: TOKEN, readToken: 'ws-ro', audit: () => {}, upgradeHandler: ws.upgradeHandler, rateLimit: { max: 1000, windowMs: 60000 } });
  let srv;
  try {
    srv = await api.start();
    const port = srv.port;

    await t('no token -> 401, bad token -> 401', async () => {
      const a = await connect({ port });
      assert(a.status === 401, 'missing ' + a.status);
      const b = await connect({ port, token: 'nope' });
      assert(b.status === 401, 'bad ' + b.status);
    });

    await t('bad Host -> 403, wrong path -> 404', async () => {
      const a = await connect({ port, token: TOKEN, host: 'evil.com' });
      assert(a.status === 403, 'host ' + a.status);
      const b = await connect({ port, token: TOKEN, path: '/api/nope' });
      assert(b.status === 404, 'path ' + b.status);
    });

    await t('viewer: status RPC ok, write RPC 403', async () => {
      const c = await connect({ port, token: 'ws-ro' });
      assert(c.status === 101, 'handshake ' + c.status);
      c.send({ id: 1, method: 'status' });
      const r = await c.next();
      assert(r.id === 1 && r.ok === true && r.data.service === 'automation', 'status: ' + JSON.stringify(r));
      c.send({ id: 2, method: 'tasks:cancel', params: { id: 'x' } });
      const w = await c.next();
      assert(w.id === 2 && w.ok === false && w.error.code === 'FORBIDDEN', 'write: ' + JSON.stringify(w));
      c.close();
    });

    await t('admin: unknown method NOT_FOUND, malformed JSON VALIDATION', async () => {
      const c = await connect({ port, token: TOKEN });
      assert(c.status === 101, 'handshake');
      c.send({ id: 1, method: 'nope:nah' });
      const r = await c.next();
      assert(r.ok === false && r.error.code === 'NOT_FOUND', 'unknown: ' + JSON.stringify(r));
      c.sendRaw('{oops');
      const m = await c.next();
      assert(m.ok === false && m.error.code === 'VALIDATION', 'malformed: ' + JSON.stringify(m));
      c.close();
    });

    await t('subscribe live run -> terminal push; unsubscribe ok', async () => {
      const created = store.create({ name: 'ws-hang', code: 'await new Promise(() => {});', permissions: { browser: false }, parameters: [] });
      const h = manager.runScriptCancellable(created.id, {});
      const c = await connect({ port, token: TOKEN });
      assert(c.status === 101, 'handshake');
      c.send({ id: 1, method: 'subscribe', params: { executionId: h.executionId } });
      const sub = await c.next();
      assert(sub.ok === true && sub.data.subscribed === h.executionId, 'subscribed: ' + JSON.stringify(sub));
      assert(sub.data.status === 'RUNNING', 'live status: ' + sub.data.status);
      manager.cancel(h.executionId);
      const push = await c.next(5000);
      assert(push.executionId === h.executionId && push.status === 'CANCELLED', 'push: ' + JSON.stringify(push));
      await h.promise;
      c.send({ id: 2, method: 'unsubscribe', params: { executionId: h.executionId } });
      const u = await c.next();
      assert(u.ok === true, 'unsub: ' + JSON.stringify(u));
      c.send({ id: 3, method: 'subscribe', params: { executionId: 'missing' } });
      const m = await c.next();
      assert(m.ok === false && m.error.code === 'NOT_FOUND', 'missing: ' + JSON.stringify(m));
      c.close();
    });

    await t('ping -> pong', async () => {
      const c = await connect({ port, token: TOKEN });
      assert(c.status === 101, 'handshake');
      c.ping();
      const t0 = Date.now();
      while (!(c.pongs >= 1) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
      assert(c.pongs >= 1, 'no pong');
      c.close();
    });

    console.log('DONE pass=' + pass + ' fail=' + fail);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    if (srv) await srv.close();
  }
})();
