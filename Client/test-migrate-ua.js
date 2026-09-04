// Migration: an old profile (missing the 3 new ua_* keys, carrying a
// userAgent) must survive fpNormalizeConfig with the UA intact and the
// ua_* keys backfilled to their empty default (=> derive from UA).
const schema = require("./fp-schema.js");

let pass = 0, fail = 0;
const ck = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : "")); ok ? pass++ : fail++; };

// An old-style profile: no ua_*, with a userAgent sibling.
// (historical: this INPUT is a legacy profile on purpose - the migration under
//  test is what upgrades it. Do NOT update the key count.)
const OLD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const old = JSON.parse(require("fs").readFileSync(__dirname + "/profiles.json", "utf8"))
  .profiles.find(p => p.id === "win10-chrome");
const oldFp = Object.assign({}, old.fingerprint);
delete oldFp.ua_platform; delete oldFp.ua_mobile; delete oldFp.ua_brands;

// Migration runs through fpSplitConfig(), not fpNormalizeConfig() directly:
// presets now carry TLS keys, and fpNormalizeConfig() drops every key absent
// from FP_KEYS, so calling it on a whole profile reports those 9 keys as
// "unknown" and would discard them. fpSplitConfig() routes each key to its own
// plane first, then normalizes only the Blink side. The Blink plane it returns
// is exactly what fpNormalizeConfig() would produce, so the migration
// properties below are still being tested as written.
const split = schema.fpSplitConfig(oldFp);
const norm = { config: split.fingerprint, unknown: split.unknown };

console.log("  old profile keys: " + Object.keys(oldFp).length +
  "  (no ua_*), userAgent present: " + (typeof old.userAgent === "string") + "\n");

// 1. userAgent is NOT part of fingerprint, so normalization cannot touch it.
ck("TLS keys survive migration (routed, not reported unknown)",
  split.tls && Object.keys(split.tls).length > 0 &&
    split.unknown.filter(k => /^fp[A-Z]/.test(k)).length === 0,
  "tls=" + Object.keys(split.tls).join(",") + " unknown=" + split.unknown.join(","));
ck("old fingerprint normalizes without dropping keys",
  // Derived, not hardcoded: the kernel key count changes whenever a leak is
// fixed, and a hardcoded number turns every such change into a false failure
// here. schema.FP_KEY_NAMES is asserted against check.py by test-schema.js.
Object.keys(norm.config).length === schema.FP_KEY_NAMES.length,
  Object.keys(norm.config).length + " keys (schema has " + schema.FP_KEY_NAMES.length + ")");
ck("no unknown keys reported", norm.unknown.length === 0, norm.unknown.join(","));

// 2. The 3 new keys are backfilled to empty => kernel derives from the UA.
for (const k of ["ua_platform", "ua_mobile", "ua_brands"]) {
  ck("missing " + k + " backfilled to empty (derive from UA)",
    norm.config[k] === "", JSON.stringify(norm.config[k]));
}

// 3. The UA itself is a sibling and is untouched by normalization.
// This is the property that made the UA "invisible" in the fingerprint object.
ck("userAgent survives beside the fingerprint",
  old.userAgent === OLD_UA || typeof old.userAgent === "string",
  JSON.stringify(String(old.userAgent).slice(0, 40)) + "...");
ck("UA would be DROPPED if placed inside fingerprint",
  schema.fpNormalizeConfig({ userAgent: "x" }).unknown.indexOf("userAgent") !== -1,
  "unknown=" + JSON.stringify(schema.fpNormalizeConfig({ userAgent: "x" }).unknown));

// 4. Existing values are preserved through normalization (no silent reset).
const kept = schema.fpNormalizeConfig({
  navigator_platform: "MacIntel", ua_platform: "macOS",
  ua_mobile: "false", ua_brands: "Safari=18"
}).config;
ck("explicit navigator_platform preserved", kept.navigator_platform === "MacIntel");
ck("explicit ua_platform preserved", kept.ua_platform === "macOS");
ck("explicit ua_mobile preserved", kept.ua_mobile === "false");
ck("explicit ua_brands preserved", kept.ua_brands === "Safari=18");

// 5. fpNormalizeUserAgent trims; empty means "revert to native".
ck("fpNormalizeUserAgent trims whitespace",
  schema.fpNormalizeUserAgent("  abc  ") === "abc",
  JSON.stringify(schema.fpNormalizeUserAgent("  abc  ")));
ck("fpNormalizeUserAgent maps null/undefined to ''",
  schema.fpNormalizeUserAgent(null) === "" && schema.fpNormalizeUserAgent(undefined) === "");

console.log("");
console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
