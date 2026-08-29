#!/usr/bin/env node
// Verify generateRandomProfile() emits a coherent, schema-valid config.
"use strict";
const schema = require("./fp-schema.js");
const fs = require("fs");
const path = require("path");

// Resolve main.js against THIS file, not the process CWD. require() is already
// script-relative, but readFileSync() is CWD-relative, so running this from
// anywhere but Client/ would silently read the wrong main.js (or throw ENOENT)
// and the checks below would validate a file that is not the real one.
const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const start = src.indexOf("function generateRandomProfile()");
const end = src.indexOf("// --- App Lifecycle ---");
const fnSrc = src.slice(start, end);

// The generator is extracted as source text, so ONLY the names passed below are
// in scope inside it. Anything generateRandomProfile() references from the
// module scope must be injected here or it throws ReferenceError at call time
// (which is exactly what happened when the randomizer gained a UA: the test
// silently produced zero checks instead of failing loudly).
const mod = new Function(
  "fpDefaultConfig", "FP_KEY_NAMES", "fpRandomUserAgent", "fpPlatformForUserAgent",
  fnSrc + "; return generateRandomProfile;"
)(schema.fpDefaultConfig, schema.FP_KEY_NAMES, schema.fpRandomUserAgent,
  schema.fpPlatformForUserAgent);

// Guard against the silent-zero-checks failure above: a ReferenceError thrown
// here would otherwise abort before any check ran, and a run with 0 checks must
// never be reported as green.
if (typeof mod !== "function") {
  console.log("FAIL  could not extract generateRandomProfile from main.js");
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log("PASS  " + n + (d ? ": " + d : "")); pass++; } else { console.log("FAIL  " + n + (d ? ": " + d : "")); fail++; } };

// The feature names this adapter can actually expose, and its real limits.
// Both were captured from a live adapter; the generator must never invent a
// name or exceed a ceiling, and must never drop below the spec default.
const WEBGPU_FEATURE_NAMES = [
  "bgra8unorm-storage", "clip-distances", "core-features-and-limits",
  "depth-clip-control", "depth32float-stencil8", "dual-source-blending",
  "float32-blendable", "float32-filterable", "indirect-first-instance",
  "primitive-index", "rg11b10ufloat-renderable", "shader-f16",
  "texture-component-swizzle", "texture-compression-bc",
  "texture-compression-bc-sliced-3d", "texture-formats-tier1",
  "texture-formats-tier2", "timestamp-query"
];
const NATIVE_LIMITS = {
  maxTextureDimension1D: 16384, maxTextureDimension2D: 16384,
  maxTextureDimension3D: 2048, maxTextureArrayLayers: 2048,
  maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000, maxDynamicUniformBuffersPerPipelineLayout: 10,
  maxDynamicStorageBuffersPerPipelineLayout: 8,
  maxSampledTexturesPerShaderStage: 48, maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 16, maxStorageTexturesPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 12, maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 2147483644,
  minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8, maxBufferSize: 2147483648, maxVertexAttributes: 30,
  maxVertexBufferArrayStride: 2048, maxInterStageShaderVariables: 28,
  maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 128,
  maxComputeWorkgroupStorageSize: 32768, maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupSizeX: 1024, maxComputeWorkgroupSizeY: 1024,
  maxComputeWorkgroupSizeZ: 64, maxComputeWorkgroupsPerDimension: 65535,
  maxImmediateSize: 64
};
// WebGPU spec minimums: a page requesting nothing still receives these, so a
// limit below them breaks device creation just as surely as exceeding native.
const SPEC_DEFAULT = {
  maxTextureDimension1D: 8192, maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048, maxTextureArrayLayers: 256,
  maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000, maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12, maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8, maxBufferSize: 268435456, maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048, maxInterStageShaderVariables: 16,
  maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64, maxComputeWorkgroupsPerDimension: 65535,
  maxImmediateSize: 0
};

const N = 300;
const bad = [];
let gpuMismatch = 0, geoMismatch = 0, touchMismatch = 0, strengthBad = 0, levelBad = 0;
let featUnknown = 0, featDup = 0, featNoCore = 0, featSizeBad = 0;
let limQuoted = 0, limParse = 0, limOver = 0, limUnder = 0;
let ipBad = 0, ipInconsistent = 0, fontWhitelistSet = 0, fontCountBad = 0;
let platformMismatch = 0, platformUnset = 0;
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

  // ---- guards for the keys that were previously left empty ----
  // These are cheap static invariants; the kernel round-trip is covered by
  // test-webgpu.js, which actually instantiates an adapter.

  // webgpu_features is REPLACE: an invented name is dropped by the kernel,
  // so a name outside the real enum would shrink the set unpredictably.
  if (fp.webgpu_features) {
    const feats = fp.webgpu_features.split(",").filter(Boolean);
    if (new Set(feats).size !== feats.length) featDup++;
    for (const f of feats) if (WEBGPU_FEATURE_NAMES.indexOf(f) === -1) featUnknown++;
    if (feats.indexOf("core-features-and-limits") === -1) featNoCore++;
    if (feats.length < 9 || feats.length > 16) featSizeBad++;
  }

  // webgpu_limits is MERGE and is bounded on BOTH sides:
  //   > native  => Dawn rejects device creation, WebGPU breaks entirely
  //   < spec default => a page asking for the defaults gets rejected too
  // Quoted keys are fatal: FpConfigString() reads the value as a JSON string
  // and stops at the first closing quote, so {"k":1} is truncated to "{" and
  // EVERY limit is silently dropped. This exact bug shipped once already.
  const lm = fp.webgpu_limits && fp.webgpu_limits.match(/^\{(.*)\}$/);
  if (lm) {
    if (/"/.test(fp.webgpu_limits)) limQuoted++;
    if (!lm[1]) { limParse++; }
    else {
      for (const pair of lm[1].split(",")) {
        const c = pair.indexOf(":");
        if (c === -1) { limParse++; continue; }
        const key = pair.slice(0, c).trim();
        const val = parseInt(pair.slice(c + 1), 10);
        if (!(key in NATIVE_LIMITS) || !isFinite(val)) { limParse++; continue; }
        if (val > NATIVE_LIMITS[key]) limOver++;
        if (SPEC_DEFAULT[key] !== undefined && val < SPEC_DEFAULT[key]) limUnder++;
      }
    }
  } else if (fp.webgpu_limits !== "") {
    limParse++;
  }

  // webrtc_ip must be a real 4-octet address, and must not contradict the
  // network class: a datacentre-style IP claiming 3g (or a carrier IP with a
  // 300 Mbps downlink) is exactly the mismatch these profiles exist to avoid.
  if (fp.webrtc_ip) {
    const p = fp.webrtc_ip.split(".");
    const oct = p.map(Number);
    if (p.length !== 4 || oct.some(n => !(n >= 0 && n <= 255))) ipBad++;
    else {
      if (oct[3] === 0 || oct[3] === 1 || oct[3] === 255) ipBad++;
      const mobile = /^(100\.|10\.)/.test(fp.webrtc_ip);
      const rtt = +fp.net_rtt_ms, down = +fp.net_downlink_mbps;
      if (mobile && (rtt < 40 || down >= 50)) ipInconsistent++;
      if (!mobile && (rtt > 60 || down < 5)) ipInconsistent++;
    }
  }

  // fonts: 1..3 names. The kernel gives whitelist precedence, so setting both
  // would silently nullify the blocklist - whitelist must stay empty.
  if (fp.fonts_whitelist !== "") fontWhitelistSet++;
  const fonts = fp.fonts_blocklist ? fp.fonts_blocklist.split(",").filter(Boolean) : [];
  if (fonts.length < 1 || fonts.length > 3) fontCountBad++;
  for (const f of fonts) if (!f.trim()) fontCountBad++;

  // UA and navigator.platform are separate surfaces with nothing enforcing
  // agreement. A Mac UA paired with the host's real "Win32" is precisely the
  // contradiction navigator_platform exists to remove, so the pair must agree.
  // Checked against the UA that was actually chosen, not a fixed expectation.
  const wantPlatform = schema.fpPlatformForUserAgent(prof.userAgent);
  if (fp.navigator_platform !== wantPlatform) platformMismatch++;
  if (wantPlatform === "") platformUnset++;
}

check("schema-complete over " + N + " profiles", bad.length === 0, bad.slice(0, 3).join("; "));
check("webgpu_features: real names only", featUnknown === 0, featUnknown + " unknown");
check("webgpu_features: no duplicates", featDup === 0, featDup + " profiles with dupes");
check("webgpu_features: includes core-features-and-limits", featNoCore === 0, featNoCore + " missing");
check("webgpu_features: size 9..16", featSizeBad === 0, featSizeBad + " out of range");
check("webgpu_limits: no quoted keys (FpConfigString truncates)", limQuoted === 0, limQuoted + " quoted");
check("webgpu_limits: parses", limParse === 0, limParse + " unparseable");
check("webgpu_limits: never exceeds native (Dawn-safe)", limOver === 0, limOver + " over");
check("webgpu_limits: never below spec default", limUnder === 0, limUnder + " under");
check("webrtc_ip: valid non-reserved IPv4", ipBad === 0, ipBad + " bad");
check("webrtc_ip: consistent with net class", ipInconsistent === 0, ipInconsistent + " inconsistent");
check("fonts: whitelist stays empty (would nullify blocklist)", fontWhitelistSet === 0, fontWhitelistSet + " set");
check("fonts_blocklist: 1..3 non-empty names", fontCountBad === 0, fontCountBad + " bad");
check("webgl/webgpu vendor consistent", gpuMismatch === 0, gpuMismatch + " mismatches");
check("geo matches timezone", geoMismatch === 0, geoMismatch + " mismatches");
check("touch points match form factor", touchMismatch === 0, touchMismatch + " mismatches");
check("audio_data_strength in [0,1]", strengthBad === 0, strengthBad + " bad");
check("battery_level in [0,1]", levelBad === 0, levelBad + " bad");
check("navigator_platform agrees with the UA", platformMismatch === 0, platformMismatch + " mismatches");
check("navigator_platform always set (never Win32 under a Mac UA)", platformUnset === 0, platformUnset + " unset");
check("randomizer exercises most groups", seenGroups.size >= 12,
  seenGroups.size + "/" + schema.FP_GROUP_IDS.length + " groups populated");

const sample = mod();
console.log("\nsample: " + sample.name);
console.log("  active keys: " + schema.FP_KEY_NAMES.filter(k => schema.fpIsActive(k, sample.fingerprint[k])).length + "/" + schema.FP_KEY_NAMES.length);
console.log("  ua: " + String(sample.userAgent).slice(0, 70));
console.log("  platform: " + sample.fingerprint.navigator_platform);
console.log("  gpu: " + sample.fingerprint.webgl_vendor + " | " + sample.fingerprint.webgl_renderer);
console.log("  tz:  " + sample.fingerprint.tz_id + " @ " + sample.fingerprint.geo_latitude + "," + sample.fingerprint.geo_longitude);

console.log("");
console.log(fail === 0 ? "PASS: randomizer emits coherent " + schema.FP_KEY_NAMES.length + "-key configs"
                       : "FAIL: " + fail);
process.exit(fail === 0 ? 0 : 1);
