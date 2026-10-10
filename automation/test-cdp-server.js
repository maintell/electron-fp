// ponytail: unit tests for the Electron-host CDP-WS wrapper over a mock launcher.
// No debugger attach here — urlFor/publish/discovery are exercised over a real ephemeral listen.
'use strict';

const http = require('http');
const { createProfileCdpServer } = require('./electron/cdp-server');

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

const TOKEN = 'tk-unit';

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
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
  });
}

function mockLauncher() {
  const known = { p1: { webContents: { id: 1 } }, p2: { webContents: { id: 2 } } };
  return {
    known,
    acquire: (id) => known[id],
    list: () => Object.keys(known),
  };
}

(async () => {
  const published = [];
  const launcher = mockLauncher();
  const srv = createProfileCdpServer({ launcher, token: TOKEN, onUrl: (id, url) => published.push([id, url]) });
  let started = null;

  await t('start(): port>0 + baseUrl; auto-publishes every launched profile', async () => {
    started = await srv.start();
    assert(started.port > 0, 'port=' + started.port);
    assert(started.baseUrl === 'ws://127.0.0.1:' + started.port, 'baseUrl=' + started.baseUrl);
    assert(published.length === 2, 'published=' + JSON.stringify(published));
    assert(published[0][0] === 'p1' && published[1][0] === 'p2', 'fan-out order');
  });

  await t('urlFor matches the cdp-ws /json/version convention exactly', async () => {
    const expected = 'ws://127.0.0.1:' + started.port + '/api/cdp/p1?token=' + encodeURIComponent(TOKEN);
    assert(srv.urlFor('p1') === expected, 'urlFor=' + srv.urlFor('p1') + ' expected=' + expected);
    const res = await httpGet(started.port, '/json/version?profile=p1&token=' + TOKEN);
    assert(res.status === 200, 'status=' + res.status);
    assert(res.body.webSocketDebuggerUrl === expected, 'advertised=' + res.body.webSocketDebuggerUrl);
  });

  await t('publish(id) calls onUrl with urlFor(id)', async () => {
    published.length = 0;
    const ok = srv.publish('p2');
    assert(ok === true, 'publish returned ' + ok);
    assert(published.length === 1 && published[0][0] === 'p2', JSON.stringify(published));
    assert(published[0][1] === srv.urlFor('p2'), 'url mismatch');
  });

  await t('publishAll() fans out over launcher.list()', async () => {
    published.length = 0;
    const n = srv.publishAll();
    assert(n === 2 && published.length === 2, 'n=' + n + ' published=' + published.length);
  });

  await t('unknown profile: discovery 404 (resolve undefined, no throw)', async () => {
    const res = await httpGet(started.port, '/json/version?profile=nope&token=' + TOKEN);
    assert(res.status === 404, 'status=' + res.status);
    const list = await httpGet(started.port, '/json/list?profile=nope&token=' + TOKEN);
    assert(list.status === 200 && Array.isArray(list.body) && list.body.length === 0, 'list=' + JSON.stringify(list));
  });

  await t('stop(): closes listener, idempotent; port refused afterwards', async () => {
    await srv.stop();
    await srv.stop();
    let refused = false;
    try {
      await httpGet(started.port, '/json/version?profile=p1&token=' + TOKEN);
    } catch (_) {
      refused = true;
    }
    assert(refused, 'listener still accepting after stop');
  });

  await t('no onUrl: publish() returns false, start/stop still fine', async () => {
    const l2 = mockLauncher();
    const s2 = createProfileCdpServer({ launcher: l2, token: TOKEN });
    assert(s2.publish('p1') === false, 'publish without onUrl');
    const st = await s2.start();
    assert(st.port > 0, 'port=' + st.port);
    await s2.stop();
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL harness :: ' + ((e && e.stack) || e));
  process.exit(1);
});
