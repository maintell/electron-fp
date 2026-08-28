#!/usr/bin/env node
// Verify generateRandomProfile() emits a coherent, schema-valid config.
"use strict";
const schema = require("./fp-schema.js");
const fs = require("fs");

// Extract generateRandomProfile from main.js without booting Electron.
const src = fs.readFileSync("./main.js", "utf8");
const start = src.indexOf("function generateRandomProfile()");
const end = src.indexOf("// --- App Lifecycle ---");
const fnSrc = src.slice(start, end);
const mod = new Function("fpDefaultConfig", "FP_KEY_NAMES", fnSrc + "; return generateRandomProfile;")(
  schema.fpDefaultConfig, schema.FP_KEY_NAMES
);

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log("PASS  " + n + (d ? ": " + d : "")); pass++; } else { console.log("FAIL  " + n + (d ? ": " + d : "")); fail++; } };

const N = 300;
const bad = [];
let gpuMismatch = 0, geoMismatch = 0, touchMismatch = 0, strengthBad = 0, levelBad = 0;
const seenGroups = new Set();

for (let i = 0; i < N; i++) {
  const prof = mod();
  const fp = prof.fingerprint;

  // every key present, none unknown
  for (const k of schema.FP_KEY_NAMES) if (!(k in fp)) bad.push(k + " missing");
  const unknown = Object.keys(fp).filter(k => !schema.FP_KEY_NAMES.includes(k));
  if (unknown.length) bad.push("unknown: " + unknown);

  // cross-API consistency (C17): WebGL vendor must equal WebGPU vendor
  if (fp.webgl_vendor !== fp.webgpu_vendor) gpuMismatch++;

  // geo must match the configured timezone city
  const city = { "America/New_York": "40.7128", "America/Chicago": "41.8781", "America/Los_Angeles": "34.0522",
    "Europe/London": "51.5074", "Europe/Berlin": "52.5200", "Europe/Paris": "48.8566", "Asia/Tokyo": "35.6762",
    "Asia/Shanghai": "31.2304", "Asia/Kolkata": "19.0760" }[fp.tz_id];
  if (fp.geo_latitude && city && fp.geo_latitude !== city) geoMismatch++;

  // mobile => touch points > 0, desktop => 0
  const mobile = fp.screen_width < 500;
  if (mobile && fp.max_touch_points === 0) touchMismatch++;
  if (!mobile && fp.max_touch_points > 0) touchMismatch++;

  // audio strength must parse as a float in [0,1]
  if (fp.audio_data_strength) {
    const v = parseFloat(fp.audio_data_strength);
    if (!(v >= 0 && v <= 1)) strengthBad++;
  }
  // battery level in [0,1]
  if (fp.battery_level) {
    const v = parseFloat(fp.battery_level);
    if (!(v >= 0 && v <= 1)) levelBad++;
  }

  schema.fpCoverage(fp).forEach(c => { if (c.active) seenGroups.add(c.id); });
}

check("schema-complete over " + N + " profiles", bad.length === 0, bad.slice(0, 3).join("; "));
check("webgl/webgpu vendor consistent", gpuMismatch === 0, gpuMismatch + " mismatches");
check("geo matches timezone", geoMismatch === 0, geoMismatch + " mismatches");
check("touch points match form factor", touchMismatch === 0, touchMismatch + " mismatches");
check("audio_data_strength in [0,1]", strengthBad === 0, strengthBad + " bad");
check("battery_level in [0,1]", levelBad === 0, levelBad + " bad");
check("randomizer exercises most groups", seenGroups.size >= 12, seenGroups.size + "/14 groups populated");

const sample = mod();
console.log("\nsample: " + sample.name);
console.log("  active keys: " + schema.FP_KEY_NAMES.filter(k => schema.fpIsActive(k, sample.fingerprint[k])).length + "/56");
console.log("  gpu: " + sample.fingerprint.webgl_vendor + " | " + sample.fingerprint.webgl_renderer);
console.log("  tz:  " + sample.fingerprint.tz_id + " @ " + sample.fingerprint.geo_latitude + "," + sample.fingerprint.geo_longitude);

console.log("");
console.log(fail === 0 ? "PASS: randomizer emits coherent 56-key configs" : "FAIL: " + fail);
process.exit(fail === 0 ? 0 : 1);
