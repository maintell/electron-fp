// Copyright 2026 The Electron Authors. All rights reserved.
// Use of this source code is governed by the BSD-style license that can be
// found in the LICENSE file.

#ifndef ELECTRON_FINGERPRINT_HELPERS_FP_UA_HELPERS_H_
#define ELECTRON_FINGERPRINT_HELPERS_FP_UA_HELPERS_H_

// --- Sec-CH-UA client hint derivation ----------------------------------------
//
// navigator.userAgentData and the Sec-CH-UA* request headers are a SECOND
// identity surface, and Chromium does NOT derive them from navigator.userAgent:
// it keeps its own brand list. Measured with a Mac UA override - the hints
// still reported brand "Chromium";v="154" and platform "Windows", i.e. the real
// browser on the real OS. That contradiction is trivially detectable and worse
// than not spoofing at all, so the hints must follow the UA.
//
// The ua_platform / ua_brands / ua_mobile keys override this derivation when
// set; when empty, these functions infer values from the UA string in effect.
// Keeping the inference here means a config that sets only a UA stays coherent.
//
// THIS HEADER IS DELIBERATELY DEPENDENCY-FREE (no blink, no skia, no
// base/containers). It is included from content/renderer, and pulling in
// blink's platform headers there triggers cppgc/Oilpan template constraint
// errors in RenderFrameImpl ("invalid application of 'sizeof' to an incomplete
// type 'void'"). fp_config_helpers.h cannot be included from content because it
// needs SkBitmap/StaticBitmapImage for the canvas noise helpers. Keep the split:
// string-only helpers here, bitmap helpers there.

#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"

namespace fp_ua {

// --- Minimal config reader ---------------------------------------------------
// Duplicates the string-reading half of FpConfigString() from
// fp_config_helpers.h, because that header cannot be included here (see the
// note at the top of this file) and content/renderer otherwise has no way to
// read the fingerprint config. Same priority order:
// --fingerprint-config (base64 JSON) > FP_CONFIG_DATA > FP_CONFIG file >
// FP_<KEY> env. Keep in sync if the priority order ever changes.
inline std::string ConfigString(const char* key) {
  // 1) --fingerprint-config=<base64 json> (per-renderer, used by Electron)
  const char* b64 = getenv("FP_CONFIG_DATA");
  std::string content;
  if (b64 && *b64) {
    content = b64;
  } else {
    const char* path = getenv("FP_CONFIG");
    if (path && *path) {
      // base::ReadFileToString rather than fread: raw buffer reads trip
      // -Wunsafe-buffer-usage-in-libc-call, which is -Werror in this build.
      base::ReadFileToString(base::FilePath::FromUTF8Unsafe(path), &content);
    }
  }
  if (content.empty()) {
    // 4) FP_<KEY> env fallback
    std::string env = std::string("FP_") + key;
    // Upper-case the key for the env var name.
    for (auto& ch : env) if (ch >= 'a' && ch <= 'z') ch -= 32;
    const char* v = getenv(env.c_str());
    return v ? std::string(v) : std::string();
  }
  // Find "key":"value" in the JSON. Quote-aware enough for flat config JSON.
  std::string pat = std::string("\"") + key + "\"";
  size_t k = content.find(pat);
  if (k == std::string::npos) return "";
  k = content.find(':', k + pat.size());
  if (k == std::string::npos) return "";
  k++;
  while (k < content.size() && (content[k] == ' ' || content[k] == '\n' ||
                                content[k] == '\r' || content[k] == '\t')) k++;
  if (k >= content.size() || content[k] != '"') return "";
  size_t q2 = content.find('"', k + 1);
  if (q2 == std::string::npos) return "";
  return content.substr(k + 1, q2 - k - 1);
}

inline bool IsMobile(const std::string& ua) {
  return ua.find("Android") != std::string::npos ||
         ua.find("iPhone") != std::string::npos ||
         ua.find("iPad") != std::string::npos ||
         ua.find("Mobile") != std::string::npos;
}

// Sec-CH-UA-Platform vocabulary - note this is NOT navigator.platform:
// "macOS" here vs "MacIntel" there. Same leak, different spelling, both sent.
inline std::string Platform(const std::string& ua) {
  if (ua.find("Android") != std::string::npos) return "Android";
  if (ua.find("iPhone") != std::string::npos) return "iOS";
  if (ua.find("iPad") != std::string::npos) return "iOS";
  if (ua.find("Macintosh") != std::string::npos ||
      ua.find("Mac OS X") != std::string::npos) return "macOS";
  if (ua.find("Windows") != std::string::npos) return "Windows";
  if (ua.find("X11") != std::string::npos ||
      ua.find("Linux") != std::string::npos) return "Linux";
  return "";
}

// Major version pulled from the UA, used for the brand list. Falls back to a
// fixed version so the brand list is never empty-looking.
inline std::string MajorVersion(const std::string& ua) {
  static const char* kTokens[] = {"Chrome/", "Chromium/", "CriOS/", "Edg/",
                                  "Firefox/", "Version/"};
  for (const char* tok : kTokens) {
    size_t i = ua.find(tok);
    if (i == std::string::npos) continue;
    size_t s = i + strlen(tok);
    size_t e = s;
    while (e < ua.size() && ua[e] >= '0' && ua[e] <= '9') e++;
    if (e > s) return ua.substr(s, e - s);
  }
  return "131";
}

// Sec-CH-UA brand list in structured-header wire form. Keeps "Chromium" because
// that IS the engine this build ships; only the version and ordering follow the
// impersonated browser. GREASE (RFC 8701) is emitted for Chromium-family UAs
// because real Chromium does, and its absence is itself a signal.
inline std::string Brands(const std::string& ua) {
  const std::string major = MajorVersion(ua);
  const std::string grease = "\"Not A(Brand\";v=\"99\"";
  const std::string chromium = "\"Chromium\";v=\"" + major + "\"";

  bool is_firefox = ua.find("Firefox/") != std::string::npos &&
                    ua.find("Chrome/") == std::string::npos &&
                    ua.find("Chromium/") == std::string::npos;

  if (is_firefox) {
    return grease + ", \"Firefox\";v=\"" + major + "\"";
  }
  if (ua.find("Edg/") != std::string::npos) {
    return grease + ", " + chromium + ", \"Microsoft Edge\";v=\"" + major + "\"";
  }
  if (ua.find("CriOS/") != std::string::npos ||
      ua.find("Chrome/") != std::string::npos) {
    return grease + ", " + chromium + ", \"Google Chrome\";v=\"" + major + "\"";
  }
  if (ua.find("Safari/") != std::string::npos) {
    // Real Safari sends only its own brand and does not GREASE.
    return "\"Safari\";v=\"" + major + "\"";
  }
  return grease + ", " + chromium;
}

// Parse a Sec-CH-UA brand list into (brand, version) pairs.
//
// Accepts BOTH the structured-header wire form and a quote-free form:
//   "Not A(Brand";v="99", "Chromium";v="131"     <- what browsers send
//   Not A(Brand)=99, Chromium=131                <- what config can carry
//
// The quote-free form matters because FpConfigString() stops at the first
// closing quote, so a value containing quotes is silently truncated to nothing
// (the same trap that forced webgpu_limits to use unquoted keys). Accepting
// both means a hand-written config works, and values copied verbatim off the
// wire still parse.
//
// Splitting is hand-rolled rather than using UserAgentMetadata::Demarshal()
// because that parses a whole encoded UserAgentMetadata blob and would silently
// discard the platform/mobile fields set alongside it. Plain pairs (not blink
// structs) so this header stays dependency-free and usable from content/.
inline std::vector<std::pair<std::string, std::string>> ParseBrands(
    const std::string& wire) {
  std::vector<std::pair<std::string, std::string>> out;
  // Quote-aware scan: GREASE brand names contain parentheses, so splitting on
  // plain punctuation would corrupt "Not A(Brand".
  auto trim = [](std::string s) {
    while (!s.empty() && (s.front() == ' ' || s.front() == '"')) s.erase(0, 1);
    while (!s.empty() && (s.back() == ' ' || s.back() == '"')) s.pop_back();
    return s;
  };

  // Split the list on top-level commas (outside quotes), then each entry on its
  // separator: ';' in the wire form ("Brand";v="99") or '=' in the config form
  // (Brand=99). Requiring ';' alone made the quote-free form parse to nothing.
  std::vector<std::string> entries;
  {
    std::string cur;
    bool in_q = false;
    for (char ch : wire) {
      if (ch == '"') { in_q = !in_q; cur += ch; }
      else if (ch == ',' && !in_q) { entries.push_back(cur); cur.clear(); }
      else cur += ch;
    }
    if (!trim(cur).empty() || !entries.empty()) entries.push_back(cur);
  }

  for (const std::string& entry : entries) {
    std::string e = trim(entry);
    if (e.empty()) continue;

    std::string brand;
    std::string ver;
    // Wire form: "Brand";v="99"  - the brand is a quoted string.
    // Config form: Brand=99      - no quotes (FpConfigString truncates them).
    // Detect on the RAW entry, before trimming strips the leading quote.
    size_t first_q = entry.find('"');
    if (first_q != std::string::npos) {
      size_t close_q = entry.find('"', first_q + 1);
      if (close_q != std::string::npos) {
        brand = entry.substr(first_q + 1, close_q - first_q - 1);
        // Version follows ';' as v="99".
        size_t semi = entry.find(';', close_q);
        if (semi != std::string::npos) {
          ver = trim(entry.substr(semi + 1));
          if (ver.size() > 2 && ver[0] == 'v' && ver[1] == '=') {
            ver = trim(ver.substr(2));
          }
        }
        out.push_back({brand, ver});
        continue;
      }
    }
    // Unquoted: split on '=' (or ';' as a fallback).
    size_t eq = e.find('=');
    size_t sep = (eq != std::string::npos) ? eq : e.find(';');
    if (sep == std::string::npos) { out.push_back({e, ""}); continue; }
    brand = trim(e.substr(0, sep));
    ver = trim(e.substr(sep + 1));
    if (!brand.empty()) out.push_back({brand, ver});
  }
  return out;
}

}  // namespace fp_ua

#endif  // ELECTRON_FINGERPRINT_HELPERS_FP_UA_HELPERS_H_
