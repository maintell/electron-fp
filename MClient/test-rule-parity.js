// Parity between the C++ consistency rules in the Inspector and the JS rule
// set in browser-profile.js.
//
// The Inspector reimplements all 8 rules in C++ (the kernel has no JS). Nothing
// compared the two until now: test-browser-profile.js is PURE JS and never
// touches the C++, and test-inspector.js only checked the C++ against
// hand-written expectations. Two real divergences shipped as a result:
//
//   1. vendor_for_ua invented a Firefox/Edg/CriOS special case that is not in
//      fpVendorForUserAgent(), so Firefox UAs derived vendor "" instead of
//      "Google Inc." - and the rule SKIPPED instead of FAILED. A rule that
//      skips renders as clean.
//   2. fpUaMetadataForUserAgent() returns NULL for a UA it cannot classify, and
//      both rules reading `mobile` guard on that. The C++ collapsed null into
//      "false", turning an unclassifiable UA into a definite desktop - so rule 5
//      could emit a warning the JS never would.
//
// This file drives BOTH implementations with the same profile and UA corpus and
// compares findings id-for-id, including which rules skipped.

const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const bp = require("./browser-profile.js");
const S = require("./fp-schema.js");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

// Deliberately includes UAs that fpUaMetadataForUserAgent() cannot classify,
// plus Firefox (the vendor bug) and mobile/desktop variants.
const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "curl/8.4.0",
  "SomeCustomBot/1.0",
];

// Enough config to let every rule evaluate on at least some UAs.
const CFG = {
  navigator_platform: "Win32",
  navigator_vendor: "Google Inc.",
  ua_mobile: "false",
  ua_platform: "Windows",
  max_touch_points: 0,
  device_memory: 7,
  screen_width: 1920,
  screen_height: 1080,
  screen_avail_width: 1920,
  webrtc_ip: "1.2.3.4",
  net_effective_type: "4g",
};

let srv, url, win;

async function cppConsistency(ua, cfg) {
  const part = "par-" + Math.random().toString(36).slice(2);
  const sess = session.fromPartition(part);
  sess.setUserAgent(ua);
  sess.setFingerprintConfig(cfg);
  const w = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { session: sess, sandbox: false, nodeIntegration: false },
  });
  const loaded = await new Promise((res) => {
    w.webContents.on("did-fail-load", (e, c, d) => res({ ok: false, err: d }));
    w.webContents.on("did-finish-load", () => res({ ok: true }));
    w.loadURL("electron://fingerprint/");
  });
  if (!loaded.ok) { await w.destroy(); return { error: loaded.err }; }
  const j = await w.webContents.executeJavaScript(
    "JSON.stringify((window.__fp||{}).consistency)");
  await w.destroy();
  return JSON.parse(j);
}

const sig = (c) => (c.findings || []).map((f) => f.id + ":" + f.severity).sort().join("|");
const skipSig = (c) => (c.skipped || []).map((s) => s.id).sort().join("|");

(async () => {
  srv = http.createServer((q, r) => {
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end("<html><body>parity</body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + srv.address().port + "/";
  await app.whenReady();
  // Electron quits when the last window closes, and constructing a window after
  // the main loop has exited is a FATAL CHECK. Hold one window open for the
  // whole run so destroying each probe window cannot end the app.
  const keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

  // createProfile takes a spec object (id/name/config), not a bare string.
  const base = bp.createProfile({ id: "parity" });
  const withCfg = bp.withConfig(base, CFG);

  for (const ua of UAS) {
    const short = ua.slice(0, 44).replace(/\s+/g, " ");
    // JS: profile.userAgent is the field rules read (not a config key).
    const jsProfile = Object.assign({}, withCfg, { userAgent: ua });
    const js = bp.checkConsistency(jsProfile);
    const cpp = await cppConsistency(ua, CFG);

    if (cpp.error) {
      ck("[" + short + "] C++ reachable", false, cpp.error);
      continue;
    }
    ck("[" + short + "] findings match JS",
      sig(cpp) === sig(js),
      "C++[" + sig(cpp) + "] JS[" + sig(js) + "]");
    ck("[" + short + "] skipped rules match JS",
      skipSig(cpp) === skipSig(js),
      "C++[" + skipSig(cpp) + "] JS[" + skipSig(js) + "]");
    ck("[" + short + "] error/warn counts match JS",
      cpp.errorCount === js.errorCount && cpp.warnCount === js.warnCount,
      "C++ e=" + cpp.errorCount + " w=" + cpp.warnCount +
        " JS e=" + js.errorCount + " w=" + js.warnCount);
  }

  srv.close();
  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  threw: " + (e && e.message));
  try { srv && srv.close(); } catch (x) {}
  app.exit(1);
});
