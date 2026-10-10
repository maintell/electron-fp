'use strict';
// ponytail: real-binary E2E for the recorder control plane — recorder-controller + recorder-service
// over a real recorder session. Actions are driven as REAL DOM events on the same webContents
// (executeJavaScript) because the controller owns the only debugger attach; the recorder is
// event-driven, so its injected listeners capture exactly what a real user action would produce.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { createRecorderController } = require('./electron/recorder-controller');
const { createRecorderService } = require('./runtime/recorder-service');
const { createAst } = require('./runtime/rpa-ast');

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

const FIXTURE_FILE = 'F:\\Temp\\e2e-recorder-ctl.html';
const FIXTURE_URL = 'file:///F:/Temp/e2e-recorder-ctl.html';
const HTML = [
  '<html><head><title>REC-CTL</title></head><body style="margin:0">',
  '<input id="u" value="">',
  '<button id="go" type="button" onclick="document.getElementById(\'out\').textContent=\'clicked\'">go</button>',
  '<div id="out">idle</div>',
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

  let fixtureWin = null;
  try {
    fs.writeFileSync(FIXTURE_FILE, HTML);

    const audits = [];
    const resolveWebContents = ({ url }) => {
      fixtureWin = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: { partition: 'persist:auto:rec-ctl', contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      if (url) fixtureWin.loadURL(url).catch(() => {}); // controller waits did-finish-load
      return {
        webContents: fixtureWin.webContents,
        cleanup: () => {
          try {
            if (fixtureWin && !fixtureWin.isDestroyed()) fixtureWin.destroy();
          } catch (_) {}
        },
      };
    };

    const controller = createRecorderController({ resolveWebContents, audit: (a) => audits.push(a) });
    const svc = createRecorderService({ controller });

    // 1. start through the service envelope
    const s = await svc.recorder.start({ profileId: 'rec-ctl', url: FIXTURE_URL });
    assert(s.ok === true && s.data && typeof s.data.sessionId === 'string', 'start=' + JSON.stringify(s));
    assert(s.data.url === FIXTURE_URL, 'url=' + s.data.url);
    const sessionId = s.data.sessionId;
    ok('recorder.start -> sessionId + url (' + sessionId + ')');

    // 2. state() summary (no live objects)
    const st0 = svc.recorder.state();
    assert(st0.ok === true && st0.data.active === true && st0.data.sessions.length === 1, 'state=' + JSON.stringify(st0));
    assert(st0.data.sessions[0].sessionId === sessionId && st0.data.sessions[0].profileId === 'rec-ctl', 'summary');
    ok('recorder.state -> active session summary');

    // 3. real actions on the real page
    const wc = fixtureWin.webContents;
    await wc.executeJavaScript(
      "(() => { const i = document.querySelector('#u'); i.value = 'alice'; i.dispatchEvent(new Event('input', { bubbles: true })); return i.value; })()"
    );
    await wc.executeJavaScript("document.querySelector('#go').click(); 'ok'");
    await sleep(150);
    ok('actions performed (input #u=alice, click #go)');

    // 4. drain -> ordered nodes
    const d = await svc.recorder.drain(sessionId);
    assert(d.ok === true && d.data.count === d.data.nodes.length, 'drain=' + JSON.stringify(d));
    assert(d.data.count >= 3, 'count=' + d.data.count);
    const types = d.data.nodes.map((n) => n.type);
    const fillIdx = types.indexOf('fill');
    const clickIdx = types.indexOf('click');
    assert(types[0] === 'goto' && fillIdx > 0 && clickIdx > fillIdx, 'types=' + JSON.stringify(types));
    assert(d.data.nodes[fillIdx].selector === '#u' && d.data.nodes[fillIdx].value === 'alice', 'fill=' + JSON.stringify(d.data.nodes[fillIdx]));
    assert(d.data.nodes[clickIdx].selector === '#go', 'click=' + JSON.stringify(d.data.nodes[clickIdx]));
    ok('recorder.drain -> ' + JSON.stringify(types) + ' (goto/fill/click ordered)');

    // 5. stop -> valid AST
    const stopped = await svc.recorder.stop(sessionId);
    assert(stopped.ok === true && stopped.data.ast && Array.isArray(stopped.data.ast.nodes), 'stop=' + JSON.stringify(stopped));
    assert(stopped.data.ast.nodes.length >= 3, 'ast nodes=' + stopped.data.ast.nodes.length);
    const v = createAst().fromJson(stopped.data.ast).validate();
    assert(v.ok === true, 'ast invalid: ' + JSON.stringify(v.errors));
    ok('recorder.stop -> valid AST (' + stopped.data.ast.nodes.length + ' nodes)');

    // 6. state after stop + unknown session -> NOT_FOUND envelope
    const st1 = svc.recorder.state();
    assert(st1.ok === true && st1.data.active === false && st1.data.sessions.length === 0, 'state after stop=' + JSON.stringify(st1));
    const unknown = await svc.recorder.drain('nope-' + Date.now());
    assert(unknown.ok === false && unknown.error.code === 'NOT_FOUND', 'unknown=' + JSON.stringify(unknown));
    ok('state inactive after stop; unknown session -> NOT_FOUND envelope');

    // 7. teardown clean
    destroyAll();
    const left = BrowserWindow.getAllWindows().length;
    assert(left === 0, 'windows left: ' + left);
    ok('teardown clean (0 windows)');

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
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try {
      app.exit(process.exitCode);
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000);
  }
}

main();
