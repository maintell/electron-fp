#!/usr/bin/env python3
"""fingerprint patch static quality gate — mirrors ungoogled devutils/check_patch.py 8 checks.

Simplified for electron-fp isolation:
- paths rooted at fingerprint/ (not patches/series)
- isolation enforced: fingerprint patch stays outside patches/chromium/
- 56 keys completeness, debug residue, hunks, doc blocks, INTEGRATION sync
Exit 0 = pass, 1 = fail.
"""
import argparse
import io
import os
import re
import sys

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
PATCH = os.path.join(REPO, "fingerprint", "patches", "fp-fingerprint.patch")
HELPERS = os.path.join(REPO, "fingerprint", "helpers", "fp_config_helpers.h")
README = os.path.join(REPO, "fingerprint", "README.md")

EXPECTED_KEYS = [
    "hardware_concurrency", "device_memory", "max_touch_points",
    "screen_width", "screen_height", "screen_avail_width", "screen_avail_height",
    "screen_color_depth", "audio_sample_rate", "audio_max_channels",
    "audio_output_latency_ms", "webgl_max_texture_size",
    "webgl_max_renderbuffer_size", "webgl_max_viewport_dims",
    "webgl_aliased_point_size_range", "webgl_aliased_line_width_range",
    "webgl_vendor", "webgl_renderer", "webgl_extensions",
    "geo_latitude", "geo_longitude", "geo_accuracy",
    "speech_voices_count", "speech_voices_lang",
    "media_devices_audio_input", "media_devices_video_input", "media_devices_audio_output",
    "canvas_noise_seed", "canvas_noise_strength", "tz_id", "fonts_blocklist",
    "net_effective_type", "net_rtt_ms", "net_downlink_mbps",
    "permissions_status", "storage_usage_bytes", "storage_quota_bytes",
    "perf_now_precision_ms", "media_codecs_denylist", "prefers_color_scheme",
    "do_not_track", "webrtc_ip",
    "audio_data_seed", "audio_data_strength", "measure_text_seed",
    "fonts_whitelist", "webgl_shader_precision_highp",
    "battery_charging", "battery_level",
    "webgpu_vendor", "webgpu_architecture", "webgpu_device", "webgpu_description",
    "webgpu_features", "webgpu_limits",
    "client_rects_seed",
]

DEBUG_PATTERNS = [
    r'm6_sentinel', r'fp_dbg', r'sentinel',
    r'fopen\("F:', r'LOG\(ERROR\).*fp', r'printf\("fp',
]


def main():
    parser = argparse.ArgumentParser(description="Fingerprint patch checks")
    parser.add_argument("--helpers-only", action="store_true", help="only check helpers/56 keys existence (Task 2)")
    args = parser.parse_args()

    failures = []

    # 1. patch exists (and helpers/README for isolation)
    if not os.path.exists(PATCH):
        failures.append("patch file missing: fingerprint/patches/fp-fingerprint.patch")
    if not os.path.exists(HELPERS):
        failures.append("helpers missing: fingerprint/helpers/fp_config_helpers.h")
    if not os.path.exists(README):
        failures.append("README missing: fingerprint/README.md")

    # 2. isolation: patch must NOT be inside patches/chromium/ or referenced in patches/config.json
    for isolated in [
        os.path.join(REPO, "patches", "chromium", "fp-fingerprint.patch"),
        os.path.join(REPO, "patches", "chromium", "fingerprint.patch"),
    ]:
        if os.path.exists(isolated):
            failures.append(f"isolation violation: fingerprint patch found in main patch dir: {isolated}")
    cfg = os.path.join(REPO, "patches", "config.json")
    if os.path.exists(cfg):
        try:
            txt = io.open(cfg, encoding="utf-8", errors="replace").read()
            if "fp-fingerprint" in txt or "fingerprint" in txt.lower() and "fingerprint" in txt:
                # strict: only fail if fingerprint patch explicitly referenced
                if "fp-fingerprint.patch" in txt:
                    failures.append("isolation violation: fp-fingerprint.patch referenced in patches/config.json")
        except Exception:
            pass
    if os.path.exists(os.path.join(REPO, "patches", "series")):
        try:
            series = io.open(os.path.join(REPO, "patches", "series"), encoding="utf-8", errors="replace").read()
            if "fp-fingerprint.patch" in series:
                failures.append("isolation violation: fp-fingerprint.patch must not be in patches/series (use fingerprint/scripts/apply.py)")
        except Exception:
            pass

    if args.helpers_only:
        # helpers-only minimal gate: just keys completeness in helpers/patch if present
        if os.path.exists(PATCH):
            p = io.open(PATCH, encoding="utf-8", errors="replace").read()
            missing = [k for k in EXPECTED_KEYS if k not in p]
            if missing:
                failures.append(f"missing config keys in patch: {missing}")
        if os.path.exists(HELPERS):
            h = io.open(HELPERS, encoding="utf-8", errors="replace").read()
            # helpers should contain FpConfigContent and 56-key refs or at least switch priority
            if "fingerprint-config" not in h and "FP_CONFIG_DATA" not in h:
                failures.append("helpers missing fingerprint-config switch priority (Task 2)")
        if failures:
            print("PATCH CHECK FAILED (helpers-only):")
            for f in failures:
                print("  -", f)
            return 1
        print(f"PATCH CHECK PASSED (helpers-only): {len(EXPECTED_KEYS)} keys ok")
        return 0

    if os.path.exists(PATCH):
        p = io.open(PATCH, encoding="utf-8", errors="replace").read()

        # 3. header guide
        if "MERGE/UPGRADE GUIDE" not in p:
            failures.append("header MERGE/UPGRADE GUIDE missing")

        # 4. per-file doc blocks vs file segments
        segs = re.split(r"(?m)^--- a/", p)
        files = [s.split("\n")[0].strip() for s in segs[1:]]
        doc_count = len(re.findall(r"(?m)^# --- ", p))
        if len(files) != doc_count:
            failures.append(f"doc/segment mismatch: {doc_count} doc blocks vs {len(files)} file segments")

        # 5. no empty segments
        for seg in segs[1:]:
            has_plus = re.search(r"(?m)^\+", seg) is not None
            has_minus = re.search(r"(?m)^-", seg) is not None
            if not has_plus and not has_minus:
                first = seg.split("\n")[0].strip()
                failures.append(f"empty segment: {first[:60]}")
                break

        # 6. completeness: all 56 keys present
        missing = [k for k in EXPECTED_KEYS if k not in p]
        if missing:
            failures.append(f"missing config keys in patch: {missing}")

        # 7. debug residue
        for pat in DEBUG_PATTERNS:
            if re.search(pat, p):
                failures.append(f"debug residue pattern found: {pat}")

        # 8. hunks present and well-formed
        hunks = len(re.findall(r"(?m)^@@ ", p))
        if hunks == 0:
            failures.append("no hunks in patch")
        if p.count("\n--- a/") != p.count("\n+++ b/"):
            failures.append("mismatched --- a/ vs +++ b/ header counts")

        # 8b. INTEGRATION sync: every key must be documented if INTEGRATION.md exists
        integ_candidates = [
            os.path.join(REPO, "fingerprint", "INTEGRATION.md"),
            os.path.join(REPO, "INTEGRATION.md"),
        ]
        integ_path = next((x for x in integ_candidates if os.path.exists(x)), None)
        if integ_path:
            integ = io.open(integ_path, encoding="utf-8", errors="replace").read()
            doc_missing = [k for k in EXPECTED_KEYS if k not in integ]
            if doc_missing:
                failures.append(f"INTEGRATION.md missing keys (must update doc): {doc_missing} in {integ_path}")
        # else: no INTEGRATION.md -> skip sync check (plan says optional); don't fail
        # but ensure README documents isolation instead
        if not integ_path:
            if os.path.exists(README):
                readme = io.open(README, encoding="utf-8", errors="replace").read()
                if "fingerprint" not in readme.lower():
                    failures.append("fingerprint/README.md does not mention fingerprint isolation")

    if failures:
        print("PATCH CHECK FAILED:")
        for f in failures:
            print("  -", f)
        print("Fix before committing (--no-verify only for emergencies).")
        return 1

    print(f"PATCH CHECK PASSED: {len(EXPECTED_KEYS)} keys, hunks ok, docs ok, no residue")
    return 0


if __name__ == "__main__":
    sys.exit(main())
