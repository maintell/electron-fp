'use strict';
// Smoke test for @fp-automation/core: start the real automation server
// IN-PROCESS (serve.js is node-safe; no child process needed), then connect via
// the SDK, do the capability handshake, and run real calls over HTTP + WS.
// PASS/FAIL lines (repo test convention). exit 0 == SDK core works end-to-end.
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createAutomationServer } = require('../../../automation/bin/serve.js');
const { connect, errors } = require('../index.js');

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
  const TOKEN = 'sdk-core-smoke-token';
  const storeFile = path.join(os.tmpdir(), 'fp-sdk-core-smoke-' + Date.now() + '.json');
  const srv = createAutomationServer({ port: 0, token: TOKEN, storeFile });
  let info = null;
  try {
    info = await srv.start();
    t('server started (loopback url)', !!info && /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url), info && info.url);

    const client = await connect({ url: info.url, token: info.token, required: ['store'] });

    t('handshake returns capabilities', !!client.capabilities && typeof client.capabilities === 'object');
    t('capability: store wired', client.capabilities.store === true);
    t('handshake required-check passes for [store]', true);

    const st = await client.status();
    t('HTTP status service=automation', st && st.service === 'automation', JSON.stringify(st));

    const list = await client.scripts.list();
    t('HTTP scripts.list returns a value', list !== undefined && list !== null);

    // error mapping: a missing script must raise the mapped SDK error class.
    let mapped = null;
    try {
      await client.scripts.get('does-not-exist');
    } catch (e) {
      mapped = e;
    }
    t('error mapping NOT_FOUND -> NotFoundError', !!mapped && mapped.name === 'NotFoundError', mapped && mapped.name);
    t('error is instanceof errors.NotFoundError', mapped instanceof errors.NotFoundError);

    // WS transport: connect + RPC round-trip.
    const wsr = await client.ws.call('status', {});
    t('WS RPC status ok', !!wsr && wsr.service === 'automation', JSON.stringify(wsr));

    // create -> list round-trip proves a real write path over the SDK.
    const created = await client.scripts.create({ name: 'sdk-smoke-script' });
    t('HTTP scripts.create returns id', !!created && !!created.id, JSON.stringify(created));
    const listed = await client.scripts.list();
    const items = Array.isArray(listed) ? listed : listed && listed.items;
    t('created script visible in list', !!items && items.some((s) => s && s.id === created.id));

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
  // Drain pending handles, then force-exit as a safety. Setting exitCode and
  // letting the loop drain avoids a libuv teardown race; the unref'd timer only
  // fires if some handle still keeps the loop alive.
  process.exitCode = fail === 0 ? 0 : 1;
  const safety = setTimeout(() => process.exit(process.exitCode), 2000);
  if (typeof safety.unref === 'function') safety.unref();
})().catch((e) => {
  fail++;
  console.log('FAIL smoke threw :: ' + ((e && e.stack) || e));
  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(1);
});
