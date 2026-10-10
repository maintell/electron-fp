'use strict';
// Smoke test for @fp-automation/browser:
//  1. surface  — the layer loads and every namespace.method from automation.d.ts exists
//  2. round-trip (record) — one call is captured + returned by the transport
//  3. round-trip (loopback) — composed ops become a script submitted via
//     @fp-automation/core to the real server (create -> saveVersion -> read back)
// PASS/FAIL lines; exit 0 == the browser layer works end-to-end.
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createAutomationServer } = require('../../../automation/bin/serve.js');
const { connect } = require('../../core/index.js');
const { createBrowserLayer, recordTransport, createComposer, submitVia, METHODS, methodCount } = require('../index.js');

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

(async () => {
  // 1. surface
  const rec = recordTransport();
  const layer = createBrowserLayer({ transport: rec });
  t('layer loads', !!layer && typeof layer.browser.goto === 'function');
  const missing = [];
  for (const ns of Object.keys(METHODS)) {
    const parts = ns.split('.');
    const target = parts.length === 2 ? layer[parts[0]] && layer[parts[0]][parts[1]] : layer[ns];
    if (!target) {
      missing.push(ns);
      continue;
    }
    for (const m of METHODS[ns]) if (typeof target[m] !== 'function') missing.push(ns + '.' + m);
  }
  t('all ' + methodCount() + ' namespace methods exist', missing.length === 0, missing.join(','));

  // 2. record round-trip
  const r = await layer.browser.goto('https://example.com');
  t(
    'browser.goto captured by transport',
    rec.calls.length === 1 && rec.calls[0].ns === 'browser' && rec.calls[0].method === 'goto' && rec.calls[0].args[0] === 'https://example.com'
  );
  t('browser.goto returned transport result', !!r && r.ok === true && r.method === 'goto');
  const c = await layer.cookies.clear();
  t('cookies.clear round-trips (2nd call captured)', rec.calls.length === 2 && rec.calls[1].ns === 'cookies' && !!c);

  // 3. loopback round-trip: compose -> script -> submit via sdk/core to serve.js
  const TOKEN = 'sdk-browser-smoke-token';
  const storeFile = path.join(os.tmpdir(), 'fp-sdk-browser-smoke-' + Date.now() + '.json');
  const srv = createAutomationServer({ port: 0, token: TOKEN, storeFile });
  let info = null;
  try {
    info = await srv.start();
    const client = await connect({ url: info.url, token: info.token });
    const composer = createComposer();
    composer.invoke('browser', 'goto', ['https://example.com']);
    composer.invoke('cookies', 'clear', []);
    const res = await submitVia(client, composer, { name: 'sdk-browser-smoke' });
    t('composed script submitted over loopback (id)', !!res.scriptId);
    t('stored script retrievable + id matches', !!res.stored && res.stored.id === res.scriptId, JSON.stringify(res.stored));
    t('composed script contains the ops', /browser\.goto\(/.test(res.code) && /cookies\.clear\(/.test(res.code));
    await client.close();
  } finally {
    try {
      await srv.stop();
    } catch (_) {}
    try {
      fs.unlinkSync(storeFile);
    } catch (_) {}
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
  const safety = setTimeout(() => process.exit(process.exitCode), 2000);
  if (typeof safety.unref === 'function') safety.unref();
})().catch((e) => {
  fail++;
  console.log('FAIL smoke threw :: ' + ((e && e.stack) || e));
  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(1);
});
