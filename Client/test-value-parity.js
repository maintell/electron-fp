// Exhaustive parity between the C++ is_set() in the Inspector and fpIsActive()
// in Client/fp-schema.js, across representative VALUE FORMS.
//
// The earlier parity test covers one config. That is not enough: the one bug
// found in this area (numeric keys holding the string "0") was a value-FORM
// bug, and there are more forms than that test tries. In particular I earlier
// dismissed a class of divergence - non-numeric keys holding 0/false - as
// "probes no real caller produces", without checking. This checks.
//
// JS fpIsActive(def, value):
//   null/undefined/""  -> false
//   numeric def        -> Number(value) !== 0
//   otherwise          -> String(value) !== String(def)   // def is ""
// So for a string-kind key, ANY present value is active - even 0 or false,
// because "0" !== "". A C++ test of `GetInt() != 0` / `GetBool()` would say
// inactive. That is the case under test.

const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const S = require("./fp-schema.js");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

const ALL_KEYS = Object.keys(S.FP_KEYS);

// Forms that a JSON round-trip, an editor or a hand-written profile can produce.
const FORMS = [
  { name: "int 0", v: 0 },
  { name: "int 1", v: 1 },
  { name: 'string "0"', v: "0" },
  { name: 'string "7"', v: "7" },
  { name: 'string "0.0"', v: "0.0" },
  { name: 'string " 0 " (padded)', v: " 0 " },
  { name: 'string "0x0" (hex)', v: "0x0" },
  { name: 'string ""', v: "" },
  { name: 'string "x"', v: "x" },
  { name: "bool false", v: false },
  { name: "bool true", v: true },
];

const buildCfg = (v) => {
  const c = {};
  for (const k of ALL_KEYS) c[k] = v;
  return c;
};

let srv, url, keepAlive, win, sess;

async function readCpp() {
  const loaded = await new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, err: "timeout" }), 20000);
    win.webContents.once("did-finish-load", () => { clearTimeout(t); res({ ok: true }); });
    // reloadIgnoringCache: the data source builds fresh per request, but the
    // page itself must not come from cache or we would read a stale config.
    win.webContents.reloadIgnoringCache();
  });
  if (!loaded.ok) return { error: loaded.err };
  const j = await win.webContents.executeJavaScript(
    "JSON.stringify({cov:(window.__fp||{}).coverage,s:(window.__fp||{}).summary})");
  return JSON.parse(j);
}

(async () => {
  srv = http.createServer((q, r) => {
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end("<html><body>vp</body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + srv.address().port + "/";
  await app.whenReady();

  // Electron quits when the last window closes; keep one alive.
  keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

  sess = session.fromPartition("persist:value-parity");
  win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { session: sess, sandbox: false, nodeIntegration: false },
  });
  const first = await new Promise((res) => {
    win.webContents.on("did-fail-load", (e, c, d) => res({ ok: false, err: d }));
    win.webContents.once("did-finish-load", () => res({ ok: true }));
    win.loadURL("electron://fingerprint/");
  });
  if (!first.ok) {
    console.log("FAIL  Inspector unreachable: " + first.err);
    app.exit(1);
    return;
  }

  const results = [];
  for (const f of FORMS) {
    const cfg = buildCfg(f.v);
    sess.setFingerprintConfig(cfg);
    const cpp = await readCpp();
    if (cpp.error) { ck("[" + f.name + "] readable", false, cpp.error); continue; }

    // Sanity: the C++ must have actually re-read the config. If reload is not
    // picking changes up, every form would report the same numbers.
    const jsCov = S.fpCoverage(cfg);
    const jsTotal = jsCov.reduce((n, g) => n + g.active, 0);

    const mism = [];
    for (const g of jsCov) {
      const c = (cpp.cov || []).find((x) => x.id === g.id);
      if (!c || c.active !== g.active) {
        mism.push(g.id + " C++=" + (c ? c.active : "?") + " JS=" + g.active);
      }
    }
    results.push({ name: f.name, cpp: cpp.s.active, js: jsTotal });
    ck("[" + f.name + "] coverage matches fpCoverage()",
      mism.length === 0,
      mism.length ? mism.slice(0, 3).join("; ") : "total " + jsTotal + " active");
  }

  // The reload sanity check: two forms MUST differ, or the whole run above was
  // reading a stale page and every "match" is meaningless.
  const byName = {};
  for (const r of results) byName[r.name] = r.cpp;
  ck("reload actually re-reads config (0 vs 1 differ)",
    byName["int 0"] !== byName["int 1"],
    'int0=' + byName["int 0"] + " int1=" + byName["int 1"]);

  srv.close();
  try { await win.destroy(); } catch (e) {}
  try { await keepAlive.destroy(); } catch (e) {}
  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  threw: " + (e && e.message));
  try { srv && srv.close(); } catch (x) {}
  app.exit(1);
});
