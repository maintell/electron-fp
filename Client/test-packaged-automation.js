// Does the packaged automation runtime match the source, and does it load?
//
// out/Default/resources/automation is a HAND-MAINTAINED copy of automation/
// {electron,runtime}. It is where Client/main.js's one-liner resolves from the
// packaged app:
//   resources/app/main.js -> require('../automation/electron/wire')
//                         -> resources/automation/electron/wire.js
// Without it, the packaged (default electron.exe) run attaches no IPC bridge
// and the automation panel degrades to its "not available" state.
//
// Checks:
//   1. every .js in automation/{electron,runtime} exists in the copy, byte-equal
//   2. the copy holds no extra .js the source does not (dead weight / drift)
//   3. the copy is loadable and functional: buildLocalStack + attachAutomation
//      against a stub ipcMain, plus one real service call
//
// Run: `node Client/test-packaged-automation.js` (no Electron needed), or via
// run-tests.js - the resources/app stash does NOT touch resources/automation.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO_AUTO = path.resolve(__dirname, "..", "automation");
const DEFAULT_AUTO = "F:/code/src/out/Default/resources/automation";
const AUTO = process.env.FP_AUTOMATION_DIR || DEFAULT_AUTO;

let pass = 0, fail = 0, skip = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

if (!fs.existsSync(AUTO)) {
  skip++;
  console.log("SKIP  packaged automation copy  (" + AUTO + " not present - not packaged here)");
  console.log("\nPASS: " + pass + " checks, " + skip + " skipped");
  process.exit(0);
}

// --- 1/2. file set + byte parity (.js only; the trees hold nothing else) ----
for (const dir of ["electron", "runtime"]) {
  const srcDir = path.join(REPO_AUTO, dir);
  const dstDir = path.join(AUTO, dir);
  if (!fs.existsSync(dstDir)) { ck("packaged automation/" + dir + " exists", false, "missing"); continue; }
  const src = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort();
  const dst = fs.readdirSync(dstDir).filter((f) => f.endsWith(".js")).sort();
  const missing = src.filter((f) => !dst.includes(f));
  const extra = dst.filter((f) => !src.includes(f));
  ck("automation/" + dir + ": no missing files", missing.length === 0, missing.join(", ") || src.length + " files");
  ck("automation/" + dir + ": no extra files", extra.length === 0, extra.join(", ") || "none");
  const stale = src.filter((f) => dst.includes(f) &&
    !fs.readFileSync(path.join(srcDir, f)).equals(fs.readFileSync(path.join(dstDir, f))));
  ck("automation/" + dir + ": all files byte-equal", stale.length === 0, stale.join(", ") || "ok");
}

// --- 2b. module-type marker + root hygiene ---------------------------------
// out/Default/package.json is type:module (TS toolchain guard). Without a
// nearer marker Node resolves resources/automation/**/*.js as ESM and the
// app's require('../automation/...') throws - swallowed by the one-liner's
// try/catch, so the failure is silent. The copy must carry the CommonJS marker.
const rootExtra = fs.readdirSync(AUTO).filter((n) => !["electron", "runtime", "package.json"].includes(n));
ck("automation/: no extra root entries", rootExtra.length === 0, rootExtra.join(", ") || "none");
try {
  const srcPkg = fs.readFileSync(path.join(REPO_AUTO, "package.json"));
  const dstPkg = fs.readFileSync(path.join(AUTO, "package.json"));
  const same = srcPkg.equals(dstPkg);
  ck("automation/package.json byte-equal", same, same ? "ok" : "copy differs");
  ck("automation/package.json pins commonjs", JSON.parse(dstPkg.toString()).type === "commonjs");
} catch (e) {
  ck("automation/package.json (module-type marker)", false, (e && e.message) || String(e));
}

// --- 3. loadable + functional ----------------------------------------------
try {
  const wire = require(path.join(AUTO, "electron", "wire.js"));
  const { service } = wire.buildLocalStack({ file: path.join(os.tmpdir(), "fp-automation-guard-store.json") });
  const st = service.status();
  ck("packaged wire builds a service (status ok)", !!(st && st.ok), JSON.stringify(st && st.error));
  const { registered } = wire.attachAutomation({
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    service, audit: () => {}, allowedSenders: [{ urlPrefix: "file://" }],
  });
  ck("packaged wire attaches to an ipcMain-like", Array.isArray(registered) && registered.length > 0,
    (registered || []).length + " channels");
  const scripts = service.scripts.list();
  ck("packaged service answers scripts.list", !!(scripts && scripts.ok), JSON.stringify(scripts && scripts.error));
} catch (e) {
  ck("packaged automation runtime loads", false, (e && e.message) || String(e));
}

console.log("\n" + (fail === 0
  ? "PASS: " + pass + " checks (packaged automation runtime in sync + loadable)"
  : "FAIL: " + fail + " of " + (pass + fail)));
process.exit(fail === 0 ? 0 : 1);
