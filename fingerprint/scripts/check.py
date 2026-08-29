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
PATCH_DIR = os.path.join(REPO, "fingerprint", "patches")
PATCH = os.path.join(PATCH_DIR, "fp-fingerprint.patch")
HELPERS = os.path.join(REPO, "fingerprint", "helpers", "fp_config_helpers.h")
README = os.path.join(REPO, "fingerprint", "README.md")

# The patch set is split by runtime subsystem so a Chromium upgrade only needs
# the one subsystem re-anchored. Checks that used to run against the single
# monolith now run against the SET: per-file checks apply to each patch, and
# whole-set checks (56-key coverage, no duplicate file ownership) run across
# all of them. Falls back to the monolith if no split patches exist yet.
SPLIT_NAMES = ["00-core", "10-blink-core", "20-blink-modules", "30-webrtc"]


def discover_patches():
    """Return [(label, path)] for the patch set, split first then monolith."""
    found = []
    for n in SPLIT_NAMES:
        p = os.path.join(PATCH_DIR, n + ".patch")
        if os.path.exists(p):
            found.append((n, p))
    if found:
        return found, "split"
    if os.path.exists(PATCH):
        return [("fp-fingerprint", PATCH)], "monolith"
    return [], "none"

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
    "navigator_platform",
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

    # 1. patch set exists (and helpers/README for isolation)
    patches, mode = discover_patches()
    if not patches:
        failures.append(
            "no patches found in fingerprint/patches/ "
            f"(expected {', '.join(SPLIT_NAMES)} or fp-fingerprint.patch)")
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
        # helpers-only minimal gate: 56-key completeness across the whole SET.
        # A key may live in any one patch, so union them before checking.
        if patches:
            joined = "".join(io.open(p, encoding="utf-8", errors="replace").read()
                             for _, p in patches)
            missing = [k for k in EXPECTED_KEYS if k not in joined]
            if missing:
                failures.append(f"missing config keys in patch set: {missing}")
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

    if patches:
        joined = "".join(io.open(p, encoding="utf-8", errors="replace").read()
                         for _, p in patches)
        all_files = []
        total_hunks = 0

        for label, ppath in patches:
            p = io.open(ppath, encoding="utf-8", errors="replace").read()

            # 3. upgrade guide / purpose header in every patch
            if "MERGE/UPGRADE GUIDE" not in p and "Apply in filename order" not in p:
                failures.append(f"{label}: missing upgrade/order header")

            # 4. per-file doc blocks vs file segments
            segs = re.split(r"(?m)^--- a/", p)
            files = [s.split("\n")[0].strip() for s in segs[1:]]
            all_files.extend(files)
            doc_count = len(re.findall(r"(?m)^# --- ", p))
            # 00-core creates fp_config_helpers.h via a 'diff --git' new-file
            # header, so it has no '--- a/' segment of its own.
            is_newfile_only = p.count("diff --git ") > 0 and not files
            if not is_newfile_only and len(files) != doc_count:
                failures.append(
                    f"{label}: doc/segment mismatch: {doc_count} doc blocks "
                    f"vs {len(files)} file segments")

            # 5. no empty segments
            for seg in segs[1:]:
                has_plus = re.search(r"(?m)^\+", seg) is not None
                has_minus = re.search(r"(?m)^-", seg) is not None
                if not has_plus and not has_minus:
                    first = seg.split("\n")[0].strip()
                    failures.append(f"{label}: empty segment: {first[:60]}")
                    break

            # 6. completeness across the SET (a key may live in any patch)
            missing = [k for k in EXPECTED_KEYS if k not in joined]
            if missing:
                failures.append(f"missing config keys in patch set: {missing}")

            # 7. debug residue
            for pat in DEBUG_PATTERNS:
                if re.search(pat, p):
                    failures.append(f"{label}: debug residue pattern found: {pat}")

            # 8. hunks present and well-formed
            hunks = len(re.findall(r"(?m)^@@ ", p))
            total_hunks += hunks
            if hunks == 0:
                failures.append(f"{label}: no hunks in patch")
            # A new-file diff uses "--- /dev/null" rather than "--- a/", so
            # count both source spellings before comparing against "+++ b/".
            n_src = p.count("\n--- a/") + p.count("\n--- /dev/null")
            n_dst = p.count("\n+++ b/")
            if n_src != n_dst:
                failures.append(
                    f"{label}: mismatched source/target header counts "
                    f"({n_src} vs {n_dst})")

        # 8a. no file is owned by two patches (a split must partition cleanly)
        seen = {}
        for f in all_files:
            seen[f] = seen.get(f, 0) + 1
        dupes = [f for f, n in seen.items() if n > 1]
        if dupes:
            failures.append(f"file(s) appear in more than one patch: {dupes}")

        if total_hunks == 0:
            failures.append("no hunks in patch set")

        # 8c. every key must be READ BY CODE, not merely mentioned.
        #
        # The old check was `k not in joined`, a plain substring test. That is
        # too weak in two ways: it matches a longer identifier containing the
        # key as a prefix, and it matches documentation lines such as
        # "# CONFIG: webrtc_ip". webgpu_features/webgpu_limits passed checks
        # for a long time with zero implementation precisely because of this.
        # Require the key to appear as a quoted string in ADDED (+) lines.
        #
        # Match any call shape: FpConfigInt("k", ...), and ternaries where the
        # key follows '?' or ':' on the same line, e.g.
        #   FpConfigString(p == 0x9245 ? "webgl_vendor" : "webgl_renderer")
        added_lines = "\n".join(
            l for l in joined.split("\n")
            if l.startswith("+") and not l.startswith("+++"))
        inert = [k for k in EXPECTED_KEYS if '"%s"' % k not in added_lines]
        if inert:
            failures.append(
                "key(s) not read by any added code line (declared but "
                "unimplemented?): " + ", ".join(inert))

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

        # 8d. BOUNDARY: network-stack files must not enter the patch set.
        #
        # TLS/JA3/JA4 are NOT implemented and cannot be reached from here: the
        # only config entry point (fp_config_helpers.h) lives under blink/, so
        # net/ and BoringSSL cannot read it. Verified by live HTTPS probe: the
        # config has zero effect on JA4.
        #
        # This is a boundary, not a bug - but it IS a documented one, and the
        # docs would silently go stale if someone patched net/ without also
        # updating fingerprint/README.md. Fail loudly so the doc must follow.
        # If you are deliberately implementing network-layer fingerprinting,
        # update the README section and then extend the allowlist below.
        NET_STACK_PREFIXES = (
            "net/",
            "third_party/boringssl/",
            "third_party/boringssl/src/",
        )
        net_files = [f for f in all_files
                     if f.startswith(NET_STACK_PREFIXES)]
        if net_files:
            failures.append(
                "patch set now touches the network stack (TLS/JA3/JA4 "
                "territory): %s -- fingerprint/README.md section "
                "'已知未覆盖：网络层指纹' must be updated, and the "
                "NET_STACK_PREFIXES allowlist in check.py extended"
                % net_files)

    if failures:
        print("PATCH CHECK FAILED:")
        for f in failures:
            print("  -", f)
        print("Fix before committing (--no-verify only for emergencies).")
        return 1

    print(f"PATCH CHECK PASSED: {mode} set ({len(patches)} file(s), "
          f"{total_hunks} hunks, {len(all_files)} targets), "
          f"{len(EXPECTED_KEYS)} keys, docs ok, no residue")
    return 0


if __name__ == "__main__":
    sys.exit(main())
