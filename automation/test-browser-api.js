'use strict';
// ponytail: facade unit test over a mock driver — proves 1:1 mapping + cookie delegation without Electron.
const assert = require('assert');
const { createBrowserApi } = require('./electron/browser-api');

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

const PAGE_METHODS = [
  'click',
  'fill',
  'type',
  'press',
  'waitForSelector',
  'waitForText',
  'waitForURL',
  'waitForFunction',
  'getText',
  'getAttribute',
  'getValue',
];
const OMITTED = [
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.close',
  'browser.getTitle',
  'browser.getCurrentUrl',
  // page.evaluate / page.getCurrentUrl / network.enable are conditional pass-throughs now:
  // see the "delegate 1:1 when driver provides" + "omitted when driver lacks" checks below.
  'page.locator',
  'page.waitForVisible',
  'page.waitForHidden',
  'page.waitForNavigation',
  'page.waitForNetworkIdle',
  'page.waitForResponse',
  'page.waitForRequest',
];

function mockDriver() {
  const calls = [];
  const rec = (name) => (...args) => {
    calls.push([name, args]);
    return Promise.resolve('r:' + name);
  };
  return {
    calls,
    goto: rec('goto'),
    click: rec('click'),
    fill: rec('fill'),
    type: rec('type'),
    press: rec('press'),
    waitForSelector: rec('waitForSelector'),
    waitForText: rec('waitForText'),
    waitForURL: rec('waitForURL'),
    waitForFunction: rec('waitForFunction'),
    getText: rec('getText'),
    getAttribute: rec('getAttribute'),
    getValue: rec('getValue'),
    screenshot: async (...args) => {
      calls.push(['screenshot', args]);
      return { data: Buffer.from('shot-bytes').toString('base64'), bytes: 10 };
    },
    storageGet: rec('storageGet'),
    storageSet: rec('storageSet'),
    enableNetwork: rec('enableNetwork'),
    recentRequests: (...args) => {
      calls.push(['recentRequests', args]);
      return [{ url: 'u1' }];
    },
    cookies: { get: rec('driverCookies.get'), set: rec('driverCookies.set'), remove: rec('driverCookies.remove') },
  };
}

function mockElectronSession() {
  const calls = [];
  return {
    calls,
    cookies: {
      get: (f) => {
        calls.push(['cookies.get', f]);
        return Promise.resolve([{ name: 'a' }]);
      },
      set: (c) => {
        calls.push(['cookies.set', c]);
        return Promise.resolve();
      },
      remove: (u, n) => {
        calls.push(['cookies.remove', u, n]);
        return Promise.resolve();
      },
    },
    clearStorageData: (o) => {
      calls.push(['clearStorageData', o]);
      return Promise.resolve();
    },
  };
}

(async () => {
  await t('throws without page driver', async () => {
    assert.throws(() => createBrowserApi({}), /page driver required/);
  });

  await t('page methods map 1:1 onto driver names/args', async () => {
    const d = mockDriver();
    const api = createBrowserApi({ page: d });
    for (const m of PAGE_METHODS) {
      const r = await api.page[m]('sel', 'arg2');
      assert.strictEqual(r, 'r:' + m, m + ' result');
      const last = d.calls[d.calls.length - 1];
      assert.deepStrictEqual(last, [m, ['sel', 'arg2']], m + ' forwarded');
    }
  });

  await t('browser.goto forwards to driver.goto', async () => {
    const d = mockDriver();
    const api = createBrowserApi({ page: d });
    await api.browser.goto('file:///x.html', { timeoutMs: 1 });
    assert.deepStrictEqual(d.calls, [['goto', ['file:///x.html', { timeoutMs: 1 }]]]);
  });

  await t('browser.screenshot returns Buffer from {data:base64}', async () => {
    const d = mockDriver();
    const api = createBrowserApi({ page: d });
    const buf = await api.browser.screenshot();
    assert.ok(Buffer.isBuffer(buf), 'Buffer returned');
    assert.strictEqual(buf.toString('utf8'), 'shot-bytes');
  });

  await t('cookies delegate to electronSession spies with exact args', async () => {
    const d = mockDriver();
    const es = mockElectronSession();
    const api = createBrowserApi({ page: d, electronSession: es });
    const got = await api.cookies.get({ name: 'a' });
    assert.deepStrictEqual(got, [{ name: 'a' }]);
    await api.cookies.set({ url: 'https://x/', name: 'n', value: 'v' });
    await api.cookies.remove('https://x/', 'n');
    await api.cookies.clear();
    assert.deepStrictEqual(es.calls, [
      ['cookies.get', { name: 'a' }],
      ['cookies.set', { url: 'https://x/', name: 'n', value: 'v' }],
      ['cookies.remove', 'https://x/', 'n'],
      ['clearStorageData', { storages: ['cookies'] }],
    ]);
  });

  await t('cookies.get without filter passes {} (not undefined)', async () => {
    const es = mockElectronSession();
    const api = createBrowserApi({ page: mockDriver(), electronSession: es });
    await api.cookies.get();
    assert.deepStrictEqual(es.calls[0], ['cookies.get', {}]);
  });

  await t('cookies fall back to driver without electronSession; clear throws', async () => {
    const d = mockDriver();
    const api = createBrowserApi({ page: d });
    await api.cookies.get({ name: 'z' });
    await api.cookies.set({ name: 'z', value: '1' });
    await api.cookies.remove('https://x/', 'z');
    assert.deepStrictEqual(d.calls, [
      ['driverCookies.get', [{ name: 'z' }]],
      ['driverCookies.set', [{ name: 'z', value: '1' }]],
      ['driverCookies.remove', ['https://x/', 'z']],
    ]);
    assert.throws(() => api.cookies.clear(), /requires electronSession/);
  });

  await t('storage get/set forward to page.storageGet/storageSet', async () => {
    const d = mockDriver();
    const api = createBrowserApi({ page: d });
    await api.storage.set('k', 'v');
    await api.storage.get('k');
    assert.deepStrictEqual(d.calls, [
      ['storageSet', ['k', 'v']],
      ['storageGet', ['k']],
    ]);
  });

  await t('network.recent forwards to page.recentRequests', async () => {
    const d = mockDriver();
    const api = createBrowserApi({ page: d });
    assert.deepStrictEqual(api.network.recent(), [{ url: 'u1' }]);
    assert.deepStrictEqual(d.calls, [['recentRequests', []]]);
  });

  await t('profileContext passthrough is readonly copy', async () => {
    const api = createBrowserApi({ page: mockDriver(), profileContext: { id: 'p1', nested: { a: 1 } } });
    assert.strictEqual(api.profileContext.id, 'p1');
    assert.ok(Object.isFrozen(api.profileContext), 'frozen');
    assert.throws(() => {
      'use strict';
      api.profileContext.id = 'p2';
    }, TypeError);
  });

  await t('page.evaluate/getCurrentUrl delegate 1:1 when driver provides them', async () => {
    const d = mockDriver();
    d.evaluate = (...args) => {
      d.calls.push(['evaluate', args]);
      return Promise.resolve('html');
    };
    d.getCurrentUrl = (...args) => {
      d.calls.push(['getCurrentUrl', args]);
      return Promise.resolve('file:///x.html');
    };
    const api = createBrowserApi({ page: d });
    assert.strictEqual(await api.page.evaluate('document.documentElement.outerHTML'), 'html');
    assert.strictEqual(await api.page.getCurrentUrl(), 'file:///x.html');
    assert.deepStrictEqual(d.calls, [
      ['evaluate', ['document.documentElement.outerHTML']],
      ['getCurrentUrl', []],
    ]);
  });

  await t('page.evaluate/getCurrentUrl omitted when driver lacks them', async () => {
    const api = createBrowserApi({ page: mockDriver() });
    assert.strictEqual(api.page.evaluate, undefined, 'evaluate absent');
    assert.strictEqual(api.page.getCurrentUrl, undefined, 'getCurrentUrl absent');
  });

  await t('network.enable forwards to page.enableNetwork', async () => {
    const d = mockDriver();
    const api = createBrowserApi({ page: d });
    assert.strictEqual(await api.network.enable(), 'r:enableNetwork');
    assert.deepStrictEqual(d.calls, [['enableNetwork', []]]);
  });

  await t('upload/download fence: inside-dir passes, escape/null/absent deny PermissionError', async () => {
    const path = require('path');
    const dir = 'F:\\Temp\\fence-test';
    const d = mockDriver();
    d.upload = async (sel, files) => ({ selector: sel, files });
    d.download = async (opts) => ({ savePath: opts.savePath });
    const api = createBrowserApi({ page: d, fences: { dirs: [dir] } });
    const ok = await api.upload.setFiles('#f', [dir + '\\a.txt']);
    assert.deepStrictEqual(ok.files, [path.normalize(dir + '\\a.txt')], 'inside passes');
    await assert.rejects(api.upload.setFiles('#f', ['F:\\Temp\\other\\x.txt']), /outside authorized/, 'absolute escape denied');
    await assert.rejects(api.upload.setFiles('#f', [dir + '\\..\\other\\x.txt']), /outside authorized/, 'traversal denied');
    await assert.rejects(api.upload.setFiles('#f', ['a\0b']), /null byte/, 'null denied');
    await assert.rejects(api.upload.setFiles('#f', []), /non-empty array/, 'empty denied');
    const noFence = createBrowserApi({ page: mockDriver() });
    await assert.rejects(noFence.upload.setFiles('#f', ['a.txt']), /no authorized directory/, 'absent fence fail-closed');
    await assert.rejects(api.upload.setFiles('#f', ['F:\\evil\\x']), /outside/, 'async shape denies too');
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  for (const name of OMITTED) console.log('SKIP ' + name + ' (driver lacks primitive)');
  process.exitCode = fail > 0 ? 1 : 0;
})();
