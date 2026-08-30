// ============================================================================
// fp-schema.js - Single source of truth for fingerprint config keys.
//
// Every key here MUST exist in the kernel patch:
//   F:\code\src\electron\fingerprint\patches\fp-fingerprint.patch
// (look for FpConfigString / FpConfigInt / FpConfigInt64 call sites).
// The kernel README claims "60" keys and that IS the correct count (verified
// against check.py's 60 EXPECTED_KEYS and the FpConfig* call sites).
//
// An earlier note here claimed 56. That undercount came from grepping the
// patch for FpConfig* call sites: four webgl_* keys are written inside
// ternary expressions split across lines
//   pname == 0x9245 ? "webgl_vendor" : "webgl_renderer"
// so a line-oriented grep missed them. Counting with a paren-balanced parse
// gives 60, matching check.py. Trust check.py over a regex here.
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
    hint: 'Brand list, e.g. {"0":"Not A(Brand";v="99"}. Empty = derive from UA.'
  },
  ua_platform: {
    group: "navigator", kind: "str", def: "",
    hint: 'Sec-CH-UA-Platform value, e.g. "macOS" / "Windows" / "Linux" / "Android". Empty = derive from UA.'
  },
  ua_mobile: {
    group: "navigator", kind: "str", def: "",
    hint: '"true" or "false" for Sec-CH-UA-Mobile. Empty = derive from UA.'
  },
};
// --- Functional groups -------------------------------------------------------
// Each of the 60 kernel keys belongs to exactly ONE group. Groups drive the
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
  return value;
}

// ============================================================================
// User-Agent: a CLIENT-level (Electron) surface, deliberately NOT a kernel key.
//
// The kernel's 60 keys are read by Blink via --fingerprint-config. The UA is
// applied by Electron's session.setUserAgent(), which is a different layer
// entirely. Keeping it out of FP_KEYS is not cosmetic:
//
//   * fpNormalizeConfig() drops every key the kernel does not know, so a UA
//     placed inside `fingerprint` would be silently discarded on apply.
//   * test-schema.js asserts the client key set equals the kernel key set
//     exactly, so adding a 57th key here would break that assertion.
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
 * Normalize a user-supplied UA. Anything non-string becomes "" (native), and
 * a whitespace-only string is treated as "no override" rather than being sent
 * as a literal blank UA, which would be an obviously broken header.
 */
function fpNormalizeUserAgent(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
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
  // UA (client-level surface, not a kernel key)
  FP_UA_PRESETS,
  FP_PLATFORM_BY_ID,
  fpRandomUserAgent,
  fpNormalizeUserAgent,
  fpPlatformForUserAgent,
  fpUaMetadataForUserAgent,
};

