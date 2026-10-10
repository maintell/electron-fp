'use strict';
// MClient RPA visual-builder E2E. Boots MClient, creates a group + tab, then drives
// window.rpaApi in the REAL renderer (via executeJavaScript) through the whole
// workflow: validate -> save -> load -> replay (drives the live tab) -> recorder
// round-trip. Proves the bridge that rpa.js reads on mount is actually exposed.
const { app, BrowserWindow } = require('electron');

const mod = require('./main.js');

let pass = 0;
let fail = 0;
const ck = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (detail ? ': ' + detail : ''));
  } else {
    fail++;
    console.log('FAIL  ' + name + (detail ? ': ' + detail : ''));
  }
};

function destroyAll() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.destroy(); } catch (_) {}
    }
  } catch (_) {}
}

function finish(code) {
  destroyAll();
  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  const c = code !== undefined ? code : fail === 0 ? 0 : 1;
  try { app.exit(c); } catch (_) { process.exit(c); }
  setTimeout(() => process.exit(c), 2000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWin(ms) {
  const t0 = Date.now();
  for (;;) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed() && !w.webContents.isLoading()) return w;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
}

async function ensureCommitted(wc, ms = 10000) {
  if (wc.isLoading()) {
    await Promise.race([new Promise((r) => wc.once('did-finish-load', r)), sleep(ms)]);
  }
  if (!wc.getURL()) {
    await Promise.race([wc.loadURL('about:blank').catch(() => {}), sleep(ms)]);
  }
}

const DATA_URL = 'data:text/html,<h1 id=t>hello</h1><input id=i>';
const FLOW = {
  name: 'rpa-e2e',
  nodes: [
    { type: 'goto', url: DATA_URL },
    { type: 'fill', selector: '#i', value: 'x' },
    { type: 'readText', selector: '#t', outVar: 'txt' },
  ],
};
const F = JSON.stringify(FLOW);

app.whenReady().then(async () => {
  const hardKill = setTimeout(() => {
    console.log('FAIL  harness-timeout :: 120s budget exceeded');
    finish(2);
  }, 120000);
  if (hardKill.unref) hardKill.unref();

  try {
    const win = await waitForWin(20000);
    ck('MClient main window created', !!win);
    if (!win) return finish();

    const js = (code) => win.webContents.executeJavaScript(code, true);
    // Call a renderer expression that returns a Promise; unwrap {ok,data}-style result.
    async function callRpa(expr) {
      const out = await js(
        '(' + expr + ').then(r => JSON.stringify({ ok: true, r: r }))' +
          '.catch(e => JSON.stringify({ ok: false, err: String((e && e.message) || e) }))'
      );
      const parsed = JSON.parse(out);
      if (!parsed.ok) throw new Error(parsed.err);
      return parsed.r;
    }

    // 1. the bridge rpa.js reads on mount must be exposed by the preload.
    ck('window.rpaApi present in renderer', await js('!!window.rpaApi'));
    ck('rpaApi has validate/save/load/replay/subscribeLog/recorder',
      await js("!!(window.rpaApi && window.rpaApi.validate && window.rpaApi.save && window.rpaApi.load && window.rpaApi.replay && window.rpaApi.subscribeLog && window.rpaApi.recorder)"));
    ck('rpaApi.recorder has start/drain/stop/state',
      await js("!!(window.rpaApi.recorder && window.rpaApi.recorder.start && window.rpaApi.recorder.drain && window.rpaApi.recorder.stop && window.rpaApi.recorder.state)"));

    // 2. a group + live tab to drive.
    const gid = await mod.addGroup('default');
    const group = mod.groups.get(gid);
    ck('group created with a tab', !!group && group.tabIds.length > 0, 'gid=' + gid);
    if (!group || !group.tabIds.length) return finish();
    const tabId = group.activeTabId || group.tabIds[0];
    const wc = mod.tabs.get(tabId).view.webContents;
    await ensureCommitted(wc);
    ck('tab committed a load', !!wc.getURL(), 'url=' + wc.getURL());

    // 3. validate (ALWAYS ok envelope; validation result rides in data)
    const v = await callRpa('window.rpaApi.validate(' + F + ')');
    ck('validate -> ok with no errors', !!v && v.ok === true && Array.isArray(v.errors) && v.errors.length === 0,
      JSON.stringify(v));

    // 4. save -> {id,name,nodes}
    const saved = await callRpa('window.rpaApi.save(' + F + ')');
    ck('save -> id + nodes', !!saved && typeof saved.id === 'string' && Array.isArray(saved.nodes) && saved.nodes.length === 3,
      JSON.stringify(saved).slice(0, 160));
    ck('save -> name preserved', !!saved && saved.name === 'rpa-e2e', saved && saved.name);

    // 5. load -> the saved flow
    const loaded = await callRpa('window.rpaApi.load()');
    ck('load -> name + 3 nodes', !!loaded && loaded.name === 'rpa-e2e' && Array.isArray(loaded.nodes) && loaded.nodes.length === 3,
      JSON.stringify(loaded).slice(0, 160));

    // 6. replay -> {executionId}; the REAL tab is driven by the compiled flow.
    const rep = await callRpa('window.rpaApi.replay(' + F + ', { id: ' + JSON.stringify(gid) + ' })');
    ck('replay -> executionId', !!rep && typeof rep.executionId === 'string', JSON.stringify(rep).slice(0, 120));
    const exId = rep && rep.executionId;

    // Poll the execution in-process to a terminal state.
    let rec = null;
    for (let i = 0; i < 120 && exId; i++) {
      const r = mod.automationService.run.getExecution(exId);
      const d = r && r.ok ? r.data : null;
      if (d && d.status !== 'RUNNING' && d.status !== 'QUEUED') { rec = d; break; }
      await sleep(100);
    }
    ck('replay execution reached SUCCESS', !!rec && rec.status === 'SUCCESS',
      rec ? rec.status + (rec.error ? ' :: ' + JSON.stringify(rec.error).slice(0, 200) : '') : 'no record');
    ck('replay drove the live MClient tab', typeof wc.getURL() === 'string' && wc.getURL().indexOf('hello') !== -1,
      'liveUrl=' + wc.getURL());

    // 7. recorder round-trip on the live tab.
    const started = await callRpa('window.rpaApi.recorder.start({ profileId: ' + JSON.stringify(gid) + ' })');
    ck('recorder.start -> sessionId', !!started && typeof started.sessionId === 'string', JSON.stringify(started).slice(0, 120));
    const sid = started && started.sessionId;

    const drained = await callRpa('window.rpaApi.recorder.drain(' + JSON.stringify(sid) + ')');
    ck('recorder.drain -> {nodes,count}', !!drained && Array.isArray(drained.nodes) && drained.count === drained.nodes.length,
      JSON.stringify(drained).slice(0, 160));

    const stopped = await callRpa('window.rpaApi.recorder.stop(' + JSON.stringify(sid) + ')');
    ck('recorder.stop -> ast.nodes', !!stopped && !!stopped.ast && Array.isArray(stopped.ast.nodes),
      JSON.stringify(stopped).slice(0, 160));

    const st = await callRpa('window.rpaApi.recorder.state()');
    ck('recorder.state -> inactive after stop', !!st && st.active === false, JSON.stringify(st).slice(0, 120));

    clearTimeout(hardKill);
    finish();
  } catch (e) {
    fail++;
    console.log('FAIL  threw :: ' + ((e && e.stack) || e));
    finish();
  }
}).catch((e) => {
  fail++;
  console.log('FAIL  whenReady threw :: ' + ((e && e.stack) || e));
  finish();
});
