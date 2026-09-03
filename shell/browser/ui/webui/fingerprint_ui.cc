// Copyright (c) 2026 Microsoft, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE.

#include "shell/browser/ui/webui/fingerprint_ui.h"

#include <array>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <utility>

#include <vector>

#include "base/base64.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/memory/ref_counted_memory.h"
#include "base/values.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/url_data_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"

#include "shell/browser/api/electron_api_web_contents.h"
#include "shell/browser/electron_browser_context.h"
#include "shell/browser/session_preferences.h"
#include "shell/browser/web_contents_preferences.h"
#include "shell/common/electron_constants.h"
#include "shell/browser/ui/webui/fingerprint_ui_page.h"

namespace electron {

namespace {

// The host served by this controller.
//
// Deliberately NOT in chrome/common/webui_url_constants.h: that header lists
// CHROME's WebUI hosts. Putting this there would imply chrome://fingerprint
// exists, and it does not - only electron://fingerprint does.
constexpr std::string_view kFingerprintHost = "fingerprint";

scoped_refptr<base::RefCountedMemory> Bytes(std::string_view s) {
  return base::MakeRefCounted<base::RefCountedString>(std::string(s));
}



// The paths the page requests. No leading slash: URLDataSource::URLToRequestPath
// strips it.
constexpr std::string_view kInspectorDataPath = "inspector-data.json";
constexpr std::string_view kAppJs = "app.js";

// Build the JSON the page consumes.
//
// This reports the ACTIVE configuration read back from SessionPreferences - not
// a hardcoded sample, and not recomputed from scratch. An inspector that shows
// what a profile WOULD look like is decorative; the value is in showing what
// the running browser actually has. Reading the live value also means the page
// cannot drift from the thing it describes.
std::string BuildInspectorDataFor(content::BrowserContext* context) {
  base::DictValue out;

  // There are TWO stores and the effective config may live in either:
  //
  //   SessionPreferences      <- session.setFingerprintConfig({...})
  //   WebContentsPreferences  <- new BrowserView({ webPreferences: { fingerprint } })
  //
  // The Client uses the second one (Client/main.js builds a BrowserView per tab
  // with `fingerprint` in webPreferences), so reading only SessionPreferences
  // shows an empty profile for a real Client tab - precisely the case the
  // Inspector exists to inspect. Both are read, and the results are merged.
  std::string b64;
  if (auto* prefs = electron::SessionPreferences::FromBrowserContext(context)) {
    b64 = prefs->GetFingerprintConfigBase64();
  }

  base::DictValue config;
  if (!b64.empty()) {
    std::string json;
    if (base::Base64Decode(b64, &json)) {
      // Read() needs the options argument; the 1-arg overloads that exist are
      // typed (ReadDict/ReadList) and would silently reject a non-dict.
      std::optional<base::Value> v = base::JSONReader::Read(json, 0);
      if (v && v->is_dict()) {
        config = std::move(v->GetDict());
      } else {
        out.Set("error", "fingerprint config is set but not valid JSON");
      }
    } else {
      out.Set("error", "fingerprint config is set but not valid base64");
    }
  }

  // Coverage: how many keys are actually set, per group.
  //
  // fpCoverage lives in the app's JS (Client/fp-schema.js), not in C++, so the
  // groups/keys are mirrored here from the schema. That duplication is deliberate
  // but MUST stay in sync - see the note in fingerprint_ui.h.
  struct GroupDef {
    const char* id;
    const char* label;
    // Member arrays (not raw C arrays) so indexing is bounds-checked and the
    // unsafe-buffer-usage warning - which is -Werror here - does not fire.
    // Sized for the widest group (webgl, 9 keys) with a little headroom; if a
    // group ever outgrows it, this fails to compile rather than silently
    // dropping keys - which is what we want, but it means the size must be
    // bumped deliberately, not guessed.
    std::array<const char*, 12> keys;
  };

  // Function-local static inside a lambda rather than a plain `static const`
  // container: a namespace/file-scope non-trivially-destructible static
  // requires an exit-time destructor, which is -Werror here.
  static const std::vector<GroupDef>& kGroups = *[] {
    static const base::NoDestructor<std::vector<GroupDef>> v(std::vector<GroupDef>{
      {"hardware",
       "Hardware",
       {"hardware_concurrency", "device_memory", "max_touch_points"}},
      {"screen",
       "Screen",
       {"screen_width", "screen_height", "screen_avail_width",
        "screen_avail_height", "screen_color_depth", "device_pixel_ratio"}},
      {"audio",
       "Audio",
       {"audio_sample_rate", "audio_max_channels", "audio_output_latency_ms",
        "audio_data_seed", "audio_data_strength"}},
      {"webgl",
       "WebGL",
       {"webgl_max_texture_size", "webgl_max_renderbuffer_size",
         "webgl_max_viewport_dims", "webgl_aliased_point_size_range",
         "webgl_aliased_line_width_range", "webgl_vendor", "webgl_renderer",
         "webgl_extensions", "webgl_shader_precision_highp"}},
      {"webgpu",
       "WebGPU",
       {"webgpu_vendor", "webgpu_architecture", "webgpu_device",
        "webgpu_description", "webgpu_features", "webgpu_limits"}},
      {"geo", "Geolocation", {"geo_latitude", "geo_longitude", "geo_accuracy"}},
      {"speech", "Speech", {"speech_voices_count", "speech_voices_lang"}},
      {"media",
       "Media devices",
       {"media_devices_audio_input", "media_devices_video_input",
        "media_devices_audio_output", "media_codecs_denylist"}},
      {"canvas",
       "Canvas",
       {"canvas_noise_seed", "canvas_noise_strength", "measure_text_seed",
        "client_rects_seed"}},
      {"env",
       "Environment",
       {"tz_id", "prefers_color_scheme", "do_not_track"}},
      {"network",
       "Network",
       {"net_effective_type", "net_rtt_ms", "net_downlink_mbps", "webrtc_ip"}},
      {"storage",
       "Storage",
       {"storage_usage_bytes", "storage_quota_bytes", "permissions_status",
         "perf_now_precision_ms"}},
      {"fonts", "Fonts", {"fonts_blocklist", "fonts_whitelist"}},
      {"battery", "Battery", {"battery_charging", "battery_level"}},
      {"navigator",
       "Navigator",
       {"navigator_platform", "ua_brands", "ua_platform", "ua_mobile",
         "navigator_vendor", "navigator_languages"}}});
     return &*v;
   }();

  // Numeric-kind keys, generated from Client/fp-schema.js (see the generator
  // note in Client/test-inspector.js "schema parity" section).
  //
  // is_set() needs these because "is this key set" is defined against the key's
  // DEFAULT, not against emptiness: 0 / "" are the schema's disabled
  // placeholder values, NOT real values. A numeric key holding the string "0"
  // is non-empty (an emptiness test says "set") but equals the default
  // (fpIsActive() says "unset") - and a JSON round-trip produces exactly that.
  //
  // Every numeric default in the schema is 0 and every non-numeric default is
  // "", so a per-key default TABLE is not needed - only the numeric/non-numeric
  // distinction, which is what this list carries. Keeping it as names rather
  // than a 63-entry table also means it fails loudly (test-schema parity check)
  // instead of drifting silently.
  static constexpr std::string_view kNumericKeyNames[] = {
      "audio_output_latency_ms",
      "audio_sample_rate",
      "canvas_noise_seed",
      "canvas_noise_strength",
      "client_rects_seed",
      "device_memory",
      "hardware_concurrency",
      "max_touch_points",
      "media_devices_audio_input",
      "media_devices_audio_output",
      "media_devices_video_input",
      "net_rtt_ms",
      "perf_now_precision_ms",
      "screen_avail_height",
      "screen_avail_width",
      "screen_color_depth",
      "screen_height",
      "screen_width",
      "speech_voices_count",
      "storage_quota_bytes",
      "storage_usage_bytes",
      "webgl_max_renderbuffer_size",
      "webgl_max_texture_size",
      "webgl_max_viewport_dims",
      // These three were missing: they are numeric in the schema but were
      // absent here, so is_set() treated them as string-kind and reported
      // "0" / 0.0 / " 0 " as ACTIVE where fpIsActive() says inactive. Found by
      // diffing this list against FP_KEYS, not by any existing test:
      // test-inspector.js checks only 6 hand-picked keys, so it cannot see a
      // key it never mentions.
      "audio_data_seed",
      "audio_max_channels",
      "measure_text_seed",
      };

  // A key counts as "set" when it carries a non-default value. 0 / "" are the
  // Mirrors fpIsActive() in Client/fp-schema.js, which is the authoritative
  // definition of "this surface is configured". The two MUST agree: the panel's
  // coverage counts, the skip/pass decisions and the app's own coverage() all
  // read the same config, and a disagreement silently misreports how much of a
  // profile is active.
  //
  // The naive version tested only emptiness, which disagrees with fpIsActive for
  // numeric keys holding the STRING "0" (or "0.0"): non-empty, so counted as
  // set here - but equal to the default, so fpIsActive() counts it as unset.
  // A JSON round-trip or an editor that quotes numbers produces exactly this,
  // and 25 of the 63 keys are numeric, so it is not a corner case.
  //
  // Deciding correctly needs the key's DEFAULT, not just the value: the schema's
  // disabled placeholder is 0 for numeric keys and "" for the rest. Every
  // numeric default in the schema is 0 and every string default is "", so this
  // only needs to know which keys are numeric.
  static const base::NoDestructor<std::set<std::string_view>> kNumericKeys([] {
    std::set<std::string_view> s;
    for (std::string_view k : kNumericKeyNames) {
      s.insert(k);
    }
    return s;
  }());

  // fpIsActive() is:
  //   null/undefined/"" -> false
  //   numeric default   -> Number(value) !== 0
  //   otherwise         -> String(value) !== String(def)   // def is ""
  //
  // The key kind decides WHICH conversion happens, so it must be consulted for
  // every value form - not just strings. The previous version fell through to
  // `GetInt() != 0` / `GetBool()` for non-strings, which quietly applies the
  // NUMERIC rule to string-kind keys. Consequences:
  //   * string-kind key holding 0      -> C++ inactive, JS active ("0" !== "")
  //   * string-kind key holding false  -> C++ inactive, JS active ("false" !== "")
  // Both are false negatives: the panel under-reports coverage for exactly the
  // boolean-ish keys a user is most likely to set to 0/false.
  auto is_set = [](const std::string& key, const base::Value* v) {
    if (!v) return false;
    const bool numeric = kNumericKeys->count(key) != 0;
    if (v->is_string()) {
      const std::string& s = v->GetString();
      if (s.empty()) return false;  // fpIsActive's early return, both kinds
      if (!numeric) return true;    // String(s) !== "" is true for any non-empty
      // Numeric key held as text: JS Number() semantics.
      //
      // base::StringToDouble() is NOT Number(): it accepts "0x0" (hex) and
      // rejects " 0 " (leading/trailing space). Number("0x0") == 0 -> inactive,
      // Number(" 0 ") == 0 -> inactive. So StringToDouble disagrees with the JS
      // in both directions. Trim first, and handle hex separately.
      std::string t;
      base::TrimWhitespaceASCII(s, base::TRIM_ALL, &t);
      if (t.empty()) return false;  // trimmed to nothing -> Number() is 0
      {
        std::string u = t;
        // Sign is irrelevant here: we only test != 0, and in JS -0 !== 0 is
        // false, so "+0x0" and "-0x0" are both inactive. Strip and compare
        // magnitude.
        if (!u.empty() && (u[0] == '+' || u[0] == '-')) {
          u.erase(0, 1);
        }
        // Hex is where base::StringToDouble() and Number() genuinely diverge:
        // Number("0x0") is 0 (inactive) while an earlier version treated any
        // hex as unparseable text -> active. Parse it explicitly.
        if (u.size() > 2 && u[0] == '0' && (u[1] == 'x' || u[1] == 'X')) {
          uint64_t hv = 0;
          if (base::HexStringToUInt64(u, &hv)) {
            return hv != 0;  // Number("0x0") === 0 -> inactive
          }
          return true;  // malformed hex: Number() is NaN, NaN !== 0 -> active
        }
      }
      double d = 0;
      if (base::StringToDouble(t, &d)) {
        return d != 0.0;
      }
      // Not numeric at all: Number() is NaN, and NaN !== 0 is true -> active.
      return true;
    }
    if (v->is_int() || v->is_double()) {
      const double d = v->is_int() ? static_cast<double>(v->GetInt())
                                   : v->GetDouble();
      if (!numeric) return true;  // String(0) == "0" !== "" -> active
      return d != 0.0;
    }
    if (v->is_bool()) {
      // String(false) == "false" !== "" -> ACTIVE on a string-kind key.
      // Number(false) == 0              -> inactive on a numeric key.
      if (!numeric) return true;
      return v->GetBool();
    }
    if (v->is_none()) return false;  // maps to JS undefined
    // Objects/lists: String(v) is never "" -> active on a string-kind key.
    return !numeric;
  };

  // Merge in the per-WebContents (webPreferences) configs for this context.
  //
  // These are what the Client actually sets (Client/main.js builds a
  // BrowserView per tab with `fingerprint` in webPreferences, which lands in
  // WebContentsPreferences - NOT SessionPreferences). Without this merge the
  // Inspector reports an empty profile for a real Client tab, which is both
  // wrong and actively harmful: it reads as "verified clean" when in fact
  // nothing was read.
  //
  // This must run BEFORE the coverage loop, which counts the merged dict.
  int wc_configs = 0;
  for (electron::api::WebContents* ewc :
       electron::api::WebContents::GetWebContentsList()) {
    if (!ewc) {
      continue;
    }
    content::WebContents* wc = ewc->web_contents();
    if (!wc || wc->GetBrowserContext() != context) {
      continue;  // the Inspector is scoped to its own BrowserContext
    }
    auto* wc_prefs = electron::WebContentsPreferences::From(wc);
    if (!wc_prefs) {
      continue;
    }
    const std::string& wc_b64 = wc_prefs->GetFingerprintConfigBase64();
    if (wc_b64.empty()) {
      continue;
    }
    std::string wc_json;
    if (!base::Base64Decode(wc_b64, &wc_json)) {
      continue;
    }
    std::optional<base::Value> wc_val = base::JSONReader::Read(wc_json, 0);
    if (!wc_val || !wc_val->is_dict()) {
      continue;
    }
    ++wc_configs;
    // WebContents config wins on conflict: it is the more specific of the two,
    // and it is what a real tab actually runs with.
    for (auto [key, value] : wc_val->GetDict()) {
      config.Set(key, std::move(value));
    }
  }

  base::ListValue coverage;
  int total_active = 0;
  int total_keys = 0;
  base::ListValue empty_groups;

  for (const GroupDef& def : kGroups) {
    int active = 0;
    int total = 0;
    base::ListValue group_keys;
    for (const char* key : def.keys) {
      if (!key) {
        continue;  // unused tail slots in the fixed-size array
      }
      ++total;
      // Exposed so a test can pin GROUP MEMBERSHIP, not just the counts. The
      // counts alone cannot detect a key filed under the wrong group: every
      // per-group total, the 63-key total and all 15 group ids stay identical
      // while the key is reported under the wrong heading. Duplicating the
      // schema in C++ (see the note in fingerprint_ui.h) makes that drift
      // possible; this makes it observable.
      group_keys.Append(key);
      if (is_set(std::string(key), config.Find(std::string_view(key)))) {
        ++active;
      }
    }
    total_active += active;
    total_keys += total;
    base::DictValue g;
    g.Set("id", def.id);
    g.Set("label", def.label);
    g.Set("active", active);
    g.Set("total", total);
    g.Set("keys", std::move(group_keys));
    coverage.Append(std::move(g));
    if (active == 0) {
      empty_groups.Append(def.id);
    }
  }

  base::DictValue summary;
  summary.Set("active", total_active);
  summary.Set("total", total_keys);
  summary.Set("groups", static_cast<int>(kGroups.size()));
  summary.Set("emptyGroups", std::move(empty_groups));

  out.Set("summary", std::move(summary));
  out.Set("coverage", std::move(coverage));

  // Cross-layer consistency: the SAME rule set as Client/browser-profile.js.
  //
  // This is a port, not an approximation. An earlier version of this panel ran
  // one ad-hoc check and hardcoded warnCount to 0, so it rendered "Profile is
  // consistent" having evaluated 1 rule out of 8 - and with all four warn-level
  // rules unreachable. For a panel whose entire purpose is detecting
  // contradictions, reporting "clean" because the rules never ran is the worst
  // possible outcome. Every rule below mirrors its JS counterpart, including
  // the pass/fail/SKIP contract.
  //
  // The skip contract is what makes this trustworthy: a rule whose inputs are
  // absent must say "could not evaluate", never "passed". skipped[] is shown,
  // not hidden.
  base::ListValue findings;
  base::ListValue skipped;

  // Severity strings match SEVERITY in browser-profile.js.
  constexpr std::string_view kError = "error";
  constexpr std::string_view kWarning = "warn";

  // A rule records either a finding or a skip. Passing = neither.
  auto fail = [&findings](std::string_view id, std::string_view severity,
                          const std::string& message,
                          std::string_view describe) {
    base::DictValue f;
    f.Set("id", id);
    f.Set("severity", severity);
    f.Set("message", message);
    f.Set("describe", describe);
    findings.Append(std::move(f));
  };
  auto skip = [&skipped](std::string_view id, std::string_view reason) {
    base::DictValue s;
    s.Set("id", id);
    s.Set("reason", reason);
    skipped.Append(std::move(s));
  };

  // Total rules we intend to run. Reported so the page can say "N of 8 rules
  // evaluated" instead of implying full coverage when a rule is missing.
  constexpr int kRuleCount = 8;
  int rules_evaluated = 0;

  // The UA in effect for this BrowserContext - session.setUserAgent() included,
  // not just the compiled-in default. Four of the eight rules are anchored to
  // it; without the spoofed value they could only ever skip.
  std::string user_agent;
  if (auto* bc = static_cast<ElectronBrowserContext*>(context)) {
    user_agent = bc->GetUserAgent();
  }

  // --- helpers mirroring fp-schema.js -------------------------------------
  // Comparisons are case/whitespace-insensitive: the surfaces genuinely use
  // different casing ("Win32" vs "Windows", "MacIntel" vs "macOS"), and a
  // case-sensitive compare flags cosmetic differences as contradictions.
  auto norm = [](const std::string& v) {
    return base::ToLowerASCII(base::TrimWhitespaceASCII(v, base::TRIM_ALL));
  };

  // fpPlatformForUserAgent. iPhone/iPad MUST be tested before the Mac rule:
  // iOS UAs contain the substring "Mac OS X" ("CPU iPhone OS 18_1 like Mac OS
  // X"), so a Macintosh-first test reports an iPhone as "MacIntel" - a
  // contradiction that is trivial to fingerprint. Ordering is load-bearing.
  auto platform_for_ua = [](const std::string& ua) -> std::string {
    if (ua.empty()) return "";
    if (ua.find("iPhone") != std::string::npos ||
        ua.find("iPad") != std::string::npos) return "iPhone";
    if (ua.find("Macintosh") != std::string::npos ||
        ua.find("Mac OS X") != std::string::npos) return "MacIntel";
    if (ua.find("Android") != std::string::npos) return "Linux armv8l";
    if (ua.find("Windows") != std::string::npos) return "Win32";
    if (ua.find("X11") != std::string::npos ||
        ua.find("Linux") != std::string::npos) return "Linux x86_64";
    return "";
  };

  // fpVendorForUserAgent. Same ordering caveat as above.
  auto vendor_for_ua = [](const std::string& ua) -> std::string {
    if (ua.empty()) return "";
    if (ua.find("iPhone") != std::string::npos ||
        ua.find("iPad") != std::string::npos ||
        ua.find("Macintosh") != std::string::npos ||
        ua.find("Mac OS X") != std::string::npos) return "Apple Computer, Inc.";
    // Exactly fpVendorForUserAgent(): Apple first, then anything on
    // Windows/Android/X11/Linux reports Google. There is deliberately NO
    // per-browser case - an earlier port invented a Firefox/Edg/CriOS special
    // case that is not in the JS, and it made Firefox UAs return "" so the
    // vendor rule SKIPPED instead of FAILED. A rule that skips looks clean.
    if (ua.find("Windows") != std::string::npos ||
        ua.find("Android") != std::string::npos ||
        ua.find("X11") != std::string::npos ||
        ua.find("Linux") != std::string::npos) return "Google Inc.";
    return "";
  };

  // fpUaMetadataForUserAgent: only the `mobile` and `platform` fields are
  // needed by these rules.
  // fpUaMetadataForUserAgent() returns NULL for a UA it cannot classify
  // (e.g. "curl/8.4.0"), and both rules that read `mobile` guard on that:
  // `if (!meta || typeof meta.mobile !== 'boolean') return { skip: ... }`.
  //
  // Returning a plain bool loses that third state and turns "cannot classify"
  // into "definitely desktop" - so rule 5 would EVALUATE and could emit a
  // "desktop UA but max_touch_points is set" warning for a UA that JS skips
  // entirely. The tri-state is the point: unclassifiable must stay a skip.
  auto ua_mobile_state = [](const std::string& ua) -> int {
    if (ua.empty()) return -1;  // no UA at all
    // Mirrors the branches of fpUaMetadataForUserAgent(): it returns null when
    // none of Firefox/Edg/CriOS|Chrome/Safari/Android/Windows matched.
    const bool known =
        ua.find("Firefox") != std::string::npos ||
        ua.find("Edg/") != std::string::npos ||
        ua.find("CriOS") != std::string::npos ||
        ua.find("Chrome") != std::string::npos ||
        ua.find("Safari") != std::string::npos ||
        ua.find("Android") != std::string::npos ||
        ua.find("Windows") != std::string::npos;
    if (!known) return -1;  // unclassifiable -> rules must skip
    return (ua.find("Android") != std::string::npos ||
            ua.find("iPhone") != std::string::npos ||
            ua.find("iPad") != std::string::npos ||
            ua.find("Mobile") != std::string::npos)
               ? 1
               : 0;
  };
  auto ua_ch_platform = [](const std::string& ua) -> std::string {
    if (ua.empty()) return "";
    if (ua.find("Android") != std::string::npos) return "Android";
    if (ua.find("iPhone") != std::string::npos ||
        ua.find("iPad") != std::string::npos) return "iOS";
    if (ua.find("Macintosh") != std::string::npos ||
        ua.find("Mac OS X") != std::string::npos) return "macOS";
    if (ua.find("Windows") != std::string::npos) return "Windows";
    if (ua.find("X11") != std::string::npos ||
        ua.find("Linux") != std::string::npos) return "Linux";
    return "";
  };

  // Fetch a config value as a string, accepting the numeric and boolean forms
  // the JSON editor can produce. Empty optional = key absent or unset.
  auto cfg_str = [&config](std::string_view key) -> std::optional<std::string> {
    const base::Value* v = config.Find(key);
    if (!v) return std::nullopt;
    if (const std::string* s = v->GetIfString()) return *s;
    if (std::optional<int> i = v->GetIfInt()) return base::NumberToString(*i);
    if (std::optional<bool> b = v->GetIfBool()) return *b ? "true" : "false";
    if (std::optional<double> d = v->GetIfDouble()) {
      return base::NumberToString(*d);
    }
    return std::nullopt;
  };

  // --- rule 1: platform-matches-ua (error) --------------------------------
  {
    auto platform = cfg_str("navigator_platform");
    if (!user_agent.empty() && platform && !platform->empty()) {
      ++rules_evaluated;
      const std::string want = platform_for_ua(user_agent);
      if (want.empty()) {
        skip("platform-matches-ua", "could not derive a platform from this UA");
      } else if (norm(want) != norm(*platform)) {
        fail("platform-matches-ua", kError,
             "UA implies platform \"" + want + "\" but navigator_platform is \"" +
                 *platform + "\"",
             "navigator.platform agrees with the platform implied by the UA");
      }
    } else {
      skip("platform-matches-ua",
           "needs both user_agent and navigator_platform");
    }
  }

  // --- rule 2: vendor-matches-ua (error) ----------------------------------
  {
    auto vendor = cfg_str("navigator_vendor");
    if (!user_agent.empty() && vendor && !vendor->empty()) {
      ++rules_evaluated;
      const std::string want = vendor_for_ua(user_agent);
      if (want.empty()) {
        skip("vendor-matches-ua", "could not derive a vendor from this UA");
      } else if (norm(want) != norm(*vendor)) {
        fail("vendor-matches-ua", kError,
             "UA implies vendor \"" + want + "\" but navigator_vendor is \"" +
                 *vendor + "\"",
             "navigator.vendor agrees with the vendor implied by the UA");
      }
    } else {
      skip("vendor-matches-ua", "needs both user_agent and navigator_vendor");
    }
  }

  // --- rule 3: ua-mobile-matches-ua (error) --------------------------------
  {
    auto mobile = cfg_str("ua_mobile");
    // Mirrors the JS guard order exactly: missing inputs first, THEN
    // "could not derive mobility from this UA".
    const int mobile_state = ua_mobile_state(user_agent);
    if (user_agent.empty() || !mobile || mobile->empty()) {
      skip("ua-mobile-matches-ua", "needs both user_agent and ua_mobile");
    } else if (mobile_state < 0) {
      skip("ua-mobile-matches-ua", "could not derive mobility from this UA");
    } else {
      ++rules_evaluated;
      // ua_mobile is stored as the STRING "true"/"false", but the editor can
      // hand us a boolean or 0/1. Treating the string "false" as truthy would
      // make every desktop profile look mobile.
      const std::string m = norm(*mobile);
      const bool got = (m == "true" || m == "1");
      const bool want = (mobile_state == 1);
      if (got != want) {
        fail("ua-mobile-matches-ua", kError,
             "UA implies mobile=" + std::string(want ? "true" : "false") +
                 " but ua_mobile=" + *mobile,
              "ua_mobile (Client Hint) agrees with the UA being a mobile device");
      }
    }
  }

  // --- rule 4: ua-platform-ch-matches-ua (error) ---------------------------
  {
    auto ch_platform = cfg_str("ua_platform");
    if (!user_agent.empty() && ch_platform && !ch_platform->empty()) {
      ++rules_evaluated;
      const std::string want = ua_ch_platform(user_agent);
      if (want.empty()) {
        skip("ua-platform-ch-matches-ua",
             "could not derive a platform from this UA");
      } else if (norm(want) != norm(*ch_platform)) {
        fail("ua-platform-ch-matches-ua", kError,
             "UA implies Client-Hint platform \"" + want +
                 "\" but ua_platform is \"" + *ch_platform + "\"",
             "ua_platform (Client Hint) agrees with the OS implied by the UA");
      }
    } else {
      skip("ua-platform-ch-matches-ua", "needs both user_agent and ua_platform");
    }
  }

  // --- rule 5: mobile-hardware-consistent (warn) ---------------------------
  {
    const int mobile_state = ua_mobile_state(user_agent);
    if (user_agent.empty()) {
      skip("mobile-hardware-consistent", "needs a user_agent");
    } else if (mobile_state < 0) {
      // JS skips when meta is null. Evaluating here would treat an
      // unclassifiable UA as desktop and could warn "desktop UA but
      // max_touch_points is set" for a UA the JS never even considers.
      skip("mobile-hardware-consistent",
           "could not derive mobility from this UA");
    } else {
      ++rules_evaluated;
      auto touch = cfg_str("max_touch_points");
      double touch_val = 0;
      const bool touch_parsed =
          touch && !touch->empty() && base::StringToDouble(*touch, &touch_val);
      const bool has_touch = touch_parsed && touch_val != 0.0;
      const bool want_mobile = (mobile_state == 1);
      if (want_mobile && !has_touch) {
        fail("mobile-hardware-consistent", kWarning,
             "mobile UA but max_touch_points is not set (real phones report "
             "touch)",
             "touch points are set for a mobile UA, and absent for a desktop "
             "one");
      } else if (!want_mobile && has_touch) {
        fail("mobile-hardware-consistent", kWarning,
              "desktop UA but max_touch_points is set - a mobile-emulation tell",
              "touch points are set for a mobile UA, and absent for a desktop "
              "one");
      }
    }
  }

  // --- rule 6: device-memory-plausible (warn) ------------------------------
  {
    auto dm = cfg_str("device_memory");
    // The schema's DISABLED placeholder is 0/"" - the defaults are deliberately
    // 0/"" so an untouched key means "do not spoof". Warning on it would flag
    // every empty profile, so use the same is_set() notion as the coverage
    // counters above.
    // is_set(), not a bare `*dm != "0"`: it applies the same default-aware rule
    // as the coverage counters, so a key reported as inactive is never also
    // evaluated as a real value.
    if (is_set("device_memory", config.Find("device_memory"))) {
      ++rules_evaluated;
      // base::StringToDouble, not std::stod: Chromium builds with exceptions
      // disabled, so a try/catch here does not even compile.
      double n = 0;
      const bool ok = base::StringToDouble(*dm, &n);
      if (!ok || n <= 0) {
        fail("device-memory-plausible", kWarning,
             "device_memory must be positive, got " + *dm,
             "device_memory is a plausible value");
      } else {
        // Real devices expose powers of two (rounded down), so 3 or 7 is a tell.
        const long long i = static_cast<long long>(n);
        if (i > 0 && (i & (i - 1)) != 0) {
          fail("device-memory-plausible", kWarning,
               "device_memory " + *dm +
                   " is not a power of two (real devices report 1/2/4/8)",
               "device_memory is a plausible value");
        }
      }
    } else {
      skip("device-memory-plausible", "device_memory not set");
    }
  }

  // --- rule 7: screen-dimensions-plausible (warn) --------------------------
  {
    auto w = cfg_str("screen_width");
    auto h = cfg_str("screen_height");
    if (is_set("screen_width", config.Find("screen_width")) &&
        is_set("screen_height", config.Find("screen_height"))) {
      ++rules_evaluated;
      double dw = 0, dh = 0;
      if (!base::StringToDouble(*w, &dw) || !base::StringToDouble(*h, &dh)) {
        dw = dh = 0;  // non-numeric; reported as non-positive below
      }
      if (dw <= 0 || dh <= 0) {
        fail("screen-dimensions-plausible", kWarning,
             "screen dimensions must be positive, got " + *w + "x" + *h,
             "screen dimensions are internally consistent");
      } else {
        // avail is the viewport minus OS chrome, so it can never exceed screen.
        auto aw = cfg_str("screen_avail_width");
        auto ah = cfg_str("screen_avail_height");
        double daw = 0, dah = 0;
        const bool aw_ok =
            aw && !aw->empty() && base::StringToDouble(*aw, &daw);
        const bool ah_ok =
            ah && !ah->empty() && base::StringToDouble(*ah, &dah);
        if (aw_ok && daw > dw) {
          fail("screen-dimensions-plausible", kWarning,
               "screen_avail_width (" + *aw + ") exceeds screen_width (" + *w +
                   ")",
               "screen dimensions are internally consistent");
        }
        if (ah_ok && dah > dh) {
          fail("screen-dimensions-plausible", kWarning,
               "screen_avail_height (" + *ah + ") exceeds screen_height (" +
                   *h + ")",
               "screen dimensions are internally consistent");
        }
      }
    } else {
      skip("screen-dimensions-plausible",
           "needs screen_width and screen_height");
    }
  }

  // --- rule 8: webrtc-ip-requires-network-group (warn) ---------------------
  {
    auto ip = cfg_str("webrtc_ip");
    if (ip && !ip->empty()) {
      ++rules_evaluated;
      // Other ACTIVE network keys besides webrtc_ip.
      int others = 0;
      for (const GroupDef& def : kGroups) {
        if (std::string_view(def.id) != "network") {
          continue;
        }
        for (const char* key : def.keys) {
          if (!key || std::string_view(key) == "webrtc_ip") {
            continue;
          }
          if (is_set(std::string(key), config.Find(std::string_view(key)))) {
            ++others;
          }
        }
      }
      if (others == 0) {
        fail("webrtc-ip-requires-network-group", kWarning,
             "webrtc_ip set alone; real clients vary more than one network "
             "surface",
             "webrtc_ip is set only alongside other network keys (not in "
             "isolation)");
      }
    } else {
      skip("webrtc-ip-requires-network-group", "webrtc_ip not set");
    }
  }

  base::DictValue consistency;
  int errors = 0;
  int warns = 0;
  for (const auto& f : findings) {
    if (const std::string* s = f.GetDict().FindString("severity")) {
      if (*s == kError) {
        ++errors;
      } else if (*s == kWarning) {
        ++warns;
      }
    }
  }
  consistency.Set("findings", std::move(findings));
  // Size is captured BEFORE the move: reading skipped.size() after
  // std::move(skipped) reads a moved-from list, which is empty. That silently
  // reported skipCount:0 next to a populated skipped[] - and since the page
  // thresholds on skipCount to decide whether a "consistent" verdict is
  // meaningful, the undercount made an untested profile look verified.
  const int skip_count = static_cast<int>(skipped.size());
  consistency.Set("skipped", std::move(skipped));
  consistency.Set("errorCount", errors);
  // No longer hardcoded: the four warn rules above are real, so this counts
  // them. It was pinned to 0 before, which made every profile look warning-free.
  consistency.Set("warnCount", warns);
  consistency.Set("skipCount", skip_count);
  // Reported so the page can state coverage honestly instead of implying that
  // a clean panel means every rule ran.
  consistency.Set("ruleCount", kRuleCount);
  consistency.Set("rulesEvaluated", rules_evaluated);

  out.Set("consistency", std::move(consistency));

  out.Set("hasConfig", !config.empty());
  // How many per-tab (webPreferences) configs contributed. Exposed rather than
  // folded into hasConfig so a "0 tabs, 0 keys" report is distinguishable from
  // a "3 tabs, nothing set" one - the first means the Inspector has nothing to
  // look at, the second means the tabs genuinely run native.
  out.Set("webContentsConfigs", wc_configs);

  return base::WriteJson(out).value_or("{\"error\":\"json write failed\"}");
}

// Serves the Inspector's static assets.
//
// A custom URLDataSource rather than WebUIDataSource + AddResourcePath(): the
// latter takes grit resource ids, and adding a .grd plus build rules for two
// small assets is a lot of machinery for a diagnostic page. This keeps the page
// in the same file as the C++ that feeds it, so the two cannot silently drift.
//
// Same shape as devtools_ui_bundle_data_source.cc, which is the only other
// WebUI in this tree that serves bytes without grit.
class FingerprintDataSource : public content::URLDataSource {
 public:
  explicit FingerprintDataSource(content::BrowserContext* context)
      : context_(context) {}
  ~FingerprintDataSource() override = default;

  FingerprintDataSource(const FingerprintDataSource&) = delete;
  FingerprintDataSource& operator=(const FingerprintDataSource&) = delete;

  std::string GetSource() override { return std::string(kFingerprintHost); }

  void StartDataRequest(const GURL& url,
                        const content::WebContents::Getter& wc_getter,
                        GotDataCallback callback) override {
    const std::string path = content::URLDataSource::URLToRequestPath(url);

    // IMPORTANT: URLToRequestPath() strips the leading slash, so these are
    // compared WITHOUT one. Matching on "/app.js" instead silently 404s every
    // asset while the index still loads - the page renders and then reports
    // "Failed to load inspector data", which reads like a data bug rather than
    // a path bug.
    if (path == kAppJs) {
      std::move(callback).Run(Bytes(kFingerprintUiAppJs));
      return;
    }
    if (path == kInspectorDataPath) {
      // Kept for direct inspection, but the page no longer depends on it - see
      // the index branch below.
      std::move(callback).Run(Bytes(BuildInspectorDataFor(context_)));
      return;
    }
    // Bare host and "/" both mean the index.
    if (path.empty() || path == "/") {
      std::move(callback).Run(Bytes(BuildIndexPage()));
      return;
    }
    // A null response makes URLDataSource answer 404. There is no
    // CreateNotFoundResponse() helper on this class in this tree - only
    // WebUIDataSource has one, and we are not using that.
    std::move(callback).Run(nullptr);
  }

  std::string GetMimeType(const GURL& url) override {
    const std::string path = content::URLDataSource::URLToRequestPath(url);
    if (base::EndsWith(path, ".js")) {
      return "application/javascript";
    }
    return "text/html";
  }

  bool ShouldAddContentSecurityPolicy() override { return false; }
  bool ShouldDenyXFrameOptions() override { return false; }
  bool ShouldServeMimeTypeAsContentTypeHeader() override { return true; }

  // REQUIRED. URLDataSource::ShouldServiceRequest() defaults to allowing only
  // chrome: and devtools:, so on a new scheme every request is rejected in
  // web_ui_url_loader_factory.cc with ERR_INVALID_URL (-300) and
  // StartDataRequest() is never called. The failure looks like the data source
  // was never registered, which sends you hunting in the wrong place - the
  // factory DID find the source, it just refused to serve it.
  bool ShouldServiceRequest(const GURL& url,
                            content::BrowserContext* browser_context,
                            int render_process_id) override {
    return url.SchemeIs(electron::kElectronUIScheme);
  }

  // Assemble the page: markup + inlined script + inlined data.
  //
  // Everything is inlined deliberately. Neither <script src="app.js"> nor
  // fetch('inspector-data.json') nor the chrome.send/addWebUiListener round
  // trip works in this build - all three fail for chrome:// WebUIs too, so
  // this is a property of the build, not of the new electron:// scheme. The
  // main document load does work, so the page is served self-contained.
  std::string BuildIndexPage() {
    const std::string payload =
        "window.__fp = " + BuildInspectorDataFor(context_) + ";";

    std::string page(kFingerprintUiHtml);
    const size_t pos = page.find(kFingerprintUiDataMarker);
    if (pos == std::string::npos) {
      // The marker is gone: the page and this function have drifted apart.
      // Fail loudly rather than serve a page with a permanently empty panel.
      return "<html><body><p>Inspector page template is missing the " +
             std::string(kFingerprintUiDataMarker) + " marker.</p></body></html>";
    }
    page.replace(pos, kFingerprintUiDataMarker.size(),
                 payload + "\n" + std::string(kFingerprintUiAppJs));
    return page;
  }

 private:
  // Which profile the numbers describe. The Inspector is per-BrowserContext
  // because so is the fingerprint config; showing the default context's config
  // while inspecting another partition would be actively wrong.
  raw_ptr<content::BrowserContext> context_;
};

}  // namespace

FingerprintUI::FingerprintUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  auto* const browser_context = web_ui->GetWebContents()->GetBrowserContext();

  // The page gets its data over WebUI IPC, not fetch().
  //
  // fetch() for WebUI subresources is broken in this build for chrome:// too
  // (verified: fetching chrome://resources/js/cr.js from chrome://accessibility
  // fails with "Failed to fetch"), so serving inspector-data.json as a
  // subresource cannot work. This message-handler path is what the other WebUI
  // in this tree (accessibility_ui) uses.
  // kWebUi is what injects chrome.send / addWebUiListener into the page.
  // Without it the page loads but the IPC helpers are simply undefined, so
  // load() throws "addWebUiListener is not defined" and the banner shows a
  // generic failure that says nothing about the real cause.
  web_ui->SetBindings({content::BindingsPolicyValue::kWebUi});

  web_ui->AddMessageHandler(
      std::make_unique<FingerprintUIMessageHandler>(browser_context));

  // URLDataSource::Add() takes ownership and ties the source's lifetime to the
  // BrowserContext, which outlives this controller. Deliberately NOT also
  // holding it in a member: that would be a double free.
  content::URLDataSource::Add(
      browser_context, std::make_unique<FingerprintDataSource>(browser_context));
}

FingerprintUI::~FingerprintUI() = default;

void FingerprintUIMessageHandler::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "requestInspectorData",
      base::BindRepeating(&FingerprintUIMessageHandler::HandleRequestInspectorData,
                          base::Unretained(this)));
}

void FingerprintUIMessageHandler::HandleRequestInspectorData(
    const base::ListValue& args) {
  AllowJavascript();
  // BuildInspectorDataFor() already returns serialized JSON; hand it straight
  // to the page rather than round-tripping through a re-parse, which would
  // only add a failure mode that reports "no data" for a parse problem.
  std::optional<base::Value> parsed =
      base::JSONReader::Read(BuildInspectorDataFor(context_), 0);
  if (!parsed) {
    return;
  }
  FireWebUIListener("inspector-data", *parsed);
}

}  // namespace electron
