// ============================================================================
// fp-schema.js - Single source of truth for fingerprint config keys.
//
// Every key here MUST exist in the kernel patch:
//   F:\code\src\electron\fingerprint\patches\fp-fingerprint.patch
// (look for FpConfigString / FpConfigInt / FpConfigInt64 call sites).
// There are now 63. Trust check.py's EXPECTED_KEYS as the authoritative
// count; this file is asserted equal to it by test-schema.js.
//
// History of the count, because it has been wrong twice and both mistakes
// cost real time:
//   56 - an early grep for FpConfig* call sites. Four webgl_* keys are
//        written inside ternary expressions split across lines
//          pname == 0x9245 ? "webgl_vendor" : "webgl_renderer"
//        so a line-oriented grep missed them.
//   60 - the correct count for a long while (paren-balanced parse, matches
//        check.py).
//   63 - three surfaces that an external audit against browserleaks.com and
//        creepjs found still leaking the host even with every other key set:
//        navigator.vendor, navigator.language/languages, and
//        window.devicePixelRatio. Each disagreed with the spoofed UA, which
//        is exactly the kind of contradiction detection sites flag.
//
// Value encoding rules (from the kernel parser - these are NOT negotiable):
//   * "int"    -> JSON number, parsed with atoi; must be > 0 to take effect
//   * "int64"  -> JSON number, parsed with strtoll; must be > 0 (seeds)
//   * "str"    -> JSON string; EMPTY STRING / "0" = disabled (native passthrough)
//   * "bool"   -> JSON string "true"/"false" (kernel compares to "true"/"1")
//   * "csv"    -> comma-separated string, e.g. "vp09,av01"
//   * "dims"   -> "min,max" float pair (ALIASED_*_RANGE)
//   * "sp"     -> "rangeMin,rangeMax,precision" (shader precision highp)
//   * "json"   -> JSON-encoded object: webgpu_features (REPLACE set),
//                 webgpu_limits (MERGE map)
//
// Defaults are deliberately DISABLED ("" or 0): a generated profile must never
// claim a fingerprint surface it cannot back. An unbacked lie is worse than no
// spoof at all, because inconsistent surfaces are themselves a detection signal
// (constraint C17 - cross-API consistency).
// ============================================================================
"use strict";

// Bump whenever the key set or an encoding below changes.
const FP_SCHEMA_VERSION = 2;

/**
 * Canonical key table. `kind` documents the wire encoding; `def` is the
 * default used by the randomizer and by profile normalization.
 */
const FP_KEYS = {
  // --- Hardware ---
  hardware_concurrency:  { group: "hardware", kind: "int",   def: 0 },
  device_memory:         { group: "hardware", kind: "int",   def: 0 },
  max_touch_points:      { group: "hardware", kind: "int",   def: 0 },

  // --- Screen ---
  screen_width:          { group: "screen", kind: "int", def: 0 },
  screen_height:         { group: "screen", kind: "int", def: 0 },
  screen_avail_width:    { group: "screen", kind: "int", def: 0 },
  screen_avail_height:   { group: "screen", kind: "int", def: 0 },
  screen_color_depth:    { group: "screen", kind: "int", def: 0 },

  // --- Audio ---
  audio_sample_rate:        { group: "audio", kind: "int",   def: 0 },
  audio_max_channels:       { group: "audio", kind: "int",   def: 0 },
  audio_output_latency_ms:  { group: "audio", kind: "int",   def: 0 },   // ms -> seconds (/1000)
  audio_data_seed:          { group: "audio", kind: "int64", def: 0 },   // > 0 enables
  audio_data_strength:      { group: "audio", kind: "str",   def: "" },  // float, kernel default 0.0005

  // --- WebGL ---
  webgl_max_texture_size:          { group: "webgl", kind: "int",  def: 0 },
  webgl_max_renderbuffer_size:     { group: "webgl", kind: "int",  def: 0 },
  webgl_max_viewport_dims:         { group: "webgl", kind: "int",  def: 0 }, // returned as [v, v]
  webgl_aliased_point_size_range:  { group: "webgl", kind: "dims", def: "" },
  webgl_aliased_line_width_range:  { group: "webgl", kind: "dims", def: "" },
  webgl_vendor:                    { group: "webgl", kind: "str",  def: "" },
  webgl_renderer:                  { group: "webgl", kind: "str",  def: "" },
  webgl_extensions:                { group: "webgl", kind: "csv",  def: "" }, // APPEND to native list
  webgl_shader_precision_highp:    { group: "webgl", kind: "sp",   def: "" },

  // --- WebGPU (keep webgpu_vendor consistent with webgl_vendor: C17) ---
  webgpu_vendor:        { group: "webgpu", kind: "str",  def: "" },
  webgpu_architecture:  { group: "webgpu", kind: "str",  def: "" },
  webgpu_device:        { group: "webgpu", kind: "str",  def: "" },
  webgpu_description:   { group: "webgpu", kind: "str",  def: "" },
  webgpu_features:      { group: "webgpu", kind: "json", def: "" }, // REPLACE feature set
  webgpu_limits:        { group: "webgpu", kind: "json", def: "" }, // MERGE limits map

  // --- Geolocation ---
  geo_latitude:  { group: "geo", kind: "str", def: "" }, // atof
  geo_longitude: { group: "geo", kind: "str", def: "" },
  geo_accuracy:  { group: "geo", kind: "str", def: "" },

  // --- Speech ---
  speech_voices_count: { group: "speech", kind: "int", def: 0 },  // truncates voice list
  speech_voices_lang:  { group: "speech", kind: "str", def: "" }, // e.g. "en-US"

  // --- Media devices ---
  media_devices_audio_input:  { group: "media", kind: "int", def: 0 },
  media_devices_video_input:  { group: "media", kind: "int", def: 0 },
  media_devices_audio_output: { group: "media", kind: "int", def: 0 },
  media_codecs_denylist:      { group: "media", kind: "csv", def: "" }, // e.g. "vp09,av01"

  // --- Canvas / text / rects ---
  canvas_noise_seed:     { group: "canvas", kind: "int",   def: 0 },
  canvas_noise_strength: { group: "canvas", kind: "int",   def: 0 },
  measure_text_seed:     { group: "canvas", kind: "int64", def: 0 },
  client_rects_seed:     { group: "canvas", kind: "int",   def: 0 },

  // --- Locale / time / privacy ---
  tz_id:                { group: "env", kind: "str", def: "" },
  prefers_color_scheme: { group: "env", kind: "str", def: "" }, // "light" | "dark"
  do_not_track:         { group: "env", kind: "str", def: "" }, // "1" | "0"

  // --- Network ---
  net_effective_type: { group: "network", kind: "str", def: "" }, // "3g" | "4g"
  net_rtt_ms:         { group: "network", kind: "int", def: 0 },
  net_downlink_mbps:  { group: "network", kind: "str", def: "" },
  webrtc_ip:          { group: "network", kind: "str", def: "" }, // overrides candidate IP

  // --- Permissions / storage / perf ---
  permissions_status:    { group: "storage", kind: "str", def: "" }, // granted | prompt | denied
  storage_usage_bytes:   { group: "storage", kind: "int", def: 0 },
  storage_quota_bytes:   { group: "storage", kind: "int", def: 0 },
  perf_now_precision_ms: { group: "storage", kind: "int", def: 0 },  // > 0 quantizes timestamps

  // --- Fonts ---
  fonts_blocklist: { group: "fonts", kind: "csv", def: "" },
  fonts_whitelist: { group: "fonts", kind: "csv", def: "" },

  // --- Battery ---
  battery_charging: { group: "battery", kind: "bool", def: "" }, // "true" | "false"
  battery_level:    { group: "battery", kind: "str",  def: "" }, // "0.0" - "1.0"

  // --- Navigator identity ---
  // navigator.platform. It is NOT affected by Electron's
  // session.setUserAgent(): overriding the UA leaves platform at "Win32",
  // which contradicts the UA and is itself a detection signal. This kernel key
  // is the only way to cover it. Should stay consistent with any UA override:
  // a Mac UA wants "MacIntel", Android wants "Linux armv8l".
  navigator_platform: { group: "navigator", kind: "str", def: "" },

  // --- Sec-CH-UA client hints -------------------------------------------------
  // navigator.userAgentData and the Sec-CH-UA* request headers are a SECOND,
  // independent identity surface. Measured: overriding the UA leaves these
  // reporting the real brand ("Chromium";v="154") and platform ("Windows"), so a
  // Mac UA ships alongside Windows hints - a glaring contradiction that the UA
  // override alone does not remove.
  //
  // Sec-CH-UA (brand list) is the loudest of the three: it is what actually
  // announces the browser family, and leaving it at Chromium/brand defeats the
  // point of spoofing the UA at all.
  //
  // Empty = inherit. When ua_platform/ua_mobile are empty and ua_brands is
  // empty, the kernel derives all three FROM the UA string, so a Mac UA
  // automatically reports platform "macOS" and Safari-ish brands. Set them
  // explicitly only to override that derivation.
  ua_brands: {
    group: "navigator", kind: "str", def: "",
    // The old hint showed the WIRE form ('"Brand";v="99"'), which cannot work:
    // FpConfigString truncates at the first quote, so a quoted brand list
    // arrives at FpParseBrands as '\\' and produces a single garbage brand
    // (measured). Only the quote-free config form survives. The parser handles
    // both, but the config never reaches it intact - so document what works.
    hint: 'Brand list WITHOUT quotes, e.g. Not A(Brand=99, Chromium=120. Quotes are truncated by the kernel. Empty = derive from UA.'
  },
  ua_platform: {
    group: "navigator", kind: "str", def: "",
    hint: 'Sec-CH-UA-Platform value, e.g. macOS / Windows / Linux / Android. Empty = derive from UA.'
  },
    ua_mobile: {
      group: "navigator", kind: "str", def: "",
      // Literal "true" only. The kernel does `mobile = (cfg_mobile == "true")`,
      // so "1" and 0 are silently false - measured. Say so, or a user sets 1,
      // sees mobile=false, and concludes the key is broken.
      hint: 'Sec-CH-UA-Mobile. Only the literal "true" turns it on - "1" and 0 are silently false. Empty = derive from UA.'
    },

    // --- Keys 61-63: surfaces that leaked the host in an external audit ---
    // Found by diffing browserleaks.com / creepjs output between a baseline
    // (no config) run and a spoofed run. Every one of these kept reporting the
    // host's real value while the UA said otherwise - the exact contradiction
    // detection sites flag first.

    // navigator.vendor. Lives on Navigator (NOT NavigatorID/NavigatorBase),
    // and is a plain non-virtual member, so it can only be hooked in
    // Navigator::vendor(). Without this an iPhone profile reports
    // "Google Inc." - and worse, disagrees with webgl_vendor.
    navigator_vendor: {
      group: "navigator", kind: "str", def: "",
      label: "navigator.vendor",
      hint: 'e.g. "Google Inc." / "Apple Computer, Inc." / "". Empty = real vendor.'
    },

    // navigator.language AND navigator.languages: language() is just
    // languages().front(), so one comma-separated value drives both.
    navigator_languages: {
      group: "navigator", kind: "str", def: "",
      label: "navigator.languages",
      hint: 'Comma-separated, e.g. "en-US,en". Sets both .language and .languages. Empty = real locale.'
    },

    // window.devicePixelRatio. Overrides the JS-visible value only; the
    // compositor keeps the true device scale so rendering is not rescaled.
    device_pixel_ratio: {
      group: "screen", kind: "str", def: "",
      label: "devicePixelRatio",
      hint: 'e.g. "1" / "2" / "3". Must be > 0. Empty = real ratio (JS value only - rendering is unaffected).'
    },
  };
// --- Functional groups -------------------------------------------------------
// Each of the 63 kernel keys belongs to exactly ONE group. Groups drive the
// client UI (collapsible sections), the randomizer (coherent per-group fills)
// and the coverage report.
const FP_GROUPS = [
  { id: "hardware", label: "Hardware",         desc: "CPU cores, memory, touch points" },
  { id: "screen",   label: "Screen",           desc: "Resolution, avail area, color depth" },
  { id: "audio",    label: "Audio",            desc: "Sample rate, channels, latency, noise seed" },
  { id: "webgl",    label: "WebGL",            desc: "Vendor/renderer, limits, extensions, precision" },
  { id: "webgpu",   label: "WebGPU",           desc: "Adapter metadata, features and limits" },
  { id: "geo",      label: "Geolocation",      desc: "Latitude, longitude, accuracy" },
  { id: "speech",   label: "Speech",           desc: "Voice count and language" },
  { id: "media",    label: "Media Devices",    desc: "Audio/video device counts, codec denylist" },
  { id: "canvas",   label: "Canvas & Text",    desc: "Canvas noise, text metrics, element rects" },
  { id: "env",      label: "Locale & Privacy", desc: "Timezone, color scheme, Do Not Track" },
  { id: "network",  label: "Network",          desc: "Connection type, RTT, downlink, WebRTC IP" },
  { id: "storage",  label: "Storage & Perf",   desc: "Quota, usage, timestamp precision" },
  { id: "fonts",    label: "Fonts",            desc: "Font family blocklist / whitelist" },
  { id: "battery",  label: "Battery",          desc: "Charging state and level" },
  { id: "navigator", label: "Navigator ID",    desc: "navigator.platform (not covered by UA override)" },
];

const FP_GROUP_IDS = FP_GROUPS.map(function (g) { return g.id; });

/** All keys belonging to a group, in declaration order. */
function fpKeysInGroup(groupId) {
  return FP_KEY_NAMES.filter(function (k) { return FP_KEYS[k].group === groupId; });
}

/** Coverage report: how many keys of each group are actively set in `cfg`. */
function fpCoverage(cfg) {
  return FP_GROUPS.map(function (g) {
    const keys = fpKeysInGroup(g.id);
    const active = keys.filter(function (k) { return fpIsActive(k, cfg ? cfg[k] : undefined); });
    return { id: g.id, label: g.label, total: keys.length, active: active.length, keys: keys };
  });
}

/** A key is "active" when its value differs from the disabled default. */
function fpIsActive(key, value) {
  const def = FP_KEYS[key] ? FP_KEYS[key].def : undefined;
  if (value === undefined || value === null || value === "") return false;
  if (typeof def === "number") return Number(value) !== 0;
  return String(value) !== String(def);
}
const FP_KEY_NAMES = Object.keys(FP_KEYS);

/** Build a fully-populated config using each key's documented default. */
function fpDefaultConfig() {
  const out = {};
  for (const k of FP_KEY_NAMES) out[k] = FP_KEYS[k].def;
  return out;
}

/**
 * Fill missing keys with defaults and drop unknown keys, so a config written by
 * an older/newer client can never ship a key the kernel does not implement.
 * Unknown keys are DROPPED rather than passed through: the kernel ignores them
 * anyway, and a silently-ignored field is a footgun in the JSON editor.
 */
function fpNormalizeConfig(input) {
  const out = fpDefaultConfig();
  const unknown = [];
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      if (Object.prototype.hasOwnProperty.call(FP_KEYS, k)) out[k] = fpCoerce(k, v);
      else unknown.push(k);
    }
  }
  return { config: out, unknown };
}

/**
 * Coerce a value into the wire encoding the kernel's parser expects.
 *
 * kind:"str" MUST be a JSON string. FpConfigString() looks for the opening
 * quote and returns "" if the next non-space char is not one, so a NUMBER
 * silently disables the key - no error, no log, the override just does not
 * happen. Measured: {net_downlink_mbps: 77} was ignored while
 * {net_downlink_mbps: "77"} worked.
 *
 * This bites hardest on the keys that are NATURALLY numeric
 * (net_downlink_mbps, geo_latitude/longitude/accuracy, battery_level,
 * audio_data_strength): a JSON editor or a computed value produces a number
 * and the setting quietly does nothing.
 *
 * Coercing here rather than at each call site because fpNormalizeConfig() is
 * the single funnel every config passes through before reaching the kernel.
 */
function fpCoerce(key, value) {
  const spec = FP_KEYS[key];
  if (!spec || value === undefined || value === null) return value;
  if (spec.kind === "str") return String(value);
  if (spec.kind === "bool") {
    // Kernel compares to "true"/"1". Accept real booleans too.
    if (value === true) return "true";
    if (value === false) return "false";
    return String(value);
  }
  // csv / json / sp are ALSO read with FpConfigString, so a number is silently
  // inert for them exactly as it is for kind="str" - FpConfigString returns ""
  // for a JSON number and the key quietly does nothing.
  //
  // These kinds describe the STRING's internal shape (comma-separated list,
  // JSON object, "rangeMin,rangeMax,precision"), not a different wire type.
  // Coercing every string-read kind closes the trap uniformly instead of per
  // kind. A number is never meaningful content for any of them.
  if (spec.kind === "csv" || spec.kind === "json" || spec.kind === "sp") {
    return String(value);
  }
  return value;
}

// ============================================================================
// User-Agent: a CLIENT-level (Electron) surface, deliberately NOT a kernel key.
//
// The kernel's 63 keys are read by Blink via --fingerprint-config. The UA is
// applied by Electron's session.setUserAgent(), which is a different layer
// entirely. Keeping it out of FP_KEYS is not cosmetic:
//
//   * fpNormalizeConfig() drops every key the kernel does not know, so a UA
//     placed inside `fingerprint` would be silently discarded on apply.
//   * test-schema.js asserts the client key set equals the kernel key set
//     exactly, so adding a 64th key here would break that assertion.
//
// Measured behaviour this model relies on (2026-08-29, verified on Electron):
//   * setUserAgent() covers BOTH navigator.userAgent and the HTTP UA header.
//   * It is per-partition, so per-tab UA isolation is free (tabs already own
//     a unique partition).
//   * It MUST be called before the BrowserView is created: setting it on an
//     already-open session does not reach existing views even after reload,
//     but a NEW view on the same partition does pick it up.
//   * setUserAgent("") reverts to the native UA.
// ============================================================================

/** Platform-appropriate UA presets used by the randomizer and the panel. */
const FP_UA_PRESETS = [
  {
    id: "win-chrome",
    label: "Windows / Chrome",
    platform: "win",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  },
  {
    id: "mac-chrome",
    label: "macOS / Chrome",
    platform: "mac",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  },
  {
    id: "mac-safari",
    label: "macOS / Safari",
    platform: "mac",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"
  },
  {
    id: "linux-chrome",
    label: "Linux / Chrome",
    platform: "linux",
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  },
  {
    id: "linux-firefox",
    label: "Linux / Firefox",
    platform: "linux",
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"
  },
  {
    id: "win-firefox",
    label: "Windows / Firefox",
    platform: "win",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"
  },
  {
    id: "android-chrome",
    label: "Android / Chrome",
    platform: "android",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    id: "iphone-safari",
    label: "iPhone / Safari",
    platform: "ios",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
  },
  {
    id: "ipad-safari",
    label: "iPad / Safari",
    platform: "ios",
    ua: "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
  }
];

/** Pick a random UA preset. Independent of the platform archetype by design. */
function fpRandomUserAgent() {
  return FP_UA_PRESETS[Math.floor(Math.random() * FP_UA_PRESETS.length)].ua;
}

/**
 * navigator.platform values matching each preset's platform.
 *
 * These are the strings real browsers report, so the pair (UA, platform) reads
 * as one coherent identity rather than two independent settings that happen to
 * disagree. The kernel does NOT enforce this: navigator_platform and the UA are
 * separate surfaces and nothing stops a mismatched pair, which is itself a
 * detection signal. So it is derived here instead of left to the caller.
 */
const FP_PLATFORM_BY_ID = {
  win: "Win32",
  mac: "MacIntel",
  linux: "Linux x86_64",
  android: "Linux armv8l",
  ios: "iPhone"
};

/**
 * The UserAgentMetadata values matching a UA string: brand list, platform and
 * the mobile flag, in the exact wire format Sec-CH-UA uses.
 *
 * Chromium does NOT derive these from navigator.userAgent: it keeps its own
 * brand list, so overriding the UA leaves the hints reporting real Chromium on
 * the real OS. That contradiction is worse than not spoofing at all, because it
 * is trivially detectable - hence this table.
 *
 * `platform` here is the Sec-CH-UA vocabulary ("macOS"), which is NOT the same
 * as navigator.platform ("MacIntel"). Both exist and both leak the OS, so both
 * need covering; fpPlatformForUserAgent() handles the other one.
 *
 * Returns null when the UA is unrecognised, meaning "do not override".
 */
function fpUaMetadataForUserAgent(ua) {
  if (typeof ua !== "string" || !ua) return null;
  const GREASE = '"Not A(Brand";v="99"';
  const mobile = /Android|iPhone|iPad|Mobile/.test(ua);
  // Brand tokens keep "Chromium" because that is the engine this build actually
  // is; only the major version and the ordering follow the impersonated UA.
  const ver = /(?:Chrome|Chromium|CriOS|Edg|Firefox|Version)\/([\d]+)/.exec(ua);
  const major = ver ? ver[1] : "131";

  if (/Firefox/.test(ua) && !/Chrome|Chromium/.test(ua)) {
    // Not hardcoded to Windows: Firefox ships on Linux (X11) and macOS too, and
    // reporting Windows for a Linux UA is the contradiction we are removing.
    const p = /Android/.test(ua) ? "Android"
            : /iPhone|iPad/.test(ua) ? "iOS"
            : /Macintosh/.test(ua) ? "macOS"
            : /Windows/.test(ua) ? "Windows"
            : "Linux";
    return { brands: [GREASE, '"Firefox";v="' + major + '"'],
             platform: p, mobile: mobile };
  }
  if (/Edg\//.test(ua)) {
    return { brands: [GREASE, '"Chromium";v="' + major + '"',
                      '"Microsoft Edge";v="' + major + '"'],
             platform: /Android/.test(ua) ? "Android" : "Windows", mobile: mobile };
  }
  if (/CriOS|Chrome/.test(ua)) {
    const p = /Android/.test(ua) ? "Android"
            : /iPhone|iPad/.test(ua) ? "iOS"
            : /Macintosh/.test(ua) ? "macOS"
            : /Windows/.test(ua) ? "Windows"
            : "Linux";
    return { brands: [GREASE, '"Chromium";v="' + major + '"',
                      '"Google Chrome";v="' + major + '"'],
             platform: p, mobile: mobile };
  }
  if (/Safari/.test(ua)) {
    const p = /iPhone|iPad/.test(ua) ? "iOS"
            : /Macintosh/.test(ua) ? "macOS" : "Windows";
    // Real Safari sends only its own brand - it does not do GREASE.
    return { brands: ['"Safari";v="' + major + '"'], platform: p, mobile: mobile };
  }
  if (/Android/.test(ua)) {
    return { brands: [GREASE, '"Chromium";v="' + major + '"'],
             platform: "Android", mobile: true };
  }
  if (/Windows/.test(ua)) {
    return { brands: [GREASE, '"Chromium";v="' + major + '"'],
             platform: "Windows", mobile: false };
  }
  return null;
}

/**
 * The navigator_platform value matching a UA string, or "" if unknown.
 *
 * Returns "" rather than guessing, because an empty value means "disabled" in
 * the kernel and falls back to the host's real platform. Guessing wrong would
 * be worse than not setting it.
 */
function fpPlatformForUserAgent(ua) {
  if (typeof ua !== "string" || !ua) return "";
  const preset = FP_UA_PRESETS.find(p => p.ua === ua);
  if (preset) return FP_PLATFORM_BY_ID[preset.platform] || "";
  // Not one of our presets (hand-entered, or imported from another client):
  // infer from the UA text so a hand-typed Mac UA does not report Win32.
  //
  // iPhone/iPad MUST be tested before the Mac rule: iOS UAs contain the
  // substring "Mac OS X" ("CPU iPhone OS 18_1 like Mac OS X"), so a
  // Macintosh-first test reports an iPhone as "MacIntel" - a contradiction
  // that is trivial to fingerprint. Ordering here is load-bearing.
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Macintosh|Mac OS X/.test(ua)) return "MacIntel";
  if (/Android/.test(ua)) return "Linux armv8l";
  if (/Windows/.test(ua)) return "Win32";
  if (/X11|Linux/.test(ua)) return "Linux x86_64";
  return "";
}

/**
 * Derive the three audit-fix surfaces (navigator.vendor, navigator.languages,
 * window.devicePixelRatio) from the UA that is actually in effect.
 *
 * Why derive instead of drawing them from the random platform archetype: the
 * archetype and the UA are drawn from two INDEPENDENT pools by deliberate
 * choice, so a profile can legitimately carry a Mac screen behind a Windows
 * UA. That may be odd, but it is not self-contradictory in the way that
 * "iPhone UA + vendor 'Google Inc.'" is - and vendor is the surface detection
 * sites check first. Deriving these three from the UA guarantees they can
 * never contradict it, whatever the archetype happened to pick.
 *
 * Same ordering caveat as fpPlatformForUserAgent: iPhone/iPad must be tested
 * before Mac, because iOS UAs contain the substring "Mac OS X".
 *
 * Returns "" for anything it cannot determine - empty means "disabled" in the
 * kernel and falls back to the host's real value. A wrong guess is worse than
 * no guess.
 */
function fpVendorForUserAgent(ua) {
  if (typeof ua !== "string" || !ua) return "";
  if (/iPhone|iPad|Macintosh|Mac OS X/.test(ua)) return "Apple Computer, Inc.";
  // Chrome/Chromium on Windows, Linux and Android all report Google.
  if (/Windows|Android|X11|Linux/.test(ua)) return "Google Inc.";
  return "";
}

function fpPixelRatioForUserAgent(ua) {
  if (typeof ua !== "string" || !ua) return "";
  // Phones and tablets are always >1; a mobile UA reporting 1 is the exact
  // contradiction the external audit caught.
  if (/iPhone|iPad/.test(ua)) return "3";
  if (/Android/.test(ua)) return "2.75";
  // macOS laptops are Retina.
  if (/Macintosh|Mac OS X/.test(ua)) return "2";
  return "";
}

function fpLanguagesForUserAgent(ua) {
  if (typeof ua !== "string" || !ua) return "";
  // Deliberately conservative: only override when the UA tells us something we
  // can trust. A Windows UA can carry any locale, so guessing "en-US" would
  // replace a real zh-CN with a fabrication - no better than leaking.
  // Locale is far less correlated with OS than vendor and DPR are, so the safe
  // move here is to leave the host value alone unless we know better.
  return "";
}

/**
 * Normalize a user-supplied UA. Anything non-string becomes "" (native), and
 * a whitespace-only string is treated as "no override" rather than being sent
 * as a literal blank UA, which would be an obviously broken header.
 */
function fpNormalizeUserAgent(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
}

// ============================================================================
// TLS / HTTP2: a SECOND client-level surface, deliberately NOT in FP_KEYS.
//
// Same reasoning as the UA (see the block above), and for once the reason is
// structural rather than stylistic:
//
//   * These 9 keys are NOT read by Blink. 40-net-tls.patch adds fp_* fields to
//     net::SSLContextConfig and to the network::mojom::SSLConfig /
//     NetworkContextParams mojom messages, and 50-electron-glue.patch exposes
//     them through session.setSSLConfig(). That is a different API, a different
//     layer and a different process (the network service) from
//     --fingerprint-config.
//   * fpNormalizeConfig() drops every key absent from FP_KEYS, so putting them
//     inside `fingerprint` would silently discard them on apply.
//   * test-schema.js asserts the client key set equals the kernel key set
//     EXACTLY, so adding them to FP_KEYS would also break that assertion and,
//     worse, make it look like the kernel reads them.
//
// So they travel beside the fingerprint, like the UA. fpSplitConfig() at the
// bottom of this file is the single funnel that separates the two planes.

const FP_TLS_KEYS = {
  // JS option name (camelCase, what setSSLConfig() reads)
  //   -> { kind, def, label, hint }
  fpCipherList: { group: "tls",
    kind: "cipherlist", def: "",
    label: "Cipher list",
    hint: 'OpenSSL cipher command, colon-separated. Use TLS 1.2 NAMES ' +
      '(ECDHE-RSA-AES128-GCM-SHA256). TLS 1.3 names (TLS_AES_128_GCM_SHA256) ' +
      'are accepted by setSSLConfig but rejected by BoringSSL, which kills ' +
      'EVERY connection on the session - measured: 0 bytes of ClientHello, ' +
      'net::ERR_UNEXPECTED.',
  },
  fpSignatureAlgorithms: { group: "tls",
    kind: "u16list", def: "",
    label: "Signature algorithms",
    hint: 'Comma-separated uint16 code points, e.g. "1027,1283" ' +
      '(0x0403 ecdsa_secp256r1_sha256, 0x0503 rsa_pss_rsae_sha256).',
  },
  fpGreaseEnabled: { group: "tls",
    kind: "bool", def: "",
    label: "GREASE",
    hint: "Insert GREASE values into the ClientHello. Measured: false drops " +
      "the GREASE cipher from the list (1 -> 0).",
  },
  fpGreaseSigalgsEnabled: { group: "tls",
    kind: "bool", def: "",
    label: "GREASE signature algorithms",
    hint: "Insert a GREASE value into the signature_algorithms extension.",
  },
  fpPermuteExtensions: { group: "tls",
    kind: "bool", def: "",
    label: "Permute extensions",
    hint: "Randomize ClientHello extension order.",
  },
  fpExtensionOrder: { group: "tls",
    kind: "u16list", def: "",
    label: "Extension order",
    hint: 'Comma-separated uint16 extension types to force, e.g. "0,11,10". ' +
      "Only meaningful together with Permute extensions.",
  },
  fpOmitAlpn: { group: "tls",
    kind: "bool", def: "",
    label: "Omit ALPN",
    hint: "Drop the ALPN extension entirely (changes the JA3/JA4 shape).",
  },
  fpOmitSessionTicket: { group: "tls",
    kind: "bool", def: "",
    label: "Omit session ticket",
    hint: "Drop the session_ticket extension. Measured: extension count 17 -> 16.",
  },
  fpAdvertisedVersionMax: { group: "tls",
    kind: "int", def: 0,
    label: "Advertised max version",
    hint: "uint16 TLS version to advertise, e.g. 771 (TLS 1.2) or 772 " +
      "(TLS 1.3). Measured: 771 changes the offered cipher set entirely " +
      "(16 -> 13 ciphers, different list).",
  },
};

const FP_TLS_KEY_NAMES = Object.keys(FP_TLS_KEYS);

/** True when a TLS key holds a value that differs from its disabled default. */
function fpTlsIsActive(key, value) {
  const spec = FP_TLS_KEYS[key];
  if (!spec) return false;
  if (value === undefined || value === null || value === "") return false;
  if (typeof spec.def === "number") return Number(value) !== 0;
  return String(value) !== String(spec.def);
}

/**
 * Coerce a TLS value into the type the gin converter in 50-electron-glue.patch
 * expects. That converter reads an explicit whitelist with typed Get() calls,
 * so a string where a bool is expected is not coerced - it throws.
 *
 * This is the mirror image of the fpCoerce() trap in the other direction:
 * there, a NUMBER silently disables a string-read kernel key. Here, a STRING
 * loudly breaks the call. Both are avoided by coercing at the funnel.
 */
function fpTlsCoerce(key, value) {
  const spec = FP_TLS_KEYS[key];
  if (!spec || value === undefined || value === null) return value;
  if (spec.kind === "bool") {
    if (value === true) return true;
    if (value === false) return false;
    const s = String(value).trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    return false;
  }
  if (spec.kind === "int") {
    const n = Number(value);
    if (!isFinite(n)) return 0;
    return Math.trunc(n);
  }
  if (spec.kind === "u16list") {
    if (Array.isArray(value)) {
      return value.map((v) => {
        const n = Number(v);
        return isFinite(n) ? Math.max(0, Math.min(0xffff, Math.trunc(n))) : 0;
      }).filter((n) => n > 0);
    }
    // "1027,1283" -> [1027, 1283]. Hex ("0x0403") is accepted too, since that
    // is how the code points are written in every TLS reference.
    return String(value).split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => {
        const n = /^0x/i.test(s) ? parseInt(s, 16) : Number(s);
        return isFinite(n) ? Math.max(0, Math.min(0xffff, Math.trunc(n))) : 0;
      }).filter((n) => n > 0);
  }
  // cipherlist
  return String(value).trim();
}

// TLS 1.3 cipher suite names, as BoringSSL spells them. setSSLConfig() accepts
// these (it only rejects the empty string) and hands them to BoringSSL, which
// rejects the WHOLE cipher command - after which the session cannot complete a
// handshake at all. Measured:
//
//   fpCipherList: 'TLS_AES_128_GCM_SHA256'  ->  0 bytes of ClientHello,
//                                               net::ERR_UNEXPECTED on every
//                                               request in the session
//   fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256'  ->  1751 bytes, works
//
// So they are rejected HERE, at apply time, with a message naming the
// TLS 1.2 equivalent. Silently accepting them would make the browser unable to
// load any page while the panel showed the profile as applied.
const FP_TLS13_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
];

/**
 * Validate a cipher list before it reaches setSSLConfig().
 * Returns { ok, error, ciphers }.
 *
 * Only the TLS 1.3-name case is rejected; an unknown-but-valid-shaped name is
 * left alone rather than guessed at, because a whitelist of every OpenSSL
 * cipher would go stale and then reject working values. The specific, measured
 * foot-gun is what gets caught.
 */
function fpTlsValidateCipherList(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return { ok: true, error: '', ciphers: [] };
  const parts = s.split(':').map((x) => x.trim()).filter(Boolean);
  const bad = parts.filter((p) => FP_TLS13_CIPHERS.includes(p.toUpperCase()));
  if (bad.length) {
    return {
      ok: false,
      error: 'TLS 1.3 cipher names break every connection on the session ' +
        '(BoringSSL rejects the whole cipher command). Offending: ' +
        bad.join(', ') + '. Use the TLS 1.2 name instead, e.g. ' +
        'ECDHE-RSA-AES128-GCM-SHA256.',
      ciphers: parts,
    };
  }
  return { ok: true, error: '', ciphers: parts };
}

const FP_TLS_GROUPS = [
  { id: "tls", label: "TLS / HTTP2", desc: "ClientHello shape: ciphers, GREASE, extensions, ALPN, max version" },
];

/**
 * Split a flat config object into the two delivery planes.
 *
 * Blink keys (FP_KEYS) go to --fingerprint-config via BrowserView's
 * `fingerprint` webPreference; TLS keys (FP_TLS_KEYS) go to
 * session.setSSLConfig(). Mixing them is the trap this exists to prevent:
 * fpNormalizeConfig() drops unknown keys, so a TLS key placed inside the
 * fingerprint object is silently discarded and the user sees a profile that
 * claims a TLS fingerprint it does not produce.
 *
 * Returns { fingerprint, tls, unknown }. `unknown` is reported rather than
 * dropped silently, so a typo surfaces at apply time instead of becoming a
 * fingerprint the browser never had.
 */
function fpSplitConfig(input) {
  const fingerprint = {};
  const tls = {};
  const unknown = [];
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      if (Object.prototype.hasOwnProperty.call(FP_KEYS, k)) {
        fingerprint[k] = v;
      } else if (Object.prototype.hasOwnProperty.call(FP_TLS_KEYS, k)) {
        tls[k] = v;
      } else {
        unknown.push(k);
      }
    }
  }
  // Normalize the Blink plane (fills defaults, coerces string-read kinds).
  const norm = fpNormalizeConfig(fingerprint);
  // Coerce the TLS plane into the types the gin converter demands.
  const tlsOut = {};
  for (const k of FP_TLS_KEY_NAMES) {
    if (Object.prototype.hasOwnProperty.call(tls, k)) {
      tlsOut[k] = fpTlsCoerce(k, tls[k]);
    }
  }
  return { fingerprint: norm.config, tls: tlsOut, unknown: unknown.concat(norm.unknown) };
}

module.exports = {
  FP_SCHEMA_VERSION,
  FP_KEYS,
  FP_KEY_NAMES,
  FP_GROUPS,
  FP_GROUP_IDS,
  fpDefaultConfig,
  fpNormalizeConfig,
  fpCoerce,
  fpKeysInGroup,
  fpCoverage,
  fpIsActive,
  // TLS (second client-level surface, not a kernel key)
  FP_TLS_KEYS,
  FP_TLS_KEY_NAMES,
  FP_TLS_GROUPS,
  fpTlsIsActive,
  fpTlsCoerce,
  fpSplitConfig,
  fpTlsValidateCipherList,
  FP_TLS13_CIPHERS,
  // UA (client-level surface, not a kernel key)
  FP_UA_PRESETS,
  FP_PLATFORM_BY_ID,
  fpRandomUserAgent,
  fpNormalizeUserAgent,
fpPlatformForUserAgent,
fpUaMetadataForUserAgent,
fpVendorForUserAgent,
fpPixelRatioForUserAgent,
fpLanguagesForUserAgent,
};

