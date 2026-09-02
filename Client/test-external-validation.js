#!/usr/bin/env node
// Constraint 12: external validation.
//
// Everything until now was validated against OUR OWN parser and OUR OWN probe.
// That proves internal consistency - the kernel does what the tests ask - but
// it cannot catch the failure that actually matters: a fingerprint that is
// perfectly self-consistent while NOT matching the real browser it claims to
// be. Only a third party that did not read our source can do that.
//
// So this loads browserleaks.com / creepjs in the real Electron build and
// reports what THEY observe.
//
// Deliberately NOT a hard pass/fail gate on the numbers: external sites change,
// and a brittle assertion on a third party's output would fail for reasons
// unrelated to this codebase. What IS asserted is that the run is USABLE - the
// pages load and produce readings - because a validation that silently
// collected nothing is worse than none at all.
//
// NOTE ON NETWORK: runs through a sandbox proxy whose certificate we do not
// have in the trust store, so cert errors are ignored for THIS script only.
// That weakens TLS for validation traffic; it does not affect the fingerprint
// readings being collected, and no other test does this.

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');

// Letting the default window-all-closed handler quit the app races with
// Chromium's spare-renderer warmup, producing the shutdown FATAL
//   render_process_host_impl.cc:1725 Check failed:
//   !BrowserMainRunner::ExitedMainMessageLoop()
// and a non-zero exit code after every check had already passed. Same guard as
// test-probe-realism.js / test-tls-fingerprint.js.
app.on('window-all-closed', (e) => { e.preventDefault(); });

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return; }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

// Only the machine-readable TLS endpoint is kept as a hard gate.
//
// The HTML pages (browserleaks.com/ssl, creepjs.com) were in the first version
// and made the suite flaky: through this sandbox's proxy they return
// ERR_FAILED / ERR_CONNECTION_CLOSED intermittently while tls.browserleaks.com
// is reliably reachable. A gate that fails for network reasons unrelated to
// this codebase is worse than no gate - it trains you to ignore failures.
//
// They remain valuable for INTERACTIVE inspection, so they are attempted and
// reported, but never counted in pass/fail. See also: the JSON endpoint is
// strictly better for assertions anyway, since it exposes ja4_r - the decoded
// raw cipher/extension lists - which is what we actually compare against.
const TARGETS = [
  { name: 'browserleaks-tls', url: 'https://tls.browserleaks.com/json', gate: true },
  { name: 'browserleaks-html', url: 'https://www.browserleaks.com/ssl', gate: false },
  { name: 'creepjs', url: 'https://creepjs.com/', gate: false },
];

const live = new Set();
let shuttingDown = false;

/**
 * Constructing a BrowserWindow after the main message loop has exited is a
 * FATAL CHECK in Chromium:
 *   render_process_host_impl.cc:1725 Check failed: !BrowserMainRunner::
 *   ExitedMainMessageLoop()
 * An unreachable target whose pending timer fires during shutdown therefore
 * aborts the whole process with a non-zero exit code - even though every check
 * passed. That masks real failures, so nothing may create a window (or run any
 * deferred work) once shutdown has begun.
 */
function loadJson(win, url, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    win.webContents.once('did-finish-load', () => {
      // Give client-side fingerprinting scripts a moment to populate.
      setTimeout(async () => {
        if (shuttingDown) return finish({ ok: false, reason: 'shutting down' });
        try {
          const txt = await win.webContents.executeJavaScript('document.body.innerText', true);
          finish({ ok: true, text: txt });
        } catch (e) {
          finish({ ok: false, reason: String(e && e.message) });
        }
      }, 4000);
    });
    if (shuttingDown) return finish({ ok: false, reason: 'shutting down' });
    win.loadURL(url).catch((e) => finish({ ok: false, reason: String(e && e.message) }));
  });
}

(async () => {
  try {
    await app.whenReady();

    // Sandbox proxy uses a cert we do not trust; needed to reach any of this.
    session.defaultSession.setCertificateVerifyProc((req, cb) => cb(0));

    for (const t of TARGETS) {
      if (shuttingDown) break;
      const win = new BrowserWindow({ show: false, width: 1400, height: 1000,
        webPreferences: { sandbox: false, offscreen: false } });
      live.add(win);
      const r = await loadJson(win, t.url);
      if (!r.ok) {
        // Non-gate targets are informational: report, do not fail.
        if (t.gate) check('external: ' + t.name + ' loaded', false, r.reason);
        else console.log('INFO  external: ' + t.name + ' unavailable (' + r.reason + ') - not gated');
        continue;
      }
      const text = r.text || '';
      console.log('\n===== ' + t.name + ' (' + text.length + ' chars) =====');
      // Do NOT truncate: the TLS extension list is the whole point of the
      // check, and it is printed last. Truncating it here silently discarded
      // exactly the data needed to compare against our local baseline.
      console.log(text.replace(/\n{3,}/g, '\n\n'));
      check('external: ' + t.name + ' produced readings', text.trim().length > 40,
        text.length + ' chars');

      // The UA we advertise must be what the third party observes - otherwise
      // every other reading it gives us is describing a different browser.
      const ua = win.webContents.getUserAgent();
      const uaMajor = (ua.match(/Chrome\/(\d+)/) || [])[1];
      if (uaMajor) {
        check('external: ' + t.name + ' sees our Chrome major (' + uaMajor + ')',
          text.includes(uaMajor), text.includes(uaMajor) ? 'present' : 'absent');
      }

      // THE COMPARISON THAT MATTERS: decode ja4_r (the raw sorted cipher and
      // extension lists) and compare against our locally recorded baseline.
      // This is the only check here that can catch a self-consistent-but-wrong
      // fingerprint, which is exactly what internal tests cannot see.
      if (t.gate) {
        const m = text.match(/"ja4_r"\s*:\s*"([^"]+)"/);
        if (!m) {
          check('external: ja4_r present for baseline comparison', false, 'not found');
        } else {
          const fields = m[1].split('_');
          const extCiphers = fields[1].split(',').sort();
          const extExts = fields[2].split(',').sort();
          let base = null;
          try {
            base = JSON.parse(fs.readFileSync(
              path.join(__dirname, 'baselines', 'tls-baseline.json'), 'utf8'));
          } catch (_) { /* handled below */ }
          if (!base) {
            check('external: baseline available for comparison', false, 'baseline unreadable');
          } else {
            const hex = (n) => n.toString(16).padStart(4, '0');
            const locCip = base.raw.ja4Fields.sortedCiphers.map(hex).sort();
            const locExt = base.raw.ja4Fields.extSorted.map(hex).sort();

            const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
            check('external: cipher set MATCHES our local baseline',
              eq(locCip, extCiphers),
              'local=' + locCip.length + ' external=' + extCiphers.length +
              (eq(locCip, extCiphers) ? '' :
                ' diff=[' + locCip.filter((x) => !extCiphers.includes(x))
                  .concat(extCiphers.filter((x) => !locCip.includes(x))).join(' ') + ']'));

            // Extensions may differ by SNI (0x0000) in EITHER direction, so
            // accept both exact-match and a lone-0000 delta:
            //   - baseline captured against 127.0.0.1  -> external has SNI, local does not
            //   - baseline captured against a hostname -> local has SNI, external may not
            // Chromium omits SNI for an IP literal; test-probe-realism.js pins
            // this. Anything beyond that one extension is a real discrepancy.
            const SNI = '0000';
            const onlyExt = extExts.filter((x) => !locExt.includes(x));
            const onlyLoc = locExt.filter((x) => !extExts.includes(x));
            const ignorable = (arr) => arr.length === 0 ||
              (arr.length === 1 && arr[0] === SNI);
            const ok = ignorable(onlyExt) && ignorable(onlyLoc);
            check('external: extension set matches local baseline '
              + '(allowing only the known SNI/0000 delta)',
              ok,
              ok ? 'local=' + locExt.length + ' external=' + extExts.length
                 + (onlyExt.concat(onlyLoc).length
                    ? ' sniDelta=' + onlyExt.concat(onlyLoc).join(' ') : ' exact')
                 : 'onlyExternal=[' + onlyExt.join(' ') + '] onlyLocal=[' + onlyLoc.join(' ') + ']');
          }
        }
      }
      try { win.destroy(); } catch (_) {}
      live.delete(win);
    }

    // Set the flag BEFORE tearing down: any deferred work still pending (an
    // unreachable target's timer, a did-finish-load that lands late) must not
    // construct a window or touch webContents during shutdown. See loadJson().
    shuttingDown = true;
    for (const w of [...live]) { live.delete(w); try { w.destroy(); } catch (_) {} }
    await new Promise((r) => setTimeout(r, 300));
    console.log('');
    console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
    // app.exit(), NOT process.exit(): process.exit() tears the process down
    // without letting Electron shut the browser down, and anything still
    // creating a window during that window hits
    //   render_process_host_impl.cc:1725 Check failed: !BrowserMainRunner::
    //   ExitedMainMessageLoop()
    // which aborts with a non-zero exit code even though every check passed.
    // A non-zero exit from a passing suite hides real failures, so it matters.
    app.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log('FAIL  threw: ' + (e && e.message));
    for (const w of [...live]) { try { w.destroy(); } catch (_) {} }
    app.exit(1);
  }
})();
