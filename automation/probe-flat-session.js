'use strict';
// P3 feasibility probe (doc 17 §B.8 P3): does Electron's webContents.debugger allow a
// SECOND flat session to the ROOT page target while already attached — the premise that
// "true flat-session per-client isolation" rests on? P1 (single attach) + P2 (domain
// filter) already give coexistence; P3 is only worth building if this proves POSSIBLE
// and meaningfully isolated. Probe only — does NOT touch attach-broker.js/cdp-ws.js.
//
// Run (built binary; stash resources/app first per AGENTS.md §2):
//   $env:RTK_DISABLED='1'; & "F:\code\src\out\Default\electron.exe" automation\probe-flat-session.js
const { app, BrowserWindow } = require('electron');
const http = require('http');

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name) { pass++; console.log('PASS ' + name); }
function bad(name, err) { fail++; console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message : String(err))); }
function skipL(name, reason) { skip++; console.log('SKIP ' + name + ' :: ' + reason); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
}
function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.destroy(); } catch (_) {}
    }
  } catch (_) {}
}

async function main() {
  await app.whenReady();
  app.on('window-all-closed', () => {});

  const hardKill = setTimeout(() => {
    try { console.log('FAIL harness-timeout :: 120s budget exceeded'); } catch (_) {}
    destroyAll();
    try { app.exit(2); } catch (_) { process.exit(2); }
  }, 120000);
  if (hardKill.unref) hardKill.unref();

  let win = null;
  let dbg = null;
  let srvA = null;
  let srvB = null;
  const events = [];
  let sid = null;
  let atError = null;

  const cmd = async (method, params, sessionId) => {
    try {
      const result = sessionId ? await dbg.sendCommand(method, params, sessionId) : await dbg.sendCommand(method, params);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  try {
    win = new BrowserWindow({ width: 500, height: 400, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    const wc = win.webContents;
    dbg = wc.debugger;
    await dbg.attach('1.1');
    dbg.on('message', (_e, method, params, sessionId) => events.push({ method, sessionId: sessionId || null, params }));

    // ---- resolve the ROOT page target id ----
    const gti = await cmd('Target.getTargetInfo');
    const rootId = gti.ok && gti.result && gti.result.targetInfo && gti.result.targetInfo.targetId;
    if (!rootId) {
      bad('resolve root page target id', new Error('Target.getTargetInfo -> ' + JSON.stringify(gti)));
    } else {
      ok('resolved root page target id (' + rootId + ')');
    }
    const base = await cmd('Runtime.evaluate', { expression: '1+1', returnByValue: true });
    assert(base.ok && base.result && base.result.result && base.result.result.value === 2, 'baseline eval=' + JSON.stringify(base));
    ok('baseline: root session Runtime.evaluate 1+1 === 2');

    // ---- STEP 3: flat attachToTarget to the ROOT while already attached ----
    const at = await cmd('Target.attachToTarget', { targetId: rootId, flatten: true });
    sid = at.ok && at.result && typeof at.result.sessionId === 'string' ? at.result.sessionId : null;
    atError = at.ok ? null : at.error;
    console.log('INFO root Target.attachToTarget -> ' + JSON.stringify(at.ok ? { result: at.result } : { error: at.error }));

    let rootViable = false;
    if (!sid) {
      ok('root flat attachToTarget returned a DETERMINATE result (rejected, not a hang): ' + (atError || 'no sessionId'));
      skipL('root flat session isolation', 'attachToTarget to the root page target did not return a sessionId: ' + (atError || 'no sessionId'));
    } else {
      ok('root flat attachToTarget returned sessionId (' + sid + ')');

      // (a) the main (root) session keeps working
      const after = await cmd('Runtime.evaluate', { expression: '1+1', returnByValue: true });
      assert(after.ok && after.result && after.result.result && after.result.result.value === 2, 'root eval after flat attach=' + JSON.stringify(after));
      ok('(a) root session still works after the flat attach (1+1=2)');

      // (b) events on the new session are tagged with its sessionId
      await cmd('Runtime.enable', {}, sid);
      const gotEv = await until(() => events.some((e) => e.sessionId === sid && e.method.startsWith('Runtime.')), 5000);
      assert(gotEv, 'no event tagged with sessionId ' + sid + ' (saw ' + JSON.stringify(events.map((e) => ({ m: e.method, s: e.sessionId }))).slice(0, 400) + ')');
      ok('(b) events on the flat session are tagged with its sessionId (' + sid + ')');

      // (c) two such sessions coexist with independent replies
      const at2 = await cmd('Target.attachToTarget', { targetId: rootId, flatten: true });
      const sid2 = at2.ok && at2.result && at2.result.sessionId;
      const r1 = await cmd('Runtime.evaluate', { expression: '"one"', returnByValue: true }, sid);
      assert(r1.ok && r1.result && r1.result.result && r1.result.result.value === 'one', 'sid eval=' + JSON.stringify(r1));
      if (sid2 && sid2 !== sid) {
        const r2 = await cmd('Runtime.evaluate', { expression: '"two"', returnByValue: true }, sid2);
        assert(r2.ok && r2.result && r2.result.result && r2.result.result.value === 'two', 'sid2 eval=' + JSON.stringify(r2));
        ok('(c) two flat sessions coexist, distinct sessionIds, independent replies');
      } else {
        ok('(c) a second attachToTarget returned ' + (sid2 ? 'the SAME sessionId' : 'no sessionId') + '; root + flat session coexist with independent replies');
      }
      rootViable = true;
    }

    // ---- STEP 5: CHILD-target flat session (best-effort) ----
    try {
      srvB = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<html><body>child</body></html>'); });
      await new Promise((r) => srvB.listen(0, '127.0.0.1', r));
      const childPort = srvB.address().port;
      srvA = http.createServer((q, s) => {
        s.writeHead(200, { 'Content-Type': 'text/html' });
        s.end('<html><body>parent<iframe src="http://localhost:' + childPort + '/"></iframe></body></html>');
      });
      await new Promise((r) => srvA.listen(0, '127.0.0.1', r));
      const parentPort = srvA.address().port;

      await cmd('Target.setDiscoverTargets', { discover: true });
      await cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await wc.loadURL('http://127.0.0.1:' + parentPort + '/');
      await sleep(1500);

      const gts = await cmd('Target.getTargets');
      const infos = (gts.result && gts.result.targetInfos) || [];
      const child = infos.find((t) => t.targetId !== rootId && (t.type === 'iframe' || t.type === 'page'));
      const autoChild = events.find((e) => e.method === 'Target.attachedToTarget');
      if (child) {
        const cat = await cmd('Target.attachToTarget', { targetId: child.targetId, flatten: true });
        const csid = cat.ok && cat.result && cat.result.sessionId;
        if (csid) ok('child target flat session works (type=' + child.type + ', sessionId=' + csid + ')');
        else skipL('child flat session', 'child attachToTarget rejected: ' + (cat.error || 'no sessionId'));
      } else if (autoChild) {
        ok('child target auto-attached (Target.attachedToTarget event observed)');
      } else {
        skipL('child flat session', 'no child/OOPIF target discovered for this content (site isolation may be off; ' + infos.length + ' targets)');
      }
    } catch (e) {
      skipL('child flat session', 'child leg error: ' + ((e && e.message) || e));
    } finally {
      for (const s of [srvA, srvB]) { try { if (s) s.close(); } catch (_) {} }
    }

    console.log('VERDICT ' + (rootViable
      ? 'P3 VIABLE on this Electron: the root page target accepts a flat attachToTarget while already attached; the root session keeps working, events are session-tagged, and sessions coexist.'
      : 'P3 NOT viable on this Electron: ' + (sid
          ? 'a sessionId was returned but an isolation check failed.'
          : 'the root page target rejected a second flat attachToTarget (' + (atError || 'no sessionId') + '); stay P1/P2-only.')));
    console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip);
    await sleep(200);
  } catch (e) {
    try { bad('harness-crash', e); console.log('SUMMARY pass=' + pass + ' fail=' + fail + ' skip=' + skip); } catch (_) {}
  } finally {
    clearTimeout(hardKill);
    for (const s of [srvA, srvB]) { try { if (s) s.close(); } catch (_) {} }
    try { if (dbg && typeof dbg.isAttached === 'function' && dbg.isAttached()) dbg.detach(); } catch (_) {}
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try { app.exit(process.exitCode); } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000);
  }
}

main();
