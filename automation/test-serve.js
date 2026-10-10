// ponytail: end-to-end test for bin/serve.js — real listeners, real worker, real scheduler
// tick, raw-socket WS client (same codec pattern as test-ws-api.js). No electron, < 20s.
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { createAutomationServer } = require('./bin/serve');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(port, method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (_) {
          json = { _raw: raw };
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

// minimal masked-text WS client (test-ws-api.js wire pattern)
function wsConnect(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        'GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    const st = { buf: Buffer.alloc(0), open: false, status: null, raw: '', queue: [], waiters: [] };
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
          socket.destroy();
          return;
        }
        if (op !== 0x1) continue; // text frames only (server sends no ping/binary)
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch (_) {
          obj = { _raw: payload };
        }
        const w = st.waiters.shift();
        if (w) w(obj);
        else st.queue.push(obj);
      }
    }
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
    st.send = (obj) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      const mask = crypto.randomBytes(4);
      let h;
      if (body.length < 126) h = Buffer.from([0x81, 0x80 | body.length]);
      else {
        h = Buffer.alloc(4);
        h[0] = 0x81;
        h[1] = 0x80 | 126;
        h.writeUInt16BE(body.length, 2);
      }
      const masked = Buffer.from(body);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([h, mask, masked]));
    };
    st.next = (ms) =>
      new Promise((res, rej) => {
        if (st.queue.length) return res(st.queue.shift());
        const timer = setTimeout(() => rej(new Error('ws reply timeout')), ms || 3000);
        st.waiters.push((o) => {
          clearTimeout(timer);
          res(o);
        });
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
  const srv = createAutomationServer({ port: 0, token: 'tk-serve', schedulerTickMs: 250 });
  let started = null;
  try {
    await t('start() returns port/url/token', async () => {
      started = await srv.start();
      assert(started && started.port > 0, 'port=' + (started && started.port));
      assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(started.url), 'url=' + started.url);
      assert(started.token === 'tk-serve', 'token=' + started.token);
    });

    await t('status: Bearer 200, missing token 401', async () => {
      const ok = await httpReq(started.port, 'GET', '/api/automation/status', { token: 'tk-serve' });
      assert(ok.status === 200 && ok.body.ok === true && ok.body.data.service === 'automation', 'ok=' + JSON.stringify(ok));
      const no = await httpReq(started.port, 'GET', '/api/automation/status');
      assert(no.status === 401, 'no=' + no.status);
    });

    let scriptId = null;
    await t('script create + synchronous run → SUCCESS', async () => {
      const created = await httpReq(started.port, 'POST', '/api/scripts', {
        token: 'tk-serve',
        body: {
          name: 'serve-1',
          code: 'return 2+2',
          permissions: { browser: false, cookies: false, storage: false, network: false, filesystem: false, process: false },
          parameters: [],
        },
      });
      assert(created.status === 201 && created.body.ok === true, 'created=' + JSON.stringify(created));
      scriptId = created.body.data.id;
      const run = await httpReq(started.port, 'POST', '/api/scripts/' + scriptId + '/run', {
        token: 'tk-serve',
        body: { params: {}, profileContext: { id: 'srv-run' } },
      });
      assert(run.status === 200 && run.body.data && run.body.data.status === 'SUCCESS', 'run=' + JSON.stringify(run));
      assert(run.body.data.result === 4, 'result=' + JSON.stringify(run.body.data.result));
    });

    await t('worker actually runs queued task → SUCCESS', async () => {
      const enq = await httpReq(started.port, 'POST', '/api/tasks', { token: 'tk-serve', body: { scriptId, profileContext: { id: 'srv-1' } } });
      assert(enq.status === 200 && enq.body.ok === true, 'enq=' + JSON.stringify(enq)); // http-api returns 200 for tasks (no created flag)
      const id = enq.body.data.id;
      const t0 = Date.now();
      let st = null;
      for (;;) {
        const g = await httpReq(started.port, 'GET', '/api/tasks/' + id, { token: 'tk-serve' });
        st = g.body && g.body.data;
        if (st && (st.status === 'SUCCESS' || st.status === 'FAILED')) break;
        if (Date.now() - t0 > 5000) break;
        await sleep(50);
      }
      assert(st && st.status === 'SUCCESS', 'task=' + JSON.stringify(st));
      assert(st.result === 4, 'task result=' + JSON.stringify(st.result));
    });

    await t('scheduler tick fires a queued execution', async () => {
      const sch = await httpReq(started.port, 'POST', '/api/schedules', {
        token: 'tk-serve',
        body: { type: 'once', atMs: Date.now() + 300, scriptId, profileContexts: [{ id: 'srv-2' }] },
      });
      assert(sch.status === 200 && sch.body.ok === true, 'sch=' + JSON.stringify(sch)); // http-api returns 200 for schedules (no created flag)
      const t0 = Date.now();
      let hit = null;
      for (;;) {
        const ex = await httpReq(started.port, 'GET', '/api/executions?scriptId=' + scriptId, { token: 'tk-serve' });
        const list = (ex.body && ex.body.data && ex.body.data.rows) || [];
        hit = list.find((e) => e.profileId === 'srv-2');
        if (hit) break;
        if (Date.now() - t0 > 6000) break;
        await sleep(100);
      }
      assert(hit, 'no execution recorded for profileId srv-2');
    });

    await t('metrics: GET /api/metrics reflects the seeded executions; wired by default', async () => {
      assert(started.metrics === true, 'start().metrics=' + started.metrics);
      assert(srv.metrics && typeof srv.metrics.summary === 'function', 'srv.metrics exposed');
      const t0 = Date.now();
      let d = null;
      let status = 0;
      for (;;) {
        const r = await httpReq(started.port, 'GET', '/api/metrics', { token: 'tk-serve' });
        status = r.status;
        d = r.body && r.body.data;
        if (d && d.summary.total >= 3) break;
        if (Date.now() - t0 > 5000) break;
        await sleep(100);
      }
      assert(status === 200 && d, 'status=' + status);
      assert(d.summary.total >= 3, 'total=' + (d && d.summary.total));
      assert(d.failureRate.rate >= 0 && d.failureRate.rate <= 1, 'rate=' + (d && d.failureRate.rate));
      assert(typeof d.crashRate === 'number' && Array.isArray(d.topFailures) && Array.isArray(d.hotSteps), 'bundle shape');
    });

    await t('ws: status RPC ok, bad token rejected', async () => {
      const c = await wsConnect(started.port, '/api/ws?token=tk-serve');
      assert(c.status === 101, 'status=' + c.status);
      c.send({ id: 1, method: 'status' });
      const r = await c.next(3000);
      assert(r.id === 1 && r.ok === true && r.data.service === 'automation', 'r=' + JSON.stringify(r));
      c.close();
      const bad = await wsConnect(started.port, '/api/ws?token=nope');
      assert(bad.status === 401, 'bad=' + bad.status);
    });

    await t('stop(): resolves, port closed, worker stopped', async () => {
      await srv.stop();
      assert(srv.worker.status().state === 'stopped', 'worker=' + srv.worker.status().state);
      let refused = false;
      try {
        await httpReq(started.port, 'GET', '/api/automation/status', { token: 'tk-serve' });
      } catch (_) {
        refused = true;
      }
      assert(refused, 'port still accepting connections after stop');
    });

    await t('token generated when absent; double stop safe', async () => {
      const s2 = createAutomationServer({ port: 0 });
      const st = await s2.start();
      assert(/^[0-9a-f]{32}$/.test(st.token), 'token=' + st.token);
      await s2.stop();
      await s2.stop();
      assert(s2.worker.status().state === 'stopped', 'worker=' + s2.worker.status().state);
    });
  } finally {
    try {
      await srv.stop();
    } catch (_) {}
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
