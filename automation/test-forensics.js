'use strict';
// §16 failure-forensics unit suite: runner trace capture over a mock browserApi.
// Covers byte cap, missing-API degradation, network tail cap, URL precedence/fallback,
// SUCCESS cleanliness and TIMEOUT parity. No Electron, no frameworks.
const { createScriptRunner, buildTrace } = require('./runtime/script-runner');

let pass = 0;
let fail = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log('PASS ' + name);
    })
    .catch((err) => {
      fail++;
      console.log('FAIL ' + name + ' :: ' + err.message);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function spec(over) {
  return Object.assign(
    {
      id: 'f1',
      name: 'forensics',
      version: '1.0.0',
      code: '',
      permissions: { browser: true },
      profileContext: { id: 'p1', name: 'P1' },
    },
    over
  );
}

function api(over) {
  return Object.assign(
    {
      browser: { screenshot: async () => Buffer.from('png') },
      page: { evaluate: async () => '<html></html>', getCurrentUrl: async () => 'https://x/' },
      network: { recent: () => [] },
    },
    over
  );
}

async function main() {
  await check('failure captures trace: html + network + url, all sources true', async () => {
    const r = createScriptRunner({
      browserApi: api({
        page: { evaluate: async () => '<html><body>MARK</body></html>', getCurrentUrl: async () => 'https://site/p' },
        network: { recent: () => [{ url: 'https://site/p', ts: 7 }] },
      }),
    });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.trace, 'trace missing');
    assert(rec.trace.sources.html && rec.trace.sources.network && rec.trace.sources.url, 'sources: ' + JSON.stringify(rec.trace.sources));
    assert(rec.trace.html.includes('MARK'), 'html: ' + rec.trace.html);
    assert(rec.trace.url === 'https://site/p', 'url: ' + rec.trace.url);
    assert(rec.trace.network.length === 1 && rec.trace.network[0].url === 'https://site/p', 'network: ' + JSON.stringify(rec.trace.network));
    assert(typeof rec.trace.ts === 'number', 'ts missing');
    assert(rec.artifacts.length === 1 && rec.artifacts[0].kind === 'screenshot', 'screenshot artifact kept');
  });

  await check('html byte cap: >262144 truncates, htmlTruncated true, htmlBytes == cap', async () => {
    const big = '<html>' + 'a'.repeat(300000) + '</html>';
    const r = createScriptRunner({ browserApi: api({ page: { evaluate: async () => big, getCurrentUrl: async () => 'u' } }) });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.trace.htmlTruncated === true, 'htmlTruncated: ' + rec.trace.htmlTruncated);
    assert(Buffer.byteLength(rec.trace.html, 'utf8') === 262144, 'bytes: ' + Buffer.byteLength(rec.trace.html, 'utf8'));
    assert(rec.trace.htmlBytes === 262144, 'htmlBytes: ' + rec.trace.htmlBytes);
    assert(rec.trace.sources.html === true, 'sources.html');
  });

  await check('html exactly at cap: not truncated', async () => {
    const exact = 'b'.repeat(262144);
    const r = createScriptRunner({ browserApi: api({ page: { evaluate: async () => exact, getCurrentUrl: async () => 'u' } }) });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.trace.htmlTruncated === false, 'truncated: ' + rec.trace.htmlTruncated);
    assert(rec.trace.htmlBytes === 262144, 'bytes: ' + rec.trace.htmlBytes);
  });

  await check('missing page.evaluate → sources.html false, no throw, record settles FAILED', async () => {
    const r = createScriptRunner({ browserApi: api({ page: { getCurrentUrl: async () => 'u' } }) });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.trace.sources.html === false, 'sources.html: ' + rec.trace.sources.html);
    assert(rec.trace.html === undefined, 'html should be omitted: ' + JSON.stringify(rec.trace.html));
  });

  await check('evaluate throwing → sources.html false, no throw', async () => {
    const r = createScriptRunner({
      browserApi: api({ page: { evaluate: async () => { throw new Error('no page'); }, getCurrentUrl: async () => 'u' } }),
    });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.status === 'FAILED', 'status: ' + rec.status);
    assert(rec.trace.sources.html === false, 'sources.html: ' + rec.trace.sources.html);
  });

  await check('evaluate returning non-string → html omitted', async () => {
    const r = createScriptRunner({ browserApi: api({ page: { evaluate: async () => 42, getCurrentUrl: async () => 'u' } }) });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.trace.sources.html === false, 'sources.html: ' + rec.trace.sources.html);
    assert(rec.trace.html === undefined, 'html omitted');
  });

  await check('network.recent captured + capped at last 50', async () => {
    const many = Array.from({ length: 120 }, (_v, i) => ({ url: 'u' + i, ts: i }));
    const r = createScriptRunner({ browserApi: api({ network: { recent: () => many } }) });
    const rec = await r.run(spec({ code: "throw new Error('boom');" }));
    assert(rec.trace.network.length === 50, 'len: ' + rec.trace.network.length);
    assert(rec.trace.network[0].url === 'u70' && rec.trace.network[49].url === 'u119', 'tail: ' + rec.trace.network[0].url + '..' + rec.trace.network[49].url);
    assert(rec.trace.sources.network === true, 'sources.network');
  });

  await check('missing/throwing network.recent → sources.network false', async () => {
    const r1 = createScriptRunner({ browserApi: api({ network: {} }) });
    const a = await r1.run(spec({ code: "throw new Error('boom');" }));
    assert(a.trace.sources.network === false, 'missing: ' + a.trace.sources.network);
    const r2 = createScriptRunner({ browserApi: api({ network: { recent: () => { throw new Error('x'); } } }) });
    const b = await r2.run(spec({ code: "throw new Error('boom');" }));
    assert(b.trace.sources.network === false, 'throwing: ' + b.trace.sources.network);
    assert(Array.isArray(b.trace.network) && b.trace.network.length === 0, 'network stays []');
  });

  await check('buildTrace: getCurrentUrl wins; falls back to currentUrl; else url false', async () => {
    const live = await buildTrace({ browserApi: { page: { getCurrentUrl: async () => 'https://live/' } }, currentUrl: 'https://record/' });
    assert(live.url === 'https://live/' && live.sources.url === true, 'precedence: ' + live.url);
    const fb = await buildTrace({ browserApi: { page: {} }, currentUrl: 'https://record/' });
    assert(fb.url === 'https://record/' && fb.sources.url === true, 'fallback: ' + fb.url);
    const none = await buildTrace({ browserApi: { page: {} }, currentUrl: null });
    assert(none.url === null && none.sources.url === false, 'none: ' + JSON.stringify(none));
  });

  await check('SUCCESS leaves trace undefined and artifacts empty', async () => {
    const r = createScriptRunner({ browserApi: api() });
    const rec = await r.run(spec({ code: 'return 1;' }));
    assert(rec.status === 'SUCCESS', 'status: ' + rec.status);
    assert(rec.trace === undefined, 'trace should be absent: ' + JSON.stringify(rec.trace));
    assert(Array.isArray(rec.artifacts) && rec.artifacts.length === 0, 'artifacts empty');
  });

  await check('TIMEOUT also captures trace', async () => {
    const r = createScriptRunner({ browserApi: api(), timeoutMs: 150 });
    const rec = await r.run(spec({ code: 'await new Promise(() => {});' }));
    assert(rec.status === 'TIMEOUT', 'status: ' + rec.status);
    assert(rec.trace && rec.trace.sources.html === true, 'trace on timeout: ' + JSON.stringify(rec.trace && rec.trace.sources));
  });

  await check('CANCELLED captures no trace', async () => {
    const r = createScriptRunner({ browserApi: api() });
    r.cancel();
    const rec = await r.run(spec({ code: "throw new Error('x');" }));
    assert(rec.status === 'CANCELLED', 'status: ' + rec.status);
    assert(rec.trace === undefined, 'no trace on cancel');
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + e.message);
  process.exit(1);
});
