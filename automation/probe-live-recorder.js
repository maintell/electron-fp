'use strict';
// ponytail: real-binary E2E for live RPA recording — capture real page events into an AST,
// then REPLAY that AST through rpa-ast.runAst against the same driver. Proves §13 Record→Replay.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { createElectronSession } = require('./electron/glue');
const { createPageDriver } = require('./electron/page');
const { createLiveRecorder } = require('./electron/recorder');
const { runAst, createAst } = require('./runtime/rpa-ast');

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE_FILE = 'F:\\Temp\\e2e-live-rec.html';
const FIXTURE_URL = 'file:///F:/Temp/e2e-live-rec.html';
const HTML = [
  '<html><head><title>LIVE-REC</title></head><body style="margin:0">',
  '<form onsubmit="return false">',
  '<input id="user" value="">',
  '<select id="pick"><option value="a">A</option><option value="b">B</option></select>',
  '<button id="go" type="button" onclick="document.getElementById(\'out\').textContent=\'clicked\'">go</button>',
  '</form>',
  '<div id="out">idle</div>',
  '<div style="height:2000px"></div>',
  '</body></html>',
].join('\n');

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

  let win = null;
  let es = null;
  try {
    fs.writeFileSync(FIXTURE_FILE, HTML);

    win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { partition: 'persist:auto:live-rec', contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    es = createElectronSession({ webContents: win.webContents, profileId: 'live-rec' });
    await es.start();
    const d = createPageDriver({ webContents: win.webContents, session: es.session, adapter: es.adapter, rng: es.rng });

    async function evalValue(expression) {
      const res = await es.session.sendCommand('Runtime.evaluate', { expression, returnByValue: true });
      return res && res.result ? res.result.value : undefined;
    }

    // fixture loaded BEFORE start() so the initial-URL record is the fixture itself
    // (a full document load resets the injected world — see report ceiling).
    await d.goto(FIXTURE_URL, { timeoutMs: 15000 });
    await d.waitForSelector('#user', { timeoutMs: 10000 });

    const audits = [];
    const rec = createLiveRecorder({ session: es.session, page: d, driver: d, audit: (a) => audits.push(a) });

    // a. start capture
    try {
      await rec.start();
      assert(audits.some((a) => a.type === 'recorder-start'), 'recorder-start audit');
      ok('recorder start injected');
    } catch (e) {
      bad('recorder start injected', e);
    }

    // b. real actions (SPA history nav + fill + select + click + scroll)
    try {
      await evalValue("history.pushState({}, '', location.href); 'spa'");
      await d.fill('#user', 'alice');
      await evalValue("(() => { const s = document.querySelector('#pick'); s.value = 'b'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()");
      await d.click('#go');
      await evalValue("window.scrollTo(0, 400); 'scrolled'");
      const sy = Number(await evalValue('window.scrollY'));
      assert(sy > 0, 'page not scrollable: scrollY=' + sy);
      // hidden windows run no rendering steps, so Chromium never dispatches its own scroll
      // event; fire one so the capture listener observes the real post-scroll position.
      await evalValue("window.dispatchEvent(new Event('scroll')); 'flush'");
      await sleep(400); // let the throttled scroll listener flush
      ok('actions performed (fill/select/click/scroll + SPA nav, scrollY=' + sy + ')');
    } catch (e) {
      bad('actions performed (fill/select/click/scroll + SPA nav)', e);
    }

    // c. drain + stop → ordered AST
    let astJson = null;
    let nodes = [];
    try {
      const drained = await rec.drain();
      astJson = await rec.stop();
      nodes = astJson.nodes;
      assert(drained.length > 0, 'drained empty');
      assert(createAst().fromJson(astJson).validate().ok, 'ast invalid');
      const idx = {};
      nodes.forEach((n, i) => {
        if (n.type === 'goto' && idx.goto === undefined) idx.goto = i;
        if (n.type === 'fill' && n.selector === '#user') idx.fill = i;
        if (n.type === 'select' && n.selector === '#pick') idx.select = i;
        if (n.type === 'click' && n.selector === '#go') idx.click = i;
        if (n.type === 'scroll') idx.scroll = i;
      });
      for (const k of ['goto', 'fill', 'select', 'click', 'scroll']) {
        assert(idx[k] !== undefined, 'missing ' + k + ' node: ' + JSON.stringify(nodes.map((n) => n.type + (n.selector ? ':' + n.selector : ''))));
      }
      assert(idx.goto < idx.fill && idx.fill < idx.select && idx.select < idx.click && idx.click < idx.scroll, 'order=' + JSON.stringify(idx));
      const fill = nodes[idx.fill];
      assert(fill.value === 'alice', 'fill value=' + JSON.stringify(fill.value));
      ok('recorded AST ordered: goto → fill(#user=alice) → select(#pick) → click(#go) → scroll (' + nodes.length + ' nodes)');
    } catch (e) {
      bad('recorded AST ordered', e);
    }

    // e. selector quality: #go via id (90), not nth-child
    try {
      const click = nodes.find((n) => n.type === 'click' && n.selector === '#go');
      assert(click && click.selectorType === 'id' && click.quality === 90, 'click=' + JSON.stringify(click));
      ok('#go recorded via id (quality 90)');
    } catch (e) {
      bad('#go recorded via id (quality 90)', e);
    }

    // d. Record → Replay against the SAME driver
    try {
      assert(astJson, 'no ast to replay');
      const replayPage = {
        click: (sel) => d.click(String(sel)),
        fill: (sel, val) => d.fill(String(sel), String(val)),
        select: (sel, val) =>
          evalValue(
            "(() => { const s = document.querySelector(" +
              JSON.stringify(String(sel)) +
              '); if (!s) throw new Error("no select"); s.value = ' +
              JSON.stringify(String(val)) +
              "; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()"
          ),
        press: (selOrKey, key) => d.press(key !== undefined ? String(key) : String(selOrKey)),
        waitForSelector: (sel) => d.waitForSelector(String(sel), { timeoutMs: 8000 }),
        waitForText: (sel, text) => d.waitForText(String(text), { timeoutMs: 8000 }),
        waitForURL: (url) => d.waitForURL(String(url), { timeoutMs: 8000 }),
        getAttribute: (sel, name) => d.getAttribute(String(sel), String(name)),
        evaluate: (expr) => evalValue(String(expr)),
        screenshot: () => d.screenshot(),
      };
      const browser = { goto: (url) => d.goto(String(url), { timeoutMs: 15000 }) };
      await runAst(astJson, {
        page: replayPage,
        browser,
        delay: (ms) => sleep(Math.min(Number(ms) || 0, 3000)),
        params: {},
        log: () => {},
      });
      const user = await d.getValue('#user');
      const pick = await d.getValue('#pick');
      const out = await d.getText('#out');
      assert(user === 'alice', 'replayed user=' + JSON.stringify(user));
      assert(pick === 'b', 'replayed pick=' + JSON.stringify(pick));
      assert(out === 'clicked', 'replayed out=' + JSON.stringify(out));
      ok('Record→Replay reproduced state (user=alice, pick=b, out=clicked)');
    } catch (e) {
      bad('Record→Replay reproduced state', e);
    }

    // f. cross-document leg: one recorder survives a real page-to-page navigation
    try {
      const SECOND_FILE = 'F:\\Temp\\e2e-live-rec2.html';
      const SECOND_URL = 'file:///F:/Temp/e2e-live-rec2.html';
      fs.writeFileSync(
        SECOND_FILE,
        [
          '<html><head><title>LIVE-REC-2</title></head><body style="margin:0">',
          '<input id="user2" value="">',
          '<div id="out2">idle</div>',
          '</body></html>',
        ].join('\n')
      );

      const rec2 = createLiveRecorder({
        session: es.session,
        page: d,
        driver: d,
        audit: (a) => audits.push(a),
        webContents: win.webContents,
      });
      await rec2.start();
      await d.goto(SECOND_URL, { timeoutMs: 15000 });
      await d.waitForSelector('#user2', { timeoutMs: 10000 });
      // wait for the post-navigation re-injection before acting (fill must be captured)
      const t0i = Date.now();
      for (;;) {
        if ((await evalValue('!!window.__fpRec')) === true) break;
        if (Date.now() - t0i > 5000) throw new Error('recorder not re-injected after navigation');
        await sleep(100);
      }
      await d.fill('#user2', 'bob');
      await rec2.drain();
      const ast2 = await rec2.stop();
      const gotos = ast2.nodes.filter((n) => n.type === 'goto');
      const goto2 = ast2.nodes.findIndex((n) => n.type === 'goto' && n.url === SECOND_URL);
      const fill2 = ast2.nodes.findIndex((n) => n.type === 'fill' && n.selector === '#user2');
      assert(gotos.length === 2, 'goto nodes=' + JSON.stringify(gotos.map((g) => g.url)));
      assert(gotos[0].url === FIXTURE_URL && gotos[1].url === SECOND_URL, 'goto urls=' + JSON.stringify(gotos.map((g) => g.url)));
      assert(goto2 !== -1 && fill2 !== -1 && fill2 > goto2, 'order goto2=' + goto2 + ' fill2=' + fill2);
      assert(ast2.nodes[fill2].value === 'bob', 'fill value=' + JSON.stringify(ast2.nodes[fill2].value));
      ok('cross-document: recorder survived goto → 2 goto nodes + fill(#user2=bob)');

      // trivial extended replay: goto(fixture1) → goto(fixture2) → fill(#user2)
      const replayPage2 = {
        click: (sel) => d.click(String(sel)),
        fill: (sel, val) => d.fill(String(sel), String(val)),
        select: (sel, val) =>
          evalValue(
            "(() => { const s = document.querySelector(" +
              JSON.stringify(String(sel)) +
              '); if (!s) throw new Error("no select"); s.value = ' +
              JSON.stringify(String(val)) +
              "; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()"
          ),
        press: (selOrKey, key) => d.press(key !== undefined ? String(key) : String(selOrKey)),
        waitForSelector: (sel) => d.waitForSelector(String(sel), { timeoutMs: 8000 }),
        waitForText: (sel, text) => d.waitForText(String(text), { timeoutMs: 8000 }),
        waitForURL: (url) => d.waitForURL(String(url), { timeoutMs: 8000 }),
        getAttribute: (sel, name) => d.getAttribute(String(sel), String(name)),
        evaluate: (expr) => evalValue(String(expr)),
        screenshot: () => d.screenshot(),
      };
      await runAst(ast2, {
        page: replayPage2,
        browser: { goto: (url) => d.goto(String(url), { timeoutMs: 15000 }) },
        delay: (ms) => sleep(Math.min(Number(ms) || 0, 3000)),
        params: {},
        log: () => {},
      });
      const v2 = await d.getValue('#user2');
      assert(v2 === 'bob', 'replayed user2=' + JSON.stringify(v2));
      ok('cross-document Record→Replay reproduced #user2=bob');
    } catch (e) {
      bad('cross-document recording survived navigation', e);
    }

    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await sleep(300);
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
      if (es) await es.stop();
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
