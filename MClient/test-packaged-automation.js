// Does MClient's packaged automation runtime match the source, and does it load?
//
// MClient/dist/resources/automation is a HAND-MAINTAINED copy of automation/
// {electron,runtime} — it is where MClient/main.js's wireAutomation() resolves
// from the packaged app:
//   MClient/dist/resources/app/main.js -> require('../automation/electron/wire')
//                                     -> dist/resources/automation/electron/wire.js
// Without it, the packaged MClient attaches no IPC bridge (silently swallowed by
// the try/catch) and the automation panel degrades to "not available".
//
// Mirror of Client/test-packaged-automation.js (same 12 checks), pointed at
// MClient's packaged copy. Run: `node MClient/test-packaged-automation.js`
// (no Electron needed); FP_AUTOMATION_DIR overrides the copy path.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO_AUTO = path.resolve(__dirname, "..", "automation");
const DEFAULT_AUTO = path.resolve(__dirname, "dist", "resources", "automation");
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

try {
  const wire = require(path.join(AUTO, "electron", "wire.js"));
  const { service } = wire.buildLocalStack({ file: path.join(os.tmpdir(), "fp-mclient-automation-guard-store.json") });
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
  ? "PASS: " + pass + " checks (MClient packaged automation runtime in sync + loadable)"
  : "FAIL: " + fail + " of " + (pass + fail)));
process.exit(fail === 0 ? 0 : 1);
