// Copyright (c) 2026 Microsoft, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE.

#include "shell/browser/ui/webui/fingerprint_ui.h"

#include <array>
#include <memory>
#include <string>
#include <string_view>
#include <utility>

#include <vector>

#include "base/base64.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/memory/ref_counted_memory.h"
#include "base/values.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/url_data_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"

#include "shell/browser/electron_browser_context.h"
#include "shell/browser/session_preferences.h"
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

  const std::string b64 =
      electron::SessionPreferences::FromBrowserContext(context)
          ? electron::SessionPreferences::FromBrowserContext(context)
                ->GetFingerprintConfigBase64()
          : std::string();

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

  // A key counts as "set" when it carries a non-default value. 0 / "" are the
  // schema's disabled sentinels, NOT real values - treating them as set would
  // report every key as configured.
  auto is_set = [](const base::Value* v) {
    if (!v) return false;
    if (v->is_string()) return !v->GetString().empty();
    if (v->is_int()) return v->GetInt() != 0;
    if (v->is_double()) return v->GetDouble() != 0.0;
    if (v->is_bool()) return v->GetBool();
    return false;
  };

  base::ListValue coverage;
  int total_active = 0;
  int total_keys = 0;
  base::ListValue empty_groups;

  for (const GroupDef& def : kGroups) {
    int active = 0;
    int total = 0;
    for (const char* key : def.keys) {
      if (!key) {
        continue;  // unused tail slots in the fixed-size array
      }
      ++total;
      if (is_set(config.Find(std::string_view(key)))) {
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

  // Cross-layer consistency.
  //
  // The full rule set lives in Client/browser-profile.js and is applied by the
  // app. Here we report the two contradictions that are checkable from C++
  // alone, and - importantly - say so, rather than showing an empty "no issues"
  // panel that would read as "verified clean" when nothing was actually run.
  const std::string* platform = config.FindString("navigator_platform");
  const std::string* ch_platform = config.FindString("ua_platform");

  base::ListValue findings;
  base::ListValue skipped;

  if (!platform || platform->empty()) {
    skipped.Append("navigator_platform not set");
  }
  if (!ch_platform || ch_platform->empty()) {
    skipped.Append("ua_platform not set");
  }
  if (platform && !platform->empty() && ch_platform && !ch_platform->empty()) {
    // Crude OS-family check: the UA-anchored rules in browser-profile.js are
    // authoritative; this only catches the grossest mismatch.
    //
    // Case-INSENSITIVE, and it has to be: the two surfaces do not use
    // consistent casing. navigator_platform uses "Win32"/"MacIntel" while
    // ua_platform (Sec-CH-UA-Platform) uses "macOS"/"Windows". A case-sensitive
    // match misses "macOS" entirely and reports a contradictory profile as
    // clean - the exact opposite of what this panel exists to catch.
    auto family = [](const std::string& raw) {
      const std::string v = base::ToLowerASCII(raw);
      if (v.find("win") != std::string::npos) return 1;
      if (v.find("mac") != std::string::npos) return 2;
      if (v.find("linux") != std::string::npos) return 3;
      if (v.find("android") != std::string::npos) return 4;
      if (v.find("iphone") != std::string::npos ||
          v.find("ios") != std::string::npos) {
        return 5;
      }
      return 0;
    };
    const int a = family(*platform);
    const int b = family(*ch_platform);
    if (a && b && a != b) {
      base::DictValue f;
      f.Set("id", "platform-family-mismatch");
      f.Set("severity", "error");
      f.Set("message", std::string("navigator_platform \"") + *platform +
                           "\" and ua_platform \"" + *ch_platform +
                           "\" imply different operating systems");
      f.Set("describe", "the two platform surfaces must agree");
      findings.Append(std::move(f));
    }
  }

  base::DictValue consistency;
  int errors = 0;
  for (const auto& f : findings) {
    if (*f.GetDict().FindString("severity") == "error") {
      ++errors;
    }
  }
  consistency.Set("findings", std::move(findings));
  consistency.Set("skipped", std::move(skipped));
  consistency.Set("errorCount", errors);
  consistency.Set("warnCount", 0);
  consistency.Set("skipCount", static_cast<int>(skipped.size()));

  out.Set("consistency", std::move(consistency));

  if (!config.empty()) {
    out.Set("hasConfig", true);
  } else {
    out.Set("hasConfig", false);
  }

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
