// Guard against the failure that caused the white screen.
//
// out/Default/resources/app is a HAND-MAINTAINED copy of Client/ - no build
// rule generates it (verified: nothing in the repo writes to resources/app).
// When it drifts behind Client/, electron.exe launches the stale copy, and if
// the stale fp-schema.js lacks an export that main.js destructures at module
// load, the app throws before creating a window. Result: a white screen, while
// the test suite stays green - because the tests run Client/ directly.
//
// Root cause of the 2026-08-31 white screen: the copy was the 56-key version,
  // (historical: 56 was correct when this was written - the copy predated
  //  the ua_* keys. Do NOT update it to the current schema count.)
// missing FP_UA_PRESETS / fpRandomUserAgent / fpNormalizeUserAgent /
// fpPlatformForUserAgent. main.js destructures all four at the top level.
//
// This checks the two properties that actually matter:
//   1. every name main.js imports from fp-schema exists in the copy
//   2. the copy's key count matches the source
// Code files are compared by content; profiles.json is EXCLUDED because the
// copy legitimately holds user-created profiles that the source does not.

const fs = require("fs");
const path = require("path");
const schema = require("./fp-schema.js");

// run-tests.js moves resources/app aside before running the suite (otherwise
// electron.exe launches the packaged app instead of the test file), so under
// the suite this check would always skip. Look at the stashed name too when
// the real one is absent - that is where the copy actually is mid-run.
const DEFAULT_APP = "F:/code/src/out/Default/resources/app";
const APP = process.env.FP_APP_DIR ||
  (fs.existsSync(DEFAULT_APP) ? DEFAULT_APP : DEFAULT_APP.replace(/app$/, "_app_off"));

let pass = 0, fail = 0, skip = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};
const sk = (n, why) => { console.log("SKIP  " + n + "  (" + why + ")"); skip++; };

if (!fs.existsSync(APP)) {
  sk("packaged app copy in sync", APP + " not present (not packaged here)");
  console.log("\nPASS: " + pass + " checks, " + skip + " skipped");
  process.exit(0);
}

// The names main.js pulls out of fp-schema at module scope. Read them from the
// source rather than hardcoding, so adding an import updates this check.
const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const dm = /const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\/fp-schema['"]\)/.exec(mainSrc);
if (!dm) {
  console.log("FAIL  could not find the fp-schema destructure in main.js");
  process.exit(1);
}
const imported = dm[1].split(",").map(s => s.trim()).filter(Boolean);

let copySchema = null;
try {
  copySchema = require(path.join(APP, "fp-schema.js"));
} catch (e) {
  console.log("FAIL  packaged fp-schema.js loads  (" + e.message + ")");
  console.log("\nFAIL: the packaged copy cannot even be required");
  process.exit(1);
}

// 1. The failure that produced the white screen.
const missing = imported.filter(n => !(n in copySchema));
ck("packaged fp-schema exports everything main.js imports",
  missing.length === 0, missing.length ? "missing: " + missing.join(", ") : imported.length + " names");

// 2. Key-count drift (the copy was 56 while source was 60).
const srcKeys = Object.keys(schema.FP_KEYS).length;
const copyKeys = Object.keys(copySchema.FP_KEYS || {}).length;
ck("packaged key count matches source", srcKeys === copyKeys,
  "source=" + srcKeys + " copy=" + copyKeys);

// 3. Code files identical by content. profiles.json is deliberately excluded:
//    the packaged copy holds user-created profiles the source does not have.
//
// fp-probe.js is in this list because main.js requires it at module scope. It
// was added to Client/ without being added here, so it was never copied into
// the packaged app - launching electron.exe would have failed on
// "Cannot find module './fp-probe'". A required module is exactly the kind of
// file this check must cover.
const CODE = ["main.js", "fp-schema.js", "fp-probe.js", "tls-probe.js", "layout.js",
  "preload.js",
  "package.json", "renderer/app.js", "renderer/index.html", "renderer/style.css"];
for (const f of CODE) {
  const a = path.join(APP, f);
  const b = path.join(__dirname, f);
  if (!fs.existsSync(a)) { ck("packaged " + f + " exists", false, "missing"); continue; }
  if (!fs.existsSync(b)) { ck("packaged " + f + " exists", false, "source missing"); continue; }
  const same = fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8");
  ck("packaged " + f + " matches source", same, same ? "" : "STALE - rerun the copy step");
}

// 4. No surprises in the packaged directory.
//
// The check above only asks whether each listed file is present and matching;
// it never asked what ELSE is in there. Two stale copies sat in the packaged
// tree unnoticed as a result - test-new-surfaces.js and README.md, both older
// than their source and loaded by nothing. A stale file that nothing loads is
// dead weight; one that differs from its source is worse, because it reads as
// current to anyone looking at the packaged tree.
//
// Files that belong in the packaged copy but are NOT synced from source:
//   profiles.json - user-created profiles. The packaged copy is the DATA
//                   DESTINATION, so it legitimately holds more than the
//                   source and must never be overwritten from it.
const EXPECTED_EXTRA = ["profiles.json"];
try {
  const present = [];
  (function walk(d, p) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, p + e.name + "/");
      else present.push(p + e.name);
    }
  })(APP, "");
  const extra = present.filter((f) => !CODE.includes(f));
  const unexpected = extra.filter((f) => !EXPECTED_EXTRA.includes(f));
  ck("packaged dir holds no unexpected extra files", unexpected.length === 0,
    unexpected.length
      ? unexpected.join(", ") + " - stale or unintended, remove them"
      : "only allowed: " + extra.join(", ") || "none");
} catch (e) {
  ck("packaged dir holds no unexpected extra files", false, e.message);
}

// 5. The packaged profiles must still normalize cleanly under the new schema.
try {
  const pj = JSON.parse(fs.readFileSync(path.join(APP, "profiles.json"), "utf8"));
  let bad = [];
  for (const p of (pj.profiles || [])) {
    if (!p.fingerprint) continue;
    const r = schema.fpNormalizeConfig(p.fingerprint);
    if (Object.keys(r.config).length !== srcKeys || r.unknown.length) {
      bad.push(p.id + "(" + Object.keys(r.config).length + " keys, unknown=" + r.unknown.length + ")");
    }
  }
  ck("packaged profiles normalize cleanly", bad.length === 0, bad.join("; ") || "all OK");
} catch (e) {
  ck("packaged profiles normalize cleanly", false, e.message);
}

console.log("");
console.log(fail === 0
  ? "PASS: " + pass + " checks" + (skip ? ", " + skip + " skipped" : "")
  : "FAIL: " + fail + " of " + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
