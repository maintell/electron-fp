'use strict';
// ponytail: one-shot Electron integration smoke for automation glue; mirrors probe-cdp-evasion.js lifecycle.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { createElectronSession, restartSession } = require('./electron/glue');
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

function cdpValue(res) {
  if (res && res.result && Object.prototype.hasOwnProperty.call(res.result, 'value')) {
    return res.result.value;
  }
  if (res && Object.prototype.hasOwnProperty.call(res, 'value')) return res.value;
  return undefined;
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
      console.log('FAIL harness-timeout :: global 150s exceeded');
    } catch (_) {}
    destroyAll();
    try {
      app.exit(2);
    } catch (_) {
      process.exit(2);
    }
  }, 150000); // ponytail: matches the "global 150s" message + task budget; 60s was flaky (screenshot retries + partition loads)
  if (hardKill.unref) hardKill.unref();

  let win = null;
  let es = null;
  try {
    win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL('about:blank');
    await new Promise((resolve) => {
      const wc = win.webContents;
      if (wc.isLoading() === false && wc.getURL() !== '') return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 5000);
    });

    // a. attach ok (reached start)
    try {
      es = createElectronSession({ webContents: win.webContents, profileId: 'probe' });
      await es.start();
      ok('attach ok (start reached attached)');
    } catch (e) {
      bad('attach ok (start reached attached)', e);
    }

    const noSession = () => new Error('skipped: no session (start failed)');
    const sess = () => {
      if (!es) throw noSession();
      return es.session;
    };

    // b. Browser.close rejected (allowlist deny, real path)
    try {
      await sess().sendCommand('Browser.close');
      bad('Browser.close denied', new Error('expected rejection, got resolve'));
    } catch (e) {
      if (/skipped/.test(e.message)) bad('Browser.close denied', e);
      else if (/denied/.test(e.message)) ok('Browser.close denied');
      else bad('Browser.close denied', e);
    }

    // c. Runtime.evaluate clean expression returns value (isolated world default)
    try {
      const res = await sess().sendCommand('Runtime.evaluate', { expression: '6*7', returnByValue: true });
      const v = cdpValue(res);
      if (v === 42) ok('Runtime.evaluate clean returns value');
      else bad('Runtime.evaluate clean returns value', new Error('value=' + JSON.stringify(v)));
    } catch (e) {
      bad('Runtime.evaluate clean returns value', e);
    }

    // d. Runtime.evaluate with FP_CONFIG_DATA rejected with fp-carrier message
    try {
      await sess().sendCommand('Runtime.evaluate', {
        expression: "'len:' + 'FP_CONFIG_DATA'.length",
        returnByValue: true,
      });
      bad('FP carrier scrub', new Error('expected rejection, got resolve'));
    } catch (e) {
      if (/skipped/.test(e.message)) bad('FP carrier scrub', e);
      else if (/fp carrier scrub/i.test(e.message)) ok('FP carrier scrub');
      else bad('FP carrier scrub', e);
    }

    // e. adapter.clickAt with real plan -> backend must be 'send', window survives
    try {
      if (!es) throw noSession();
      const hi = require('./runtime/human-input');
      const plan = hi.planClick({ at: { x: 400, y: 300 }, from: { x: 390, y: 290 }, rng: es.rng });
      const r = await es.adapter.clickAt({ moves: plan.moves, holdMs: plan.holdMs });
      if (r.backend === 'send' && !win.isDestroyed()) ok('adapter.clickAt real plan backend=send, window survives');
      else bad('adapter.clickAt real plan backend=send, window survives', new Error('backend=' + r.backend + ' destroyed=' + win.isDestroyed()));
    } catch (e) {
      bad('adapter.clickAt real plan backend=send, window survives', e);
    }

    // f. screenshot() returns bytes > 1000
    try {
      if (!es) throw noSession();
      // Precondition (diag-verified 2026-09-26, twice): a hidden window has no
      // composited surface until the first capture triggers one, so capture #1
      // hangs waiting for a frame. Page.enable + retry-until-frame is the fix;
      // each attempt primes the compositor further. Each attempt is capped so a
      // hung capture fails THIS check fast instead of tripping the 60s hard-kill.
      await es.session.sendCommand('Page.enable', {});
      let shot = null;
      let lastErr = null;
      for (let i = 0; i < 3 && !shot; i++) {
        try {
          shot = await Promise.race([
            es.screenshot(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout 8s')), 8000)),
          ]);
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!shot) throw lastErr || new Error('no screenshot');
      if (shot.bytes > 1000) ok('screenshot bytes>1000 (' + shot.bytes + ')');
      else bad('screenshot bytes>1000', new Error('bytes=' + shot.bytes));
    } catch (e) {
      bad('screenshot bytes>1000', e);
    }

    // g. session.input.send exists and does not throw on mouseMove (real wc hook)
    try {
      const s = sess();
      if (typeof s.input.send !== 'function') throw new Error('input.send missing');
      s.input.send({ type: 'mouseMove', x: 10, y: 10 });
      ok('session.input.send wired (no throw on mouseMove)');
    } catch (e) {
      bad('session.input.send wired (no throw on mouseMove)', e);
    }

    // ---- E2E page-driver block (real planner output, offline file:// page) ----
    // file://, not data:: data:-URL origins are opaque so localStorage throws
    // SecurityError there (diag-verified); file:// keeps the no-network intent
    // and makes storage/upload/download/cookies all real.
    const E2E_PARTITION = 'persist:probe-e2e';
    const E2E_FILE = 'F:\\Temp\\e2e-page.html';
    const E2E_URL = 'file:///F:/Temp/e2e-page.html';
    const E2E_HTML = [
      '<html><body>',
      '<button id="b" onclick="document.getElementById(\'out\').textContent=\'clicked\'">off</button>',
      '<input id="i" value="">',
      '<form id="fm" onsubmit="document.getElementById(\'out2\').textContent=\'submitted:\'+document.getElementById(\'f2\').value;return false;"><input id="f2" value=""></form>',
      '<input id="file" type="file" onchange="document.getElementById(\'out3\').textContent=\'files:\'+this.files.length">',
      '<a id="dl" href="data:text/plain,hello-e2e-download" download="e2e-dl.txt">dl</a>',
      '<div id="out">hi</div><div id="out2">-</div><div id="out3">files:0</div>',
      '</body></html>',
    ].join('\n');
    async function createE2EWindow() {
      const w = new BrowserWindow({
        width: 800, height: 600, show: false,
        webPreferences: { partition: E2E_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      await w.loadURL('about:blank');
      await new Promise((resolve) => {
        const wcc = w.webContents;
        if (wcc.isLoading() === false && wcc.getURL() !== '') return resolve();
        wcc.once('did-finish-load', resolve);
        setTimeout(resolve, 5000);
      });
      return w;
    }
    let es2 = null;
    let driver = null;
    const needDriver = () => {
      if (!driver) throw new Error('skipped: no page driver (e2e setup failed)');
      return driver;
    };

    // h. e2e setup: fixtures + window + session + driver
    try {
      fs.writeFileSync(E2E_FILE, E2E_HTML);
      fs.writeFileSync('F:\\Temp\\e2e-upload.txt', 'upload-fixture-bytes');
      try { fs.unlinkSync('F:\\Temp\\e2e-dl.txt'); } catch (_) {}
      const win2 = await createE2EWindow();
      es2 = createElectronSession({ webContents: win2.webContents, profileId: 'probe-e2e' });
      es2._win = win2;
      await es2.start();
      driver = createPageDriver({ webContents: win2.webContents, session: es2.session, adapter: es2.adapter, rng: es2.rng });
      await driver.enableNetwork();
      ok('e2e setup: window+session+driver');
    } catch (e) {
      bad('e2e setup: window+session+driver', e);
    }

    // i. goto file:// page
    try {
      const r = await needDriver().goto(E2E_URL);
      if (String(r.url).includes('e2e-page.html')) ok('goto file:// page');
      else bad('goto file:// page', new Error('url=' + r.url));
    } catch (e) {
      bad('goto file:// page', e);
    }

    // j. click button toggles text (real planClick trajectory)
    try {
      const d = needDriver();
      await d.click('#b');
      await d.waitForText('clicked', { timeoutMs: 8000 });
      const t = await d.getText('#out');
      if (t === 'clicked') ok('click toggles text');
      else bad('click toggles text', new Error('text=' + JSON.stringify(t)));
    } catch (e) {
      bad('click toggles text', e);
    }

    // k. fill input + read back live value (property, not markup attribute)
    try {
      const d = needDriver();
      await d.fill('#i', 'hello-e2e');
      const v = await d.getValue('#i');
      if (v === 'hello-e2e') ok('fill+readback');
      else bad('fill+readback', new Error('value=' + JSON.stringify(v)));
    } catch (e) {
      bad('fill+readback', e);
    }

    // l. fill form + press Enter submits
    try {
      const d = needDriver();
      await d.fill('#f2', 'abc');
      await d.press('Enter');
      await d.waitForText('submitted:abc', { timeoutMs: 8000 });
      ok('press Enter submits form');
    } catch (e) {
      bad('press Enter submits form', e);
    }

    // m. cookies set/get (partition-scoped, no navigation)
    try {
      const d = needDriver();
      await d.cookies.set({ url: 'https://probe.local/', name: 'ck2', value: 'cv2' });
      const cs = await d.cookies.get({ domain: 'probe.local' });
      if (cs.some((c) => c.name === 'ck2' && c.value === 'cv2')) ok('cookies set/get');
      else bad('cookies set/get', new Error('got=' + JSON.stringify(cs)));
    } catch (e) {
      bad('cookies set/get', e);
    }

    // n. storage set/get (file:// origin — data: origins are opaque)
    try {
      const d = needDriver();
      await d.storageSet('sk', 'sv1');
      const v = await d.storageGet('sk');
      if (v === 'sv1') ok('storage set/get');
      else bad('storage set/get', new Error('value=' + JSON.stringify(v)));
    } catch (e) {
      bad('storage set/get', e);
    }

    // o. upload file input (CDP accepted; DOM change text as detail)
    try {
      const d = needDriver();
      const r = await d.upload('#file', 'F:\\Temp\\e2e-upload.txt');
      let note = '';
      try {
        note = await d.getText('#out3');
      } catch (_) {}
      if (r && r.file === 'F:\\Temp\\e2e-upload.txt') ok('upload file input (out3=' + note + ')');
      else bad('upload file input', new Error('result=' + JSON.stringify(r)));
    } catch (e) {
      bad('upload file input', e);
    }

    // p. download data: link completes to disk
    try {
      const d = needDriver();
      const r = await d.download({
        trigger: () => d.click('#dl'),
        savePath: 'F:\\Temp\\e2e-dl.txt',
        downloadDir: 'F:\\Temp',
        timeoutMs: 20000,
      });
      let sz = -1;
      try { sz = fs.statSync('F:\\Temp\\e2e-dl.txt').size; } catch (_) {}
      if (r.state === 'completed' && sz > 0) ok('download completes (' + sz + ' bytes)');
      else bad('download completes', new Error('state=' + r.state + ' size=' + sz));
    } catch (e) {
      bad('download completes', e);
    }

    // q. network events seen during goto
    try {
      const seen = needDriver().recentRequests();
      if (seen.length >= 1) ok('network events seen (' + seen.length + ')');
      else bad('network events seen', new Error('empty ring'));
    } catch (e) {
      bad('network events seen', e);
    }

    // r. waits: selector + URL
    try {
      const d = needDriver();
      await d.waitForSelector('#out', { timeoutMs: 5000 });
      await d.waitForURL('e2e-page', { timeoutMs: 5000 });
      ok('waits: selector+url');
    } catch (e) {
      bad('waits: selector+url', e);
    }

    // s. page screenshot
    try {
      const shot = await needDriver().screenshot();
      if (shot.bytes > 1000) ok('page screenshot bytes>1000 (' + shot.bytes + ')');
      else bad('page screenshot bytes>1000', new Error('bytes=' + shot.bytes));
    } catch (e) {
      bad('page screenshot bytes>1000', e);
    }

    // t. relaunch: same partition, carried item unchanged, marker re-goto
    try {
      if (!es2) throw new Error('skipped: no e2e session (setup failed)');
      const d = needDriver();
      await d.cookies.set({ url: 'https://probe.local/', name: 'rl-marker', value: 'rl-1' });
      const es3 = await restartSession(es2, createE2EWindow, { profileId: 'probe-e2e' });
      es2 = es3;
      driver = createPageDriver({ webContents: es3._win.webContents, session: es3.session, adapter: es3.adapter, rng: es3.rng });
      await driver.goto(E2E_URL);
      const cs = await driver.cookies.get({ domain: 'probe.local' });
      const carried = cs.find((c) => c.name === 'rl-marker');
      const marker = await driver.getText('#out');
      if (carried && carried.value === 'rl-1' && marker === 'hi') ok('relaunch: carried rl-1, marker re-goto');
      else bad('relaunch: carried rl-1, marker re-goto', new Error('cookie=' + JSON.stringify(carried) + ' marker=' + JSON.stringify(marker)));
      try { await es3.stop(); } catch (_) {}
    } catch (e) {
      bad('relaunch: carried rl-1, marker re-goto', e);
    }

    // ---- u-x: Electron launcher + persist-partition relaunch (real BrowserWindow) ----
    const launchParts = [];
    const launchAudit = [];
    let launchWin = null;
    const { createElectronLauncher } = require('./electron/launcher');
    const launcher = createElectronLauncher({
      createWindow: (partition) => {
        launchParts.push(partition);
        launchWin = new BrowserWindow({
          width: 640,
          height: 480,
          show: false,
          webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: false },
        });
        return launchWin; // not loading yet — launcher kicks loadURL('about:blank') itself
      },
      audit: (e) => launchAudit.push(e),
    });

    // u. start: default partition derived persist:auto-<id>, plain inProcess endpoint, audit
    try {
      const ep = await launcher.start({ id: 'smoke-launch-1' });
      const partOk = launchParts[0] === 'persist:auto-smoke-launch-1';
      const auditOk = launchAudit.some((e) => e.type === 'launcher-start' && e.profileId === 'smoke-launch-1');
      if (ep && ep.inProcess === true && partOk && auditOk) {
        ok('launcher start: partition persist:auto-smoke-launch-1, endpoint inProcess');
      } else {
        bad(
          'launcher start: partition persist:auto-smoke-launch-1, endpoint inProcess',
          new Error('ep=' + JSON.stringify(ep) + ' partition=' + launchParts[0] + ' audit=' + auditOk)
        );
      }
    } catch (e) {
      bad('launcher start: partition persist:auto-smoke-launch-1, endpoint inProcess', e);
    }

    // v. acquire: cookie set/get in the partition session (+ flushStore for disk evidence)
    try {
      const h = launcher.acquire('smoke-launch-1');
      if (!h || !h.window || !h.electronSession) throw new Error('acquire shape');
      await h.electronSession.cookies.set({ url: 'https://example.org', name: 'rl2', value: 'v1' });
      let flush = 'ok';
      try {
        await h.electronSession.cookies.flushStore();
      } catch (e) {
        flush = 'fail:' + e.message;
      }
      const cs = await h.electronSession.cookies.get({ name: 'rl2' });
      if (cs.some((c) => c.value === 'v1')) ok('launcher acquire: cookie set/get rl2 (flushStore=' + flush + ')');
      else bad('launcher acquire: cookie set/get rl2', new Error('got=' + JSON.stringify(cs)));
    } catch (e) {
      bad('launcher acquire: cookie set/get rl2', e);
    }

    // w. stop destroys the window and clears the handle
    try {
      const before = BrowserWindow.getAllWindows().length;
      await launcher.stop('smoke-launch-1');
      const destroyed = !!launchWin && launchWin.isDestroyed();
      const after = BrowserWindow.getAllWindows().length;
      const stopAudit = launchAudit.some((e) => e.type === 'launcher-stop');
      if (destroyed && after === before - 1 && launcher.list().length === 0 && stopAudit) {
        ok('launcher stop: window destroyed (' + before + '->' + after + '), handle cleared');
      } else {
        bad(
          'launcher stop: window destroyed, handle cleared',
          new Error('destroyed=' + destroyed + ' before=' + before + ' after=' + after + ' list=' + launcher.list().length + ' audit=' + stopAudit)
        );
      }
    } catch (e) {
      bad('launcher stop: window destroyed, handle cleared', e);
    }

    // x. relaunch SAME profile id -> persist-partition cookie survives (core #30/#11 evidence)
    try {
      const ep2 = await launcher.start({ id: 'smoke-launch-1' });
      const h2 = launcher.acquire('smoke-launch-1');
      const cs2 = await h2.electronSession.cookies.get({ name: 'rl2' });
      const carried = cs2.find((c) => c.value === 'v1');
      const part2 = launchParts[1] === 'persist:auto-smoke-launch-1';
      if (ep2 && ep2.inProcess === true && carried && part2) {
        ok('relaunch same id: cookie rl2 survives persist partition');
      } else {
        bad(
          'relaunch same id: cookie rl2 survives persist partition',
          new Error('carried=' + JSON.stringify(carried) + ' partition=' + launchParts[1] + ' ep=' + JSON.stringify(ep2))
        );
      }
    } catch (e) {
      bad('relaunch same id: cookie rl2 survives persist partition', e);
    }
    try { await launcher.stop('smoke-launch-1'); } catch (_) {}

    try {
      if (es) await es.stop();
    } catch (_) {}
    console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    await new Promise((r) => setTimeout(r, 300)); // let piped stdout flush before exit
    clearTimeout(hardKill);
    destroyAll();
    process.exitCode = fail === 0 ? 0 : 1;
    try {
      app.exit(process.exitCode);
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 1), 2000); // bounded fallback if quit stalls
    try {
      app.exit(process.exitCode);
    } catch (_) {}
  } catch (e) {
    try {
      bad('harness-crash', e);
      console.log('SUMMARY pass=' + pass + ' fail=' + fail);
    } catch (_) {}
    try {
      clearTimeout(hardKill);
    } catch (_) {}
    destroyAll();
    process.exitCode = 1;
    try {
      app.exit(1);
    } catch (_) {
      process.exit(1);
    }
  }
}

main();
