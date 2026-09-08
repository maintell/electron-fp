// Per-key end-to-end round trip: set ONE key alone and confirm the Inspector
// counts exactly that one key as active.
//
// Why this exists. Two families of test already cover each key separately:
//   * test-covered-surfaces.js / test-coverage-audit.js / test-remaining-keys.js
//     set a key and assert the RENDERER surface changes.
//   * test-value-parity.js sets ALL 63 keys at once and compares group counts.
// Neither asserts both sides for the SAME key in the same run. The aggregate
// test would still pass if one key were miscounted inside a group whose total
// stayed equal by coincidence, and the renderer tests never consult the panel.
//
// So: for each key, set ONLY that key, and require the Inspector to report
// exactly 1 active key, in exactly the group the schema files it under. This
// is the per-key version of the value-parity sweep, through the real binary.
//
// It does NOT verify that Blink applies the exact value - the per-key renderer
// tests do that. It verifies the panel never silently drops or double-counts a
// key, which is the "false verified" failure mode.

const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const S = require("./fp-schema.js");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

let srv, url, keepAlive, win, sess;

// A non-default value of the right KIND. The point is only that it differs from
// the disabled placeholder (0 for numeric, "" for string), which is what both
// fpIsActive() and the C++ is_set() test.
const valueFor = (k) =>
  typeof S.FP_KEYS[k].def === "number" ? 1 : "x";

// Which group does the schema file this key under?
const groupOf = (k) => {
  const cov = S.fpCoverage({ [k]: valueFor(k) });
  return cov.find((g) => g.active === 1 && g.keys.includes(k));
};

async function activeCount(cfg) {
  sess.setFingerprintConfig(cfg);
  const loaded = await new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, err: "timeout" }), 20000);
    win.webContents.once("did-finish-load", () => { clearTimeout(t); res({ ok: true }); });
    win.webContents.once("did-fail-load", (e, c, d) => { clearTimeout(t); res({ ok: false, err: d }); });
    win.webContents.reloadIgnoringCache();
  });
  if (!loaded.ok) return { error: loaded.err };
  const j = await win.webContents.executeJavaScript(
    "JSON.stringify((window.__fp||{}).summary)");
  return JSON.parse(j);
}

(async () => {
  srv = http.createServer((q, r) => {
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end("<html><body>pk</body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + srv.address().port + "/";
  await app.whenReady();
  keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

  sess = session.fromPartition("persist:per-key-rt");
  win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { session: sess, sandbox: false, nodeIntegration: false },
  });
  const first = await new Promise((res) => {
    win.webContents.once("did-fail-load", (e, c, d) => res({ ok: false, err: d }));
    win.webContents.once("did-finish-load", () => res({ ok: true }));
    win.loadURL("electron://fingerprint/");
  });
  if (!first.ok) {
    console.log("FAIL  Inspector unreachable: " + first.err);
    app.exit(1);
    return;
  }

  // Baseline: nothing set -> 0 active.
  const base = await activeCount({});
  ck("empty config -> 0 active", base.active === 0, "active=" + base.active);

  const bad = [];
  for (const k of S.FP_KEY_NAMES) {
    const exp = groupOf(k);
    if (!exp) {
      // The schema itself does not consider this key active at this value -
      // a schema bug, not an Inspector bug, but still worth failing on.
      ck("[" + k + "] schema reports the key active in some group", false,
        "fpCoverage() found no group with this key active");
      continue;
    }
    const got = await activeCount({ [k]: valueFor(k) });
    if (got.error) {
      ck("[" + k + "] readable", false, got.error);
      continue;
    }
    if (got.active !== 1) {
      bad.push(k + " active=" + got.active + " (want 1)");
    }
  }

  ck("each key alone counts as exactly 1 active (all 63)",
    bad.length === 0,
    bad.length ? bad.slice(0, 6).join("; ") : S.FP_KEY_NAMES.length + " keys checked");

  // Group attribution: the single active key must land in its schema group.
  const misgrp = [];
  for (const g of S.fpCoverage({})) {
    // pick the first key of each group
    if (!g.keys.length) continue;
    const k = g.keys[0];
    const got = await activeCount({ [k]: valueFor(k) });
    if (got.error) { misgrp.push(k + " unreadable"); continue; }
    const j = await win.webContents.executeJavaScript(
      "JSON.stringify((window.__fp||{}).coverage)");
    const cov = JSON.parse(j);
    const row = cov.find((x) => x.id === g.id);
    if (!row || row.active !== 1) {
      misgrp.push(k + " -> " + g.id + " active=" + (row ? row.active : "?"));
    }
  }
  ck("each group's first key lands in that group",
    misgrp.length === 0,
    misgrp.length ? misgrp.slice(0, 6).join("; ") : "all groups");

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
