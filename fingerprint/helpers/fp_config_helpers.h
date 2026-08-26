// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// fp: fingerprint configuration helpers for Blink.
// Reads values with priority:
// 1) --fingerprint-config switch (base64-encoded JSON, Electron per-renderer)
// 2) FP_CONFIG_DATA env var (JSON content, sandbox-safe)
// 3) FP_CONFIG JSON file
// 4) FP_<KEY> env vars (per-key fallback in FpConfigInt/String).

#ifndef THIRD_PARTY_BLINK_RENDERER_CORE_FRAME_FP_CONFIG_HELPERS_H_
#define THIRD_PARTY_BLINK_RENDERER_CORE_FRAME_FP_CONFIG_HELPERS_H_

#include <cstdio>
#include <cstdlib>
#include <string>
#include "base/base64.h"
#include "base/command_line.h"
#include "ui/gfx/geometry/rect_f.h"
#include "third_party/blink/renderer/platform/graphics/static_bitmap_image.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkImageInfo.h"
#include "third_party/skia/include/core/SkData.h"

namespace blink {

inline std::string FpTrim(std::string s) {
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' ||
                        s.back() == '\r' || s.back() == '\n')) {
    s.pop_back();
  }
  return s;
}

// Returns the FP_CONFIG JSON content with priority:
// 1) --fingerprint-config switch (base64-encoded JSON, Electron per-renderer)
// 2) FP_CONFIG_DATA env (JSON content, sandbox-safe)
// 3) FP_CONFIG file (path via env)
// 4) FP_* env fallbacks are handled per-key in FpConfigInt/String/Int64.
inline std::string FpConfigContent() {
  // 1. Command-line switch (Electron per-Renderer) -- highest priority.
  if (auto* cmd = base::CommandLine::ForCurrentProcess()) {
    std::string b64 = cmd->GetSwitchValueASCII("fingerprint-config");
    if (!b64.empty()) {
      std::string json;
      if (base::Base64Decode(b64, &json)) {
        return json;
      }
    }
  }
  // 2. FP_CONFIG_DATA env (JSON content).
  const char* data = getenv("FP_CONFIG_DATA");
  if (data && *data) {
    return std::string(data);
  }
  // 3. FP_CONFIG file.
  const char* path = getenv("FP_CONFIG");
  if (!path) {
    return "";
  }
  std::string path_str = FpTrim(path);
  FILE* f = fopen(path_str.c_str(), "rb");
  if (!f) {
    return "";
  }
  std::string content;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
    content.append(buf, n);
  }
  fclose(f);
  return content;
}

// Find `"key"` in JSON content; returns position after the colon, or npos.
inline size_t FpConfigFindKey(const std::string& content, const char* key) {
  std::string needle = "\"";
  needle += key;
  needle += "\"";
  size_t pos = content.find(needle);
  if (pos == std::string::npos) {
    return std::string::npos;
  }
  size_t colon = content.find(':', pos);
  if (colon == std::string::npos) {
    return std::string::npos;
  }
  size_t i = colon + 1;
  while (i < content.size() && (content[i] == ' ' || content[i] == '\t' ||
                                content[i] == '\r' || content[i] == '\n')) {
    i++;
  }
  return i;
}

// Read a string value for |key| from the FP_CONFIG JSON content.
inline std::string FpConfigString(const char* key) {
  std::string content = FpConfigContent();
  if (content.empty()) {
    return "";
  }
  size_t i = FpConfigFindKey(content, key);
  if (i == std::string::npos || i >= content.size() || content[i] != '"') {
    return "";
  }
  size_t q2 = content.find('"', i + 1);
  if (q2 == std::string::npos) {
    return "";
  }
  return content.substr(i + 1, q2 - i - 1);
}

// Read an int value for |key|: FP_CONFIG JSON ("key": N) or FP_<KEY> env var.
inline int FpConfigInt(const char* key, int fallback) {
  std::string content = FpConfigContent();
  if (!content.empty()) {
    size_t i = FpConfigFindKey(content, key);
    if (i != std::string::npos && i < content.size()) {
      bool neg = false;
      if (content[i] == '-') {
        neg = true;
        i++;
      }
      long v = 0;
      bool any = false;
      while (i < content.size() && content[i] >= '0' && content[i] <= '9') {
        v = v * 10 + (content[i] - '0');
        i++;
        any = true;
      }
      if (any) {
        return static_cast<int>(neg ? -v : v);
      }
    }
  }
  std::string env_name = "FP_";
  env_name += key;
  const char* e = getenv(env_name.c_str());
  if (e && *e) {
    char* end = nullptr;
    long v = strtol(e, &end, 10);
    if (end != e) {
      return static_cast<int>(v);
    }
  }
  return fallback;
}

// Same as FpConfigInt but returns int64 (for large byte counts).
inline int64_t FpConfigInt64(const char* key, int64_t fallback) {
  std::string content = FpConfigContent();
  if (!content.empty()) {
    size_t i = FpConfigFindKey(content, key);
    if (i != std::string::npos && i < content.size()) {
      bool neg = false;
      if (content[i] == '-') {
        neg = true;
        i++;
      }
      long long v = 0;
      bool any = false;
      while (i < content.size() && content[i] >= '0' && content[i] <= '9') {
        v = v * 10 + (content[i] - '0');
        i++;
        any = true;
      }
      if (any) {
        return neg ? -v : v;
      }
    }
  }
  std::string env_name = "FP_";
  env_name += key;
  const char* e = getenv(env_name.c_str());
  if (e && *e) {
    char* end = nullptr;
    long long v = strtoll(e, &end, 10);
    if (end != e) {
      return v;
    }
  }
  return fallback;
}



// Deterministic per-pixel noise for canvas data (export + getImageData).
// SplitMix64 per-pixel hash from (seed, pixel index). Camoufox-style
// minimal noise: fully transparent pixels untouched (clearRect semantics),
// only the first non-zero RGB channel perturbed.
inline void FpApplyPixelNoise(uint8_t* px, size_t total, uint64_t state,
                              int strength) {
  for (size_t i = 0; i + 4 <= total; i += 4) {
    if (px[i + 3] == 0) {  // fully transparent: leave untouched
      continue;
    }
    size_t c = 0;
    while (c < 3 && px[i + c] == 0) {
      ++c;
    }
    if (c == 3) {  // opaque black pixel: leave untouched
      continue;
    }
    uint64_t h = state ^
                 (static_cast<uint64_t>(i >> 2) * 0x9E3779B97F4A7C15ULL);
    h ^= h >> 30;
    h *= 0xBF58476D1CE4E5B9ULL;
    h ^= h >> 27;
    h *= 0x94D049BB133111EBULL;
    h ^= h >> 31;
    int delta = static_cast<int>(h & 0xFF) % (2 * strength + 1) - strength;
    int v = px[i + c] + delta;
    px[i + c] = static_cast<uint8_t>(v < 0 ? 0 : (v > 255 ? 255 : v));
  }
}

// Deterministic pixel noise for canvas export paths (toDataURL/toBlob).
// Enabled when FP_CONFIG "canvas_noise_seed" > 0; strength via
// "canvas_noise_strength" (default 2, clamp 1..8). Same seed + same drawn
// content -> identical export bytes across sessions (stable fingerprint
// change), while the bytes differ from the unnoised original.
inline void FpApplyCanvasExportNoise(
    scoped_refptr<blink::StaticBitmapImage>& image) {
  int64_t fp_seed = static_cast<int64_t>(FpConfigInt("canvas_noise_seed", 0));
  if (fp_seed == 0 || !image) {
    return;
  }
  int strength = FpConfigInt("canvas_noise_strength", 2);
  if (strength < 1) {
    strength = 1;
  }
  if (strength > 8) {
    strength = 8;
  }
  SkImageInfo info = image->PaintImageForCurrentFrame().GetSkImageInfo();
  if (info.bytesPerPixel() != 4) {
    return;
  }
  SkBitmap bitmap;
  if (!bitmap.tryAllocPixels(info)) {
    return;
  }
  if (!image->PaintImageForCurrentFrame().readPixels(
          bitmap.info(), bitmap.getPixels(), bitmap.rowBytes(), 0, 0)) {
    return;
  }
  uint8_t* px = static_cast<uint8_t*>(bitmap.getPixels());
  const size_t total = bitmap.computeByteSize();
  const uint64_t state = static_cast<uint64_t>(fp_seed);
  FpApplyPixelNoise(px, total, state, strength);
  sk_sp<SkData> data = SkData::MakeWithCopy(px, total);
  image = blink::StaticBitmapImage::Create(data, info, gfx::HDRMetadata());
}


// Returns true if |family| must be hidden from the page: either it is
// listed in FP_CONFIG "fonts_blocklist" (comma-separated, case-insensitive),
// or "fonts_whitelist" is set and the family is NOT in it. Generic families
// (sans-serif/serif/monospace/cursive/fantasy/system-ui) are always exempt
// so fallback never deadlocks. Web fonts (@font-face) bypass FontCache, so
// they are unaffected. Whitelist wins over blocklist when both are set.
inline bool FpFontFamilyHidden(const std::string& family) {
  std::string whitelist = FpConfigString("fonts_whitelist");
  std::string blocklist = FpConfigString("fonts_blocklist");
  if (whitelist.empty() && blocklist.empty()) {
    return false;
  }
  // generic families always pass
  {
    std::string lower;
    for (char ch : family) {
      lower += (ch >= 'A' && ch <= 'Z') ? static_cast<char>(ch - 'A' + 'a') : ch;
    }
    if (lower == "sans-serif" || lower == "serif" || lower == "monospace" ||
        lower == "cursive" || lower == "fantasy" || lower == "system-ui") {
      return false;
    }
  }
  // case-insensitive substring-set membership helper
  auto in_list = [](const std::string& list, const std::string& name) -> bool {
    size_t start = 0;
    while (start <= list.size()) {
      size_t comma = list.find(',', start);
      size_t end = (comma == std::string::npos) ? list.size() : comma;
      if (end > start) {
        std::string entry = list.substr(start, end - start);
        size_t b = 0, e2 = entry.size();
        while (b < e2 && (entry[b] == ' ' || entry[b] == '\t')) b++;
        while (e2 > b && (entry[e2 - 1] == ' ' || entry[e2 - 1] == '\t')) e2--;
        if (e2 - b > 0) {
          std::string name_l;
          for (char ch : name) {
            name_l += (ch >= 'A' && ch <= 'Z') ? static_cast<char>(ch - 'A' + 'a') : ch;
          }
          std::string entry_l;
          for (size_t k = b; k < e2; ++k) {
            char ch = entry[k];
            entry_l += (ch >= 'A' && ch <= 'Z') ? static_cast<char>(ch - 'A' + 'a') : ch;
          }
          if (name_l == entry_l) {
            return true;
          }
        }
      }
      if (comma == std::string::npos) {
        break;
      }
      start = comma + 1;
    }
    return false;
  };
  if (!whitelist.empty()) {
    return !in_list(whitelist, family);
  }
  return in_list(blocklist, family);
}



// Deterministic noise for audio sample data (audio fingerprint path).
// Enabled when FP_CONFIG "audio_data_seed" > 0; amplitude via
// "audio_data_strength" (float, default 0.0005). Same seed + same content
// -> identical altered output across sessions. Used on offline render
// output and AnalyserNode float reads (does not affect playback paths).
inline void FpApplyAudioDataNoise(float* data, size_t count) {
  int64_t fp_seed = FpConfigInt64("audio_data_seed", 0);
  if (fp_seed == 0 || !data || count == 0) {
    return;
  }
  float strength = 0.0005f;
  std::string fp_strength = FpConfigString("audio_data_strength");
  if (!fp_strength.empty()) {
    char* end = nullptr;
    float v = std::strtof(fp_strength.c_str(), &end);
    if (end != fp_strength.c_str() && v >= 0.0f && v <= 1.0f) {
      strength = v;
    }
  }
  const uint64_t state = static_cast<uint64_t>(fp_seed);
  for (size_t i = 0; i < count; ++i) {
    uint64_t h = state ^
                 (static_cast<uint64_t>(i) * 0x9E3779B97F4A7C15ULL);
    h ^= h >> 30;
    h *= 0xBF58476D1CE4E5B9ULL;
    h ^= h >> 27;
    h *= 0x94D049BB133111EBULL;
    h ^= h >> 31;
    float delta = (static_cast<float>(h & 0xFF) / 127.5f - 1.0f) * strength;
    data[i] += delta;
  }
}


// Deterministic subpixel perturbation for element rect APIs
// (getClientRects/getBoundingClientRect) - rasterizer fingerprint
// defense. Enabled by FP_CONFIG "client_rects_seed" > 0. Offset derives
// from (seed, rect origin) so the same element keeps the same value
// across sessions; magnitude < 0.2px so layout logic is unaffected.
inline void FpPerturbRectF(gfx::RectF& r) {
  int64_t fp_seed = FpConfigInt64("client_rects_seed", 0);
  if (fp_seed == 0 || r.IsEmpty()) {
    return;
  }
  uint64_t h = static_cast<uint64_t>(fp_seed) ^
               (static_cast<uint64_t>(static_cast<int>(r.x() * 16.0f)) *
                0x9E3779B97F4A7C15ULL);
  h ^= (static_cast<uint64_t>(static_cast<int>(r.y() * 16.0f)) *
        0xBF58476D1CE4E5B9ULL);
  h ^= h >> 30;
  h *= 0xBF58476D1CE4E5B9ULL;
  h ^= h >> 27;
  h *= 0x94D049BB133111EBULL;
  h ^= h >> 31;
  double dx = (static_cast<double>(h & 0xFF) / 255.0 - 0.5) * 0.4;
  double dy = (static_cast<double>((h >> 8) & 0xFF) / 255.0 - 0.5) * 0.4;
  r.Offset(static_cast<float>(dx), static_cast<float>(dy));
}

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_CORE_FRAME_FP_CONFIG_HELPERS_H_
