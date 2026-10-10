// ponytail: router-level unit tests for the CDP-over-WS bridge + HTTP gate tests over a
// real ephemeral listen. No 'ws' dependency; raw net socket only for the WS 404 gate.
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { createCdpWs, routeMessage, eventMessage, resolveTargetId } = require('./runtime/cdp-ws');

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

function mockState() {
  const calls = [];
  const audits = [];
  const session = {
    sendCommand: async (m, p) => {
      calls.push([m, p]);
      if (m === 'Browser.getVersion') return { protocolVersion: '1.3', product: 'Chrome/Mock' };
      if (m === 'Runtime.evaluate') return { result: { type: 'string', value: 'V' } };
      return {};
    },
  };
  const wc = { id: 42, getTitle: () => 'Title 42', getURL: () => 'https://x/' };
  const state = {
    profileId: 'p1',
    targetId: 'page-42',
    session,
    getTitle: () => wc.getTitle(),
    getUrl: () => wc.getURL(),
    attached: false,
    sessionId: null,
    audit: (r) => audits.push(r),
  };
  return { state, calls, audits };
}

function httpGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawUpgrade(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        'GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let raw = '';
    socket.on('data', (c) => {
      raw += c.toString('latin1');
      if (raw.includes('\r\n')) {
        const status = Number(raw.slice(0, raw.indexOf('\r\n')).split(' ')[1]);
        socket.destroy();
        resolve(status);
      }
    });
    socket.on('error', reject);
    setTimeout(() => {
      if (!raw) {
        socket.destroy();
        reject(new Error('no response'));
      }
    }, 3000);
  });
}

(async () => {
  // --- router-level (mock session, no sockets) ---
  await t('Browser.getVersion forwarded through session', async () => {
    const { state, calls } = mockState();
    const { reply, events } = await routeMessage(state, { id: 1, method: 'Browser.getVersion' });
    assert(calls.length === 1 && calls[0][0] === 'Browser.getVersion', 'calls=' + JSON.stringify(calls));
    assert(reply.id === 1 && reply.result.product === 'Chrome/Mock', 'reply=' + JSON.stringify(reply));
    assert(events.length === 0, 'events=' + JSON.stringify(events));
  });

  await t('Browser.getVersion synthesizes when forwarding fails', async () => {
    const { state } = mockState();
    state.session.sendCommand = async () => {
      throw new Error('forward boom');
    };
    const { reply } = await routeMessage(state, { id: 2, method: 'Browser.getVersion' });
    assert(/^Chrome\//.test(reply.result.product), 'product=' + reply.result.product);
    assert(reply.result.protocolVersion === '1.3', 'protocolVersion=' + reply.result.protocolVersion);
  });

  await t('Target.getTargets synthesizes one page target', async () => {
    const { state, calls } = mockState();
    const { reply } = await routeMessage(state, { id: 3, method: 'Target.getTargets' });
    const infos = reply.result.targetInfos;
    assert(Array.isArray(infos) && infos.length === 1, 'infos=' + JSON.stringify(infos));
    assert(infos[0].targetId === 'page-42' && infos[0].type === 'page', 'target=' + JSON.stringify(infos[0]));
    assert(typeof infos[0].browserContextId === 'string' && infos[0].browserContextId.length > 0, 'browserContextId=' + JSON.stringify(infos[0]));
    assert(typeof infos[0].browserContextId === 'string' && infos[0].browserContextId.length > 0, 'browserContextId=' + JSON.stringify(infos[0]));
    assert(infos[0].title === 'Title 42' && infos[0].url === 'https://x/', 'info=' + JSON.stringify(infos[0]));
    assert(calls.length === 0, 'must not forward Target.getTargets');
  });

  await t('Target.setDiscoverTargets -> {} + Target.targetCreated event', async () => {
    const { state } = mockState();
    const { reply, events } = await routeMessage(state, { id: 4, method: 'Target.setDiscoverTargets', params: { discover: true } });
    assert(reply.result && Object.keys(reply.result).length === 0, 'reply=' + JSON.stringify(reply));
    assert(events.length === 1 && events[0].method === 'Target.targetCreated', 'events=' + JSON.stringify(events));
    assert(events[0].params.targetInfo.targetId === 'page-42', 'event=' + JSON.stringify(events[0]));
  });

  await t('Target.attachToTarget -> sessionId + state.attached', async () => {
    const { state } = mockState();
    const { reply } = await routeMessage(state, { id: 5, method: 'Target.attachToTarget', params: { targetId: 'page-42', flatten: true } });
    assert(reply.result.sessionId === 'cdp-sess-1', 'reply=' + JSON.stringify(reply));
    assert(state.attached === true && state.sessionId === 'cdp-sess-1', 'state=' + JSON.stringify(state));
    const bad = await routeMessage(state, { id: 51, method: 'Target.attachToTarget', params: { targetId: 'nope' } });
    assert(bad.reply.error && bad.reply.error.code === -32000, 'bad=' + JSON.stringify(bad.reply));
  });

  await t('Target.setAutoAttach -> {} + one Target.attachedToTarget, sessionId routes page calls', async () => {
    const { state, calls, audits } = mockState();
    const { reply, events } = await routeMessage(state, {
      id: 40,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    });
    assert(reply.error === undefined && reply.result && Object.keys(reply.result).length === 0, 'reply=' + JSON.stringify(reply));
    assert(events.length === 1 && events[0].method === 'Target.attachedToTarget', 'events=' + JSON.stringify(events));
    const p = events[0].params;
    assert(p.targetInfo && p.targetInfo.targetId === 'page-42' && p.targetInfo.type === 'page' && typeof p.targetInfo.browserContextId === 'string' && p.targetInfo.browserContextId.length > 0, 'targetInfo=' + JSON.stringify(p.targetInfo));
    assert(p.waitingForDebugger === false, 'waitingForDebugger=' + p.waitingForDebugger);
    assert(state.attached === true && state.sessionId === 'cdp-sess-1', 'state=' + JSON.stringify({ attached: state.attached, sessionId: state.sessionId }));
    assert(p.sessionId === state.sessionId, 'event sessionId=' + p.sessionId);
    // the emitted sessionId must actually route a subsequent flat-session page call
    const page = await routeMessage(state, { id: 41, sessionId: p.sessionId, method: 'Runtime.evaluate', params: { expression: '1+1' } });
    assert(calls.length === 1 && calls[0][0] === 'Runtime.evaluate', 'calls=' + JSON.stringify(calls));
    assert(page.reply.sessionId === p.sessionId, 'routed reply sessionId=' + page.reply.sessionId);
    assert(!audits.some((a) => a.type === 'cdp-ws-deny'), 'unexpected deny: ' + JSON.stringify(audits));
  });

  await t('Target.setAutoAttach: page-level + repeat + autoAttach:false are silent no-ops', async () => {
    // page-level (sessionId present): Playwright sends these for OOPIF children - must not
    // re-announce our page session
    const a = mockState();
    const page = await routeMessage(a.state, { id: 60, sessionId: 'cdp-sess-1', method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
    assert(page.reply.error === undefined && page.events.length === 0, 'page-level=' + JSON.stringify(page));
    // browser-level: first call announces, a repeat must stay silent (idempotent)
    const b = mockState();
    const first = await routeMessage(b.state, { id: 61, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
    assert(first.events.length === 1, 'first=' + JSON.stringify(first.events));
    const again = await routeMessage(b.state, { id: 62, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
    assert(again.reply.error === undefined && again.events.length === 0, 'repeat=' + JSON.stringify(again));
    // autoAttach:false -> no attach, no event
    const c = mockState();
    const off = await routeMessage(c.state, { id: 63, method: 'Target.setAutoAttach', params: { autoAttach: false } });
    assert(off.reply.error === undefined && off.events.length === 0 && c.state.attached === false, 'off=' + JSON.stringify({ events: off.events, attached: c.state.attached }));
  });

  await t('resolveTargetId: real main-frame id, fallback on error/timeout', async () => {
    const ok = await resolveTargetId({ sendCommand: async () => ({ frameTree: { frame: { id: 'FRAME-1' } } }) }, 'page-9');
    assert(ok === 'FRAME-1', 'real=' + ok);
    const bad = await resolveTargetId({ sendCommand: async () => { throw new Error('boom'); } }, 'page-9');
    assert(bad === 'page-9', 'fallback=' + bad);
    const slow = await resolveTargetId({ sendCommand: () => new Promise(() => {}) }, 'page-9');
    assert(slow === 'page-9', 'timeout=' + slow);
  });

  await t('accept-and-ignore page-init methods answer {} without forwarding or deny', async () => {
    const methods = [
      ['Log.enable', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setGeolocationOverride', {}],
      ['Emulation.setEmulatedMedia', { media: '' }],
      ['Security.setIgnoreCertificateErrors', { ignore: false }],
      ['Browser.getWindowForTarget', { targetId: 'page-42' }],
    ];
    for (const [method, params] of methods) {
      const { state, calls, audits } = mockState();
      const { reply, events } = await routeMessage(state, { id: 42, method, params });
      assert(reply.error === undefined && reply.result !== undefined, method + ' reply=' + JSON.stringify(reply));
      assert(events.length === 0, method + ' events=' + JSON.stringify(events));
      assert(calls.length === 0 && audits.length === 0, method + ' forwarded/audited: ' + JSON.stringify({ calls, audits }));
    }
    const { reply } = await routeMessage(mockState().state, { id: 43, method: 'Browser.getWindowForTarget', params: { targetId: 'page-42' } });
    assert(reply.result.windowId === 1 && reply.result.bounds && reply.result.bounds.width === 0, 'window=' + JSON.stringify(reply));
  });

  await t('Browser.close still denied -> -32601 + cdp-ws-deny audit', async () => {
    const { state, calls, audits } = mockState();
    const { reply } = await routeMessage(state, { id: 44, method: 'Browser.close' });
    assert(reply.error && reply.error.code === -32601, 'reply=' + JSON.stringify(reply));
    assert(calls.length === 0, 'must not forward denied method');
    assert(audits.some((a) => a.type === 'cdp-ws-deny' && a.method === 'Browser.close'), 'audits=' + JSON.stringify(audits));
  });

  await t('page-level forward strips sessionId + re-adds it on the reply', async () => {
    const { state, calls } = mockState();
    const { reply } = await routeMessage(state, {
      id: 6,
      sessionId: 'cdp-sess-1',
      method: 'Runtime.evaluate',
      params: { expression: '1+1', sessionId: 'client-sess' },
    });
    assert(calls.length === 1 && calls[0][0] === 'Runtime.evaluate', 'calls=' + JSON.stringify(calls));
    assert(!('sessionId' in calls[0][1]), 'forwarded sessionId: ' + JSON.stringify(calls[0][1]));
    assert(calls[0][1].expression === '1+1', 'params=' + JSON.stringify(calls[0][1]));
    assert(reply.result.result.value === 'V', 'reply=' + JSON.stringify(reply));
    assert(reply.sessionId === 'cdp-sess-1', 'sessionId not re-added: ' + JSON.stringify(reply));
  });

  await t('Target.detachFromTarget clears attached/sessionId', async () => {
    const { state } = mockState();
    await routeMessage(state, { id: 7, method: 'Target.attachToTarget', params: { targetId: 'page-42' } });
    const { reply } = await routeMessage(state, { id: 8, method: 'Target.detachFromTarget' });
    assert(reply.result && state.attached === false && state.sessionId === null, 'state=' + JSON.stringify(state));
  });

  await t('denied control method -> -32601 + cdp-ws-deny audit', async () => {
    const { state, audits, calls } = mockState();
    const { reply } = await routeMessage(state, { id: 9, method: 'Target.createTarget', params: { url: 'about:blank' } });
    assert(reply.error && reply.error.code === -32601, 'reply=' + JSON.stringify(reply));
    assert(/Target\.createTarget/.test(reply.error.message), 'message=' + reply.error.message);
    assert(calls.length === 0, 'must not forward denied method');
    assert(audits.some((a) => a.type === 'cdp-ws-deny' && a.method === 'Target.createTarget'), 'audits=' + JSON.stringify(audits));
  });

  await t('eventMessage shape: sessionId omitted before attach, added after', async () => {
    const { state } = mockState();
    const before = eventMessage(state, 'Page.loadEventFired', {});
    assert(before.method === 'Page.loadEventFired' && !('sessionId' in before), 'before=' + JSON.stringify(before));
    state.sessionId = 'cdp-sess-1';
    const after = eventMessage(state, 'Page.loadEventFired', { a: 1 });
    assert(after.sessionId === 'cdp-sess-1' && after.params.a === 1, 'after=' + JSON.stringify(after));
  });

  // --- HTTP + upgrade gates over a real ephemeral listen ---
  const mockWc = { id: 7, getTitle: () => 'T', getURL: () => 'about:blank', getUserAgent: () => 'UA/1' };
  const cdp = createCdpWs({
    resolve: (id) => (id === 'default' || id === 'ok' ? { webContents: mockWc } : undefined),
    token: 'tk',
    port: 0,
    audit: () => {},
  });
  const srv = await cdp.start();
  try {
    await t('HTTP /json/version: no token -> 401', async () => {
      const res = await httpGet(srv.port, '/json/version?profile=ok');
      assert(res.status === 401, 'status=' + res.status);
    });

    await t('HTTP /json/version: evil Host -> 403', async () => {
      const res = await httpGet(srv.port, '/json/version?profile=ok', { Authorization: 'Bearer tk', Host: 'evil.com' });
      assert(res.status === 403, 'status=' + res.status);
    });

    await t('WS upgrade unknown profile -> 404', async () => {
      const status = await rawUpgrade(srv.port, '/api/cdp/nope?token=tk');
      assert(status === 404, 'status=' + status);
    });

    await t('HTTP /json/version: good token -> 200 with webSocketDebuggerUrl', async () => {
      const res = await httpGet(srv.port, '/json/version?profile=ok', { Authorization: 'Bearer tk' });
      assert(res.status === 200, 'status=' + res.status);
      const body = JSON.parse(res.body);
      assert(/^ws:\/\/127\.0\.0\.1:\d+\/api\/cdp\/ok\?token=tk$/.test(body.webSocketDebuggerUrl), 'url=' + body.webSocketDebuggerUrl);
      assert(body.Browser && body['Protocol-Version'] === '1.3', 'body=' + res.body);
      assert(body['User-Agent'] === 'UA/1', 'ua=' + body['User-Agent']);
    });

    await t('HTTP /json/list: one page target for a live profile', async () => {
      const res = await httpGet(srv.port, '/json/list?token=tk&profile=ok');
      assert(res.status === 200, 'status=' + res.status);
      const list = JSON.parse(res.body);
      assert(Array.isArray(list) && list.length === 1, 'list=' + res.body);
      assert(list[0].type === 'page' && list[0].id === 'page-7', 'target=' + JSON.stringify(list[0]));
    });

    await t('HTTP unknown route -> 404', async () => {
      const res = await httpGet(srv.port, '/nope?token=tk');
      assert(res.status === 404, 'status=' + res.status);
    });
  } finally {
    await srv.close();
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
