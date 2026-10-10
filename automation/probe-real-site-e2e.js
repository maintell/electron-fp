'use strict';
// ponytail: one-shot Electron e2e against a REAL local HTTP origin (127.0.0.1, ephemeral port):
// navigate -> login POST/302 -> read -> cookie -> storage -> download -> network ring.
// Closes testing.md §4 "真实站点 E2E" / acceptance #32; example.com is an optional
// graceful-skip internet check (no-network still exits 0). Driver evals use the
// default isolated world (stale-world fix in runtime/browser-session.js, 2026-09-26).
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('fs');
const { createElectronSession } = require('./electron/glue');
const { createPageDriver } = require('./electron/page');

let pass = 0;
let fail = 0;

function ok(name) {
  pass++;
  console.log('PASS ' + name);
}
function bad(name, err) {
  fail++;
  console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : String(err)));
}
function skip(name) {
  console.log('SKIP ' + name);
}

// design said "hello-e2e-42 (13 bytes)": the bare string is 12 bytes, so the LF makes it 13.
const DL_BODY = 'hello-e2e-42\n';
const DL_DIR = 'F:\\Temp\\e2e-dl-site';
const DL_SAVE = DL_DIR + '\\expected-dl.bin';
const PARTITION = 'persist:auto:e2e-site';

const FORM_HTML = [
  '<html><body>',
  '<form method="POST" action="/login">',
  '<input id="user" name="user" value="">',
  '<input id="pass" name="pass" value="">',
  '<button id="login" type="submit">login</button>',
  '</form>',
  '</body></html>',
].join('\n');
const HOME_HTML = [
  '<html><body>',
  '<div id="welcome">Hello alice</div>',
  '<a id="dl" href="/download">dl</a>',
  '</body></html>',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, headers, body) => {
      res.writeHead(code, headers);
      res.end(body);
    };
    if (req.method === 'GET' && u.pathname === '/') {
      return send(200, { 'Content-Type': 'text/html; charset=utf-8' }, FORM_HTML);
    }
    if (req.method === 'POST' && u.pathname === '/login') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const q = new URLSearchParams(body);
        if (q.get('user') === 'alice' && q.get('pass') === 'pw123') {
          return send(
            302,
            { 'Set-Cookie': 'sid=abc123; Path=/; HttpOnly', Location: '/home', 'Content-Length': '0' },
            ''
          );
        }
        return send(403, { 'Content-Type': 'text/plain' }, 'denied');
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/home') {
      return send(200, { 'Content-Type': 'text/html; charset=utf-8' }, HOME_HTML);
    }
    if (req.method === 'GET' && u.pathname === '/download') {
      return send(
        200,
        {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="hello.txt"',
          'Content-Length': String(Buffer.byteLength(DL_BODY)),
        },
        DL_BODY
      );
    }
    if (req.method === 'GET' && u.pathname === '/asset') {
      return send(200, { 'Content-Type': 'text/plain' }, 'x'.repeat(1024));
    }
    return send(404, { 'Content-Type': 'text/plain' }, 'nf');
  });
}

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch (_) {}
    }
  } catch (_) {}
}

async function main() {
  await app.whenReady();

  const hardKill = setTimeout(() => {
    try {
      console.log('FAIL harness-timeout :: 150s budget exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 150000);
  if (hardKill.unref) hardKill.unref();

  const server = createServer();
  let win = null;
  let es = null;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const BASE = 'http://127.0.0.1:' + port;

    if (port > 0 && server.listening) ok('local HTTP server listening on 127.0.0.1:' + port);
    else bad('local HTTP server listening', new Error('port=' + port + ' listening=' + server.listening));

    try {
      fs.rmSync(DL_DIR, { recursive: true, force: true });
    } catch (_) {}

    win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    es = createElectronSession({ webContents: win.webContents, profileId: 'e2e-site' });
    await es.start();
    // Driver evals run in the DEFAULT isolated world: browser-session.js now invalidates its
    // cached worldContextId on navigation and self-heals a stale contextId once, so the
    // __world:'main' probe workaround (2026-09-26) was removed.
    const d = createPageDriver({ webContents: win.webContents, session: es.session, adapter: es.adapter, rng: es.rng });
    await d.enableNetwork(); // ring only fills after Network.enable

    async function evalValue(expression) {
      const res = await es.session.sendCommand('Runtime.evaluate', { expression, returnByValue: true });
      return res && res.result ? res.result.value : undefined;
    }

    // b. load form page
    try {
      await d.goto(BASE + '/', { timeoutMs: 15000 });
      await d.waitForSelector('#user', { timeoutMs: 10000 });
      ok('goto local HTTP origin, form visible');
    } catch (e) {
      bad('goto local HTTP origin, form visible', e);
    }

    // c. login: fill + submit, nav follows 302 to /home
    try {
      await d.fill('#user', 'alice');
      await d.fill('#pass', 'pw123');
      await d.click('#login');
      await d.waitForURL('/home', { timeoutMs: 15000 });
      ok('login POST -> 302 -> /home');
    } catch (e) {
      bad('login POST -> 302 -> /home', e);
    }

    // d. read welcome text
    try {
      await d.waitForSelector('#welcome', { timeoutMs: 10000 });
      const t = await d.getText('#welcome');
      if (String(t).includes('alice')) ok('welcome text contains alice (' + JSON.stringify(t) + ')');
      else bad('welcome text contains alice', new Error('text=' + JSON.stringify(t)));
    } catch (e) {
      bad('welcome text contains alice', e);
    }

    // e. cookie visible + scoped to the HTTP origin (not opaque)
    try {
      const cs = await d.cookies.get({});
      const sid = cs.find((c) => c.name === 'sid' && c.value === 'abc123');
      const scoped =
        sid && (String(sid.domain || '').includes('127.0.0.1') || String(sid.url || '').includes('127.0.0.1'));
      if (scoped) ok('cookie sid=abc123 scoped to 127.0.0.1 (domain=' + (sid.domain || sid.url) + ')');
      else bad('cookie sid=abc123 scoped to 127.0.0.1', new Error('sid=' + JSON.stringify(sid)));
    } catch (e) {
      bad('cookie sid=abc123 scoped to 127.0.0.1', e);
    }

    // f. storage survives a reload (page.js has no reload primitive; same-URL goto is the reload)
    try {
      await d.storageSet('e2e-k', 'v1');
      await d.goto(BASE + '/home', { timeoutMs: 15000 });
      await d.waitForSelector('#welcome', { timeoutMs: 10000 });
      const v = await d.storageGet('e2e-k');
      if (v === 'v1') ok('localStorage survives reload on http origin');
      else bad('localStorage survives reload on http origin', new Error('value=' + JSON.stringify(v)));
    } catch (e) {
      bad('localStorage survives reload on http origin', e);
    }

    // g. download via clicking the attachment link.
    // diag (run 2): with Page.setDownloadBehavior('allow', downloadPath) active, Electron
    // ignores DownloadItem.setSavePath — the file lands at downloadDir/suggestedFilename.
    // Probe asserts the artifact either way; the smoke probe could not see this because its
    // savePath happened to equal downloadDir + suggested name.
    try {
      fs.rmSync(DL_DIR, { recursive: true, force: true });
      fs.mkdirSync(DL_DIR, { recursive: true });
      const r = await d.download({
        trigger: () => d.click('#dl'),
        savePath: DL_SAVE,
        downloadDir: DL_DIR,
        timeoutMs: 20000,
      });
      const candidates = [DL_SAVE, DL_DIR + '\\hello.txt'];
      const used = candidates.find((p) => fs.existsSync(p));
      const size = used ? fs.statSync(used).size : -1;
      const content = used ? fs.readFileSync(used, 'utf8') : '';
      if (r.state === 'completed' && used && size === 13 && content === DL_BODY) {
        ok('download saved 13 bytes (path=' + used + ')');
        if (used !== DL_SAVE) console.log('NOTE DownloadItem.setSavePath ignored; file at downloadDir/suggestedFilename');
      } else {
        bad(
          'download saved 13 bytes',
          new Error('state=' + r.state + ' used=' + used + ' size=' + size + ' content=' + JSON.stringify(content))
        );
      }
    } catch (e) {
      bad('download saved 13 bytes', e);
    }

    // h. network ring saw the flow (>=3 events incl /login and /home) + /asset fetched
    try {
      await es.session.sendCommand('Runtime.evaluate', {
        expression: "fetch('/asset').then(r => r.status)",
        awaitPromise: true,
        returnByValue: true,
      });
      await sleep(500);
      const ring = d.recentRequests();
      const urls = ring.map((r) => String(r.url));
      const hasLogin = urls.some((u) => u.includes('/login'));
      const hasHome = urls.some((u) => u.includes('/home'));
      if (ring.length >= 3 && hasLogin && hasHome) ok('network ring ' + ring.length + ' events incl /login + /home');
      else bad('network ring events incl /login + /home', new Error('n=' + ring.length + ' urls=' + JSON.stringify(urls)));
      if (urls.some((u) => u.includes('/asset'))) ok('network ring saw /asset');
      else bad('network ring saw /asset', new Error('urls=' + JSON.stringify(urls)));
    } catch (e) {
      bad('network ring events incl /login + /home', e);
    }

    // i. screenshot bytes > 1000 (hidden window: page.js retries until a frame exists)
    try {
      const shot = await d.screenshot();
      if (shot.bytes > 1000) ok('screenshot bytes>1000 (' + shot.bytes + ')');
      else bad('screenshot bytes>1000', new Error('bytes=' + shot.bytes));
    } catch (e) {
      bad('screenshot bytes>1000', e);
    }

    // j. wrong password: server 403, page must NOT be /home
    try {
      await d.goto(BASE + '/', { timeoutMs: 15000 });
      await d.waitForSelector('#user', { timeoutMs: 10000 });
      await d.fill('#user', 'alice');
      await d.fill('#pass', 'wrong');
      await d.click('#login');
      const t0 = Date.now();
      let path = '';
      for (;;) {
        path = String(await evalValue('location.pathname'));
        if (path.includes('/login')) break;
        if (Date.now() - t0 > 8000) break;
        await sleep(100);
      }
      if (path.includes('/login') && !path.includes('/home')) ok('wrong password stays on /login (403)');
      else bad('wrong password stays on /login (403)', new Error('pathname=' + path));
    } catch (e) {
      bad('wrong password stays on /login (403)', e);
    }

    // k. optional real internet (graceful skip keeps exit 0)
    try {
      await d.goto('https://example.com', { timeoutMs: 15000 });
      // goto can resolve on a late load event from the previous page (run 2: bogus
      // "empty title" at the local URL); confirm the commit before reading the title.
      let href = '';
      const t0k = Date.now();
      for (;;) {
        href = String(await evalValue('location.href'));
        if (href.includes('example.com')) break;
        if (Date.now() - t0k > 10000) break;
        await sleep(100);
      }
      if (!href.includes('example.com')) {
        throw Object.assign(new Error('navigation did not commit: ' + href), { name: 'NetworkError' });
      }
      const title = String(await evalValue('document.title'));
      if (title.length > 0) ok('real internet https ok (title len=' + title.length + ')');
      else bad('real internet https ok', new Error('empty title url=' + href));
    } catch (e) {
      skip('real-internet (no network: ' + ((e && e.name) || 'Error') + ': ' + ((e && e.message) || e) + ')');
    }

    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await sleep(300); // let piped stdout flush before exit
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
  } finally {
    try {
      clearTimeout(hardKill);
    } catch (_) {}
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close();
    } catch (_) {}
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try {
      app.exit(process.exitCode);
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000);
  }
}

main();
