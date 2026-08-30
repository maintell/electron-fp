#!/usr/bin/env node
// Verify the client fingerprint schema matches the KERNEL patch exactly (60 keys)
// and that functional grouping is complete (every key in exactly one group).
"use strict";

const fs = require("fs");
const path = require("path");
const schema = require("./fp-schema.js");

const PATCH = "F:/code/src/electron/fingerprint/patches/fp-fingerprint.patch";
const CHECK_PY = "F:/code/src/electron/fingerprint/scripts/check.py";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log("PASS  " + name + (detail ? ": " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? ": " + detail : "")); fail++; }
};

// 1) kernel authoritative key list, scraped from check.py EXPECTED_KEYS
let kernel = [];
try {
  const py = fs.readFileSync(CHECK_PY, "utf8");
  const m = py.match(/EXPECTED_KEYS = \[([\s\S]*?)\n\]/);
  kernel = [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map(x => x[1]);
} catch (e) {
  console.log("WARN  could not parse check.py: " + e.message);
}

// 2) every key must literally appear in the patch (kernel implements it)
let patch = "";
try { patch = fs.readFileSync(PATCH, "utf8"); } catch { /* may be absent */ }

console.log("kernel keys (check.py) = " + kernel.length);
console.log("client schema keys     = " + schema.FP_KEY_NAMES.length);
console.log("");

check("schema key count matches kernel", kernel.length > 0 && schema.FP_KEY_NAMES.length === kernel.length,
  schema.FP_KEY_NAMES.length + " vs " + kernel.length);

const missing = kernel.filter(k => !schema.FP_KEY_NAMES.includes(k));
check("no kernel key missing from client", missing.length === 0, missing.join(", "));

const extra = schema.FP_KEY_NAMES.filter(k => !kernel.includes(k));
check("no client key unknown to kernel", extra.length === 0, extra.join(", "));

if (patch) {
  const notImpl = kernel.filter(k => !patch.includes(k));
  check("every key implemented in patch", notImpl.length === 0, notImpl.join(", "));
}

// 3) grouping completeness
const grouped = schema.FP_GROUP_IDS.flatMap(g => schema.fpKeysInGroup(g));
check("every key belongs to some group", grouped.length === schema.FP_KEY_NAMES.length,
  grouped.length + "/" + schema.FP_KEY_NAMES.length);

const seen = new Set();
let dup = [];
for (const g of schema.FP_GROUP_IDS) {
  for (const k of schema.fpKeysInGroup(g)) {
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
}
check("no key in two groups", dup.length === 0, dup.join(", "));
check("groups non-empty", schema.FP_GROUP_IDS.every(g => schema.fpKeysInGroup(g).length > 0));

// 4) default config covers everything and is fully disabled
const def = schema.fpDefaultConfig();
check("default config has all keys", Object.keys(def).length === schema.FP_KEY_NAMES.length);
check("default config all inactive", schema.FP_KEY_NAMES.every(k => !schema.fpIsActive(k, def[k])));

// 5) normalize: fills, drops unknown, keeps known
const norm = schema.fpNormalizeConfig({ hardware_concurrency: 8, bogus_key: 1 });
check("normalize fills all keys", Object.keys(norm.config).length === schema.FP_KEY_NAMES.length);
check("normalize keeps known value", norm.config.hardware_concurrency === 8);
check("normalize drops unknown", norm.unknown.includes("bogus_key") && !("bogus_key" in norm.config));

// 6) coverage report
const cov = schema.fpCoverage({ screen_width: 1920, screen_height: 1080, tz_id: "Asia/Tokyo" });
check("coverage counts active", cov.reduce((a, c) => a + c.active, 0) === 3,
  JSON.stringify(cov.filter(c => c.active).map(c => c.id + ":" + c.active)));
check("coverage totals == 60", cov.reduce((a, c) => a + c.total, 0) === schema.FP_KEY_NAMES.length);

console.log("");
console.log("groups (" + schema.FP_GROUP_IDS.length + "):");
for (const g of schema.FP_GROUPS) {
  console.log("  " + g.id.padEnd(9) + String(schema.fpKeysInGroup(g.id).length).padStart(3) + "  " + g.desc);
}

console.log("");
console.log(fail === 0 ? "PASS: schema " + schema.FP_KEY_NAMES.length + " keys / " + schema.FP_GROUP_IDS.length + " groups, exact kernel match"
                       : "FAIL: " + fail + " check(s) failed");
process.exit(fail === 0 ? 0 : 1);
