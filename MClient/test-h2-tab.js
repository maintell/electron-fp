'use strict';
// Creating a tab FROM A PROFILE must apply that profile's HTTP/2 plane.
//
// This is the test that would have caught the gap: test-h2-plane.js proves the
// kernel works and the schema routes, but it calls fromPartition() directly.
// The TLS plane had exactly the same blind spot - every test went through the
// panel path, so createTabView() could drop the plane entirely and stay green.
// It was only found by opening a tab from a preset and measuring THAT tab.
//
// So: drive the real UI through window.api, create a tab from each preset, then
// parse the SETTINGS frame off that tab's own partition (fp-tab-<id>).
//
// It also pins the honesty rule. The H2 plane is frozen at partition creation,
// so changing it on a live tab cannot work. The product must SAY that rather
// than return success - a control that looks applied but is not is the worst
// outcome, because the panel then claims a fingerprint the session does not
// produce.

const { app, session, BrowserWindow } = require('electron');
const path = require('path');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

const T_SETTINGS = 0x04;
const isGrease = (id) => ((id >> 8) & 0x0f) === 0x0a && (id & 0x0f) === 0x0a;

// Electron quits when the last window is destroyed.
let keepAlive = null;

function selfSigned() {
  const os = require('os');
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const dir = path.join(os.tmpdir(), 'electron-fp-h2tab');
  fs.mkdirSync(dir, { recursive: true });
  const k = path.join(dir, 'key.pem'), c = path.join(dir, 'cert.pem');
  if (!fs.existsSync(k) || !fs.existsSync(c)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', k, '-out', c, '-days', '30', '-subj', '/CN=127.0.0.1'],
      { stdio: 'ignore', windowsHide: true });
  }
  return { key: fs.readFileSync(k), cert: fs.readFileSync(c) };
}

// Raw byte parse. Node's http2 server exposes SETTINGS as NAMED properties and
// drops unknown ids, so it cannot see GREASE - the exact signal under test.
function startProbe() {
  const tls = require('tls');
  const { key, cert } = selfSigned();
  return new Promise((resolve) => {
    let settle = null;
    const waited = new Promise((r) => { settle = r; });
    const srv = tls.createServer({ key, cert, ALPNProtocols: ['h2'] }, (sock) => {
      let buf = Buffer.alloc(0), done = false;
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (done || buf.length < 33) return;
        const rest = buf.subarray(24);
        let off = 0;
        while (off + 9 <= rest.length) {
          const len = (rest[off] << 16) | (rest[off + 1] << 8) | rest[off + 2];
          const type = rest[off + 3];
          const ps = off + 9;
          if (ps + len > rest.length) return;
          if (type === T_SETTINGS) {
            const pl = rest.subarray(ps, ps + len);
            const entries = [];
            for (let i = 0; i + 6 <= pl.length; i += 6) {
              entries.push([pl.readUInt16BE(i), pl.readUInt32BE(i + 2)]);
            }
            done = true;
            settle({ entries, grease: entries.filter(([i]) => isGrease(i)) });
            try { sock.end(); } catch (_) {}
            return;
          }
          off = ps + len;
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        wait: () => Promise.race([waited, new Promise((r) => setTimeout(() => r(null), 20000))]),
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

const probes = [];
async function measurePartition(partition) {
  const probe = await startProbe();
  probes.push(probe);
  // NOTE: deliberately NO fromPartition options here. This measures the
  // partition as the product left it. Passing a profile would work and prove
  // nothing about whether createTabView() supplied one.
  const sess = session.fromPartition(partition);
  sess.setCertificateVerifyProc((req, cb) => cb(0));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: sess },
  });
  win.loadURL(`https://127.0.0.1:${probe.port}/x`).catch(() => null);
  const rec = await probe.wait();
  try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  return rec;
}

// What each preset claims. Grounded in measured behaviour:
//   * Chromium GREASEs HTTP/2 SETTINGS; WebKit and Firefox do not.
//   * Coherent with each preset's TLS GREASE setting by construction.
const EXPECT = {
  'win10-chrome': true,
  'mobile-android': true,
  'macos-safari': false,
  'linux-firefox': false,
};

app.whenReady().then(async () => {
  keepAlive = new BrowserWindow({ show: false, width: 80, height: 80 });
  require(path.join(__dirname, 'main.js'));
  await new Promise((r) => setTimeout(r, 4000));

  const wins = BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && w !== keepAlive);
  ck('the client opened a window', wins.length > 0,
    wins.length ? wins[0].getTitle() : 'none');
  if (!wins.length) {
    console.log('\nFAIL: no window to drive');
    if (!keepAlive.isDestroyed()) keepAlive.destroy();
    app.exit(1); return;
  }
  const wc = wins[0].webContents;
  await new Promise((r) => setTimeout(r, 2500));

  const raw = await wc.executeJavaScript(
    `window.api.listProfiles().then(p => JSON.stringify(p))`, true)
    .catch((e) => 'ERR ' + e.message);
  let list = null;
  try { list = JSON.parse(raw); } catch (e) { /* left null */ }
  ck('listProfiles() resolves through the UI', Array.isArray(list),
    Array.isArray(list) ? list.length + ' profiles' : String(raw).slice(0, 70));
  if (!Array.isArray(list)) {
    console.log('\nFAIL: cannot proceed');
    if (!keepAlive.isDestroyed()) keepAlive.destroy();
    app.exit(1); return;
  }

  const named = list.filter((p) => p.id !== 'default' && p.fingerprint);
  ck('named presets exist with fingerprints', named.length >= 3, named.length + ' found');

  for (const pr of named) {
    const expect = EXPECT[pr.id];
    if (expect === undefined) continue;

    const created = await wc.executeJavaScript(
      `window.api.createTab(${JSON.stringify(pr.id)}).then(t => JSON.stringify(t))`, true)
      .catch((e) => 'ERR ' + e.message);
    let tabId = null;
    try { tabId = JSON.parse(created); } catch (e) { /* left null */ }
    if (!tabId) {
      ck(pr.id + ': a tab was created', false, String(created).slice(0, 70));
      continue;
    }
    await new Promise((r) => setTimeout(r, 1200));

    // Measure the tab's OWN partition, as the product built it.
    const rec = await measurePartition('fp-tab-' + tabId);
    if (!rec) {
      ck(pr.id + ': measured that tab\'s partition', false, 'no SETTINGS captured');
      continue;
    }
    const got = rec.grease.length > 0;
    ck(pr.id + ': HTTP/2 GREASE = ' + expect + ' (as the preset claims)',
      got === expect,
      'grease=' + rec.grease.length + ' of ' + rec.entries.length + ' SETTINGS entries' +
      (rec.grease.length ? ' [' + rec.grease.map(([i]) => '0x' + i.toString(16)).join(',') + ']' : ''));
  }

  // ---- the honesty rule: H2 cannot change on a live tab, so it must say so --
  const anyTab = await wc.executeJavaScript(
    `window.api.createTab('win10-chrome').then(t => JSON.stringify(t))`, true)
    .catch(() => null);
  let tab2 = null;
  try { tab2 = JSON.parse(anyTab); } catch (e) { /* left null */ }
  if (tab2) {
    await new Promise((r) => setTimeout(r, 1200));
    // Ask for the OPPOSITE of what the partition was built with.
    const applied = await wc.executeJavaScript(
      `window.api.setFingerprint(${JSON.stringify(tab2)}, ` +
      `{ settingsGrease: false, endStreamWithDataFrame: false }).then(r => JSON.stringify(r))`, true)
      .catch((e) => 'ERR ' + e.message);
    let res = null;
    try { res = JSON.parse(applied); } catch (e) { /* left null */ }
    const msg = (res && (res.h2Error || (typeof res === 'string' ? res : ''))) || '';
    ck('changing HTTP/2 on a live tab is reported, not silently accepted',
      /close and reopen|fixed when the tab is created/i.test(String(msg)),
      msg ? msg.slice(0, 90) : 'no warning returned (looks like success)');
  }

  for (const p of probes) { try { await p.close(); } catch (_) {} }
  console.log('\n' + (fail === 0
    ? 'PASS: ' + pass + ' checks'
    : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));
  if (!keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('ERROR: ' + (e && e.stack || e));
  if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy();
  app.exit(1);
});
