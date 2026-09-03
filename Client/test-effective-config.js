// Does the Inspector's coverage claim match what the renderer ACTUALLY applies?
//
// The two sides resolve the two config stores (session-level SessionPreferences
// vs per-tab WebContentsPreferences) with DIFFERENT rules:
//
//   renderer  (electron_browser_client.cc ~L700)
//     fp_b64 = wc;  if (wc.empty()) fp_b64 = session;
//     -> WHOLE-config: a non-empty per-tab config REPLACES the session config.
//
//   Inspector (fingerprint_ui.cc ~L357)
//     for (k,v in wc) config.Set(k,v);
//     -> PER-KEY overlay: the per-tab config is MERGED onto the session config.
//
// They agree only when the per-tab config is empty or a superset. When a tab
// sets SOME keys and the session sets OTHERS, the renderer applies only the
// tab's keys while the Inspector reports the union - so the panel shows
// surfaces as configured that are genuinely NOT spoofed. That is a false
// "verified" reading: the exact failure mode this panel exists to prevent.
//
// The Inspector exposes no per-key values, only counts, so this compares the
// coverage COUNT against renderer-observed reality. A merge bug shows up as the
// Inspector counting session keys the renderer demonstrably ignored.

const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const S = require("./fp-schema.js");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

let srv, url, keepAlive;

const PROBE = `(function () {
  return {
    platform: navigator.platform,
    vendor: navigator.vendor,
    hw: navigator.hardwareConcurrency,
    lang: navigator.language,
    cd: screen.colorDepth
  };
})()`;

const mkWindow = (sess, wcCfg) => new BrowserWindow({
  show: false, width: 800, height: 600,
  webPreferences: Object.assign(
    { session: sess, sandbox: false, nodeIntegration: false },
    wcCfg ? { fingerprint: wcCfg } : {}),
});

function load(w, target) {
  return new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, err: "timeout" }), 20000);
    w.webContents.once("did-fail-load", (e, c, d) => { clearTimeout(t); res({ ok: false, err: d }); });
    w.webContents.once("did-finish-load", () => { clearTimeout(t); res({ ok: true }); });
    w.loadURL(target);
  });
}

async function observe(opts) {
  const sess = session.fromPartition("eff-" + Math.random().toString(36).slice(2));
  if (opts.sessionCfg) sess.setFingerprintConfig(opts.sessionCfg);
  const w = mkWindow(sess, opts.wcCfg);
  const l = await load(w, url);
  if (!l.ok) { await w.destroy(); return { error: l.err }; }
  const seen = await w.webContents.executeJavaScript(PROBE);
  await w.destroy();
  return { seen };
}

async function inspect(opts) {
  const sess = session.fromPartition("insp-" + Math.random().toString(36).slice(2));
  if (opts.sessionCfg) sess.setFingerprintConfig(opts.sessionCfg);
  const w = mkWindow(sess, opts.wcCfg);
  const l = await load(w, "electron://fingerprint/");
  if (!l.ok) { await w.destroy(); return { error: l.err }; }
  const j = await w.webContents.executeJavaScript(
    "JSON.stringify({s:(window.__fp||{}).summary,wc:(window.__fp||{}).webContentsConfigs})");
  await w.destroy();
  return JSON.parse(j);
}

(async () => {
  srv = http.createServer((q, r) => {
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end("<html><body>eff</body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + srv.address().port + "/";
  await app.whenReady();
  keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

  // Session sets platform+hw; the tab sets ONLY vendor. Disjoint keys - the
  // case where whole-config and per-key-merge disagree.
  const SESSION_CFG = { navigator_platform: "SessionOS", hardware_concurrency: 3 };
  const WC_CFG = { navigator_vendor: "WCvendor" };

  // --- baseline A: session only -> both stores agree -----------------------
  {
    const o = await observe({ sessionCfg: SESSION_CFG });
    ck("session-only: renderer applies the session config",
      o.seen && o.seen.platform === "SessionOS" && o.seen.hw === 3,
      JSON.stringify(o.seen || o.error));
  }
  // --- baseline B: per-tab only -> both stores agree -----------------------
  {
    const o = await observe({ wcCfg: WC_CFG });
    ck("per-tab-only: renderer applies the per-tab config",
      o.seen && o.seen.vendor === "WCvendor",
      JSON.stringify(o.seen || o.error));
  }
  // --- the case under test: BOTH set, disjoint keys ------------------------
  let rendererUsesSessionKeys = null;
  {
    const o = await observe({ sessionCfg: SESSION_CFG, wcCfg: WC_CFG });
    if (o.error) {
      ck("split config: renderer reachable", false, o.error);
    } else {
      rendererUsesSessionKeys =
        o.seen.platform === "SessionOS" || o.seen.hw === 3;
      ck("split config: renderer applies the per-tab config",
        o.seen.vendor === "WCvendor",
        "vendor=" + o.seen.vendor);
      // Recorded, not asserted: whether the renderer honours the session keys
      // here is the renderer's documented behaviour (whole-config precedence).
      // The assertion that matters is the Inspector agreeing with it, below.
      console.log("info    renderer honours session keys when a per-tab config " +
        "exists: " + rendererUsesSessionKeys +
        " (platform=" + o.seen.platform + " hw=" + o.seen.hw + ")");
    }
  }
  // --- what the Inspector claims for the SAME configuration ----------------
  {
    const only = await inspect({ wcCfg: WC_CFG });
    const both = await inspect({ sessionCfg: SESSION_CFG, wcCfg: WC_CFG });
    if (only.error || both.error) {
      ck("split config: Inspector reachable", false,
        String((only.error || "") + (both.error || "")));
    } else {
      const delta = both.s.active - only.s.active;
      console.log("info    Inspector active count: per-tab-only=" + only.s.active +
        " session+per-tab=" + both.s.active + " delta=" + delta);
      // If the renderer ignored the session keys (delta would be 2 under a
      // merge) then the Inspector must not count them either.
      ck("split config: Inspector active count matches renderer reality",
        rendererUsesSessionKeys === null ? false : (delta === (rendererUsesSessionKeys ? 2 : 0)),
        "expected delta " + (rendererUsesSessionKeys ? 2 : 0) + " got " + delta);
      ck("split config: Inspector sees the per-tab config",
        both.wc >= 1, "webContentsConfigs=" + both.wc);
    }
  }

  srv.close();
  try { await keepAlive.destroy(); } catch (e) {}
  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  threw: " + (e && e.message));
  try { srv && srv.close(); } catch (x) {}
  app.exit(1);
});
