#!/usr/bin/env python3
"""fingerprint patch static quality gate — mirrors ungoogled devutils/check_patch.py 8 checks.

Simplified for electron-fp isolation:
- paths rooted at fingerprint/ (not patches/series)
- isolation enforced: fingerprint patch stays outside patches/chromium/
- 63 keys completeness, debug residue, hunks, doc blocks, INTEGRATION sync
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
# whole-set checks (60-key coverage, no duplicate file ownership) run across
# all of them. Falls back to the monolith if no split patches exist yet.
# Discovered from the directory rather than hardcoded. A hardcoded list silently
# excluded a newly-added split patch more than once: the file was generated and
# correct, but every whole-set check skipped it, so new keys looked
# unimplemented. Deriving the list means adding a split can never again be
# invisible to the checks.
def discover_split_names():
    if not os.path.isdir(PATCH_DIR):
        return []
    names = []
    for fn in os.listdir(PATCH_DIR):
        # Split patches are the "<nn>-<name>.patch" files; the monolith is
        # fp-fingerprint.patch and must not be double-counted alongside them.
        if fn == "fp-fingerprint.patch" or not fn.endswith(".patch"):
            continue
        stem = fn[:-len(".patch")]
        if stem[:1].isdigit() and "-" in stem:
            names.append(stem)
    return sorted(names)


SPLIT_NAMES = discover_split_names()


def discover_patches():
    """Return [(label, path)] for the patch set, split first then monolith."""
    found = []
    for n in discover_split_names():
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
    "ua_brands", "ua_platform", "ua_mobile",
    # 61-63: surfaces that leaked the host during an external audit against
    # browserleaks.com and creepjs (each disagreed with the spoofed UA).
    "navigator_vendor", "navigator_languages", "device_pixel_ratio",
]

DEBUG_PATTERNS = [
    r'm6_sentinel', r'fp_dbg', r'sentinel',
    r'fopen\("F:', r'printf\("fp',
]

# Residue patterns that are allowed when they are part of a deliberate,
# documented refusal path rather than leftover debugging.
#
# Context: 40-net-tls ships fp_extension_order as a config field that BoringSSL
# cannot implement (it only offers permute-on/off, no pinned extension order).
# The kernel therefore LOG(ERROR)s and fails the connection, so a profile cannot
# silently claim a fingerprint it does not produce. That LOG is load-bearing
# production behavior, not debug residue - but the plain `LOG\(ERROR\).*fp`
# rule above would flag it. Allowlisting just that one call keeps the rule
# useful for genuinely accidental logging (which was its purpose) without
# forcing us to remove a deliberate safety net.
ALLOWED_RESIDUE = [
    # fp_extension_order unimplemented refusal (net/socket/ssl_client_socket_impl.cc)
    r'LOG\(ERROR\) << "fp_extension_order is set but not implemented',
    # invalid fp cipher list: an invalid list breaks every connection on the
    # profile, so it must be reported loudly and attributed to the setting.
    r"LOG\(ERROR\) << 'SSL_set_cipher_list\('",
]


def main():
    parser = argparse.ArgumentParser(description="Fingerprint patch checks")
    parser.add_argument("--helpers-only", action="store_true", help="only check helpers/63 keys existence (Task 2)")
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
            #
            # HISTORY: this was an `and` - "fail only if BOTH markers are absent".
            # Every patch carries "Apply in filename order" in its boilerplate
            # header, so the second half was always true and MERGE/UPGRADE GUIDE
            # was a DEAD CHECK: deleting the entire upgrade guide from a patch
            # still passed. Found by mutation-testing this gate (delete the
            # marker, expect exit 1, got exit 0).
            #
            # The upgrade guide is the part that matters: it is what tells the
            # next person, on a Chromium bump, where our hunks sit relative to
            # upstream's and which of them will conflict. Losing it silently is
            # exactly the rot this gate exists to stop. So require BOTH:
            #   - "Apply in filename order" (ordering is load-bearing: 00-core
            #     creates the header the rest include)
            #   - "MERGE/UPGRADE GUIDE" (per-patch re-anchoring notes)
            #
            # The one exception is the retired monolith, which is explicitly
            # dead weight and says so at the top; it has neither and must not.
            is_retired_monolith = "DEAD WEIGHT" in p
            if not is_retired_monolith:
                for marker in ("Apply in filename order", "MERGE/UPGRADE GUIDE"):
                    if marker not in p:
                        failures.append(
                            f"{label}: missing header marker {marker!r} "
                            f"(the gate used to accept either one, which made "
                            f"MERGE/UPGRADE GUIDE unenforceable)")

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

            # 7. debug residue (excluding deliberate, documented refusals)
            for pat in DEBUG_PATTERNS:
                hit = re.search(pat, p)
                if not hit:
                    continue
                # Is this hit on a line we explicitly allow?
                line_start = p.rfind("\n", 0, hit.start()) + 1
                line_end = p.find("\n", hit.start())
                line = p[line_start:line_end if line_end != -1 else len(p)]
                if any(re.search(a, line) for a in ALLOWED_RESIDUE):
                    continue
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

        # 8d. BOUNDARY: network-stack files are gated, not forbidden.
        #
        # HISTORY: this check used to fail outright on any net/ file. The reason
        # was real - TLS/JA3/JA4 could not be reached from the browser surface,
        # because the only config entry point (fp_config_helpers.h) lives under
        # blink/ and net/ cannot read it. The guard existed to stop the README
        # going stale if someone patched net/ anyway.
        #
        # NOW IMPLEMENTED via 40-net-tls.patch, which does NOT reuse the blink
        # config: it adds fp_* fields to net::SSLContextConfig and to the
        # network::mojom::SSLConfig mojom message, which Electron already plumbs
        # end-to-end (session.setSSLConfig -> ElectronBrowserContext ->
        # OnSSLConfigUpdated -> network service -> SSLClientContext ->
        # SSLClientSocketImpl). Per-profile isolation comes free from the
        # per-URLRequestContext SSLClientContext.
        #
        # So the guard is now a DOC-SYNC gate on an allowlist: network files are
        # permitted only when they are part of that known control plane, and the
        # README must describe them. BoringSSL itself stays off-limits - we
        # drive it purely through its public API.
        NET_ALLOWLIST = (
            "net/ssl/ssl_config_service.h",
            "net/socket/ssl_client_socket_impl.cc",
            "net/http/http_network_session.h",
            "net/http/http_network_session.cc",
            "services/network/public/mojom/ssl_config.mojom",
            "services/network/ssl_config_type_converter.cc",
            # HTTP/2 profile transport: the mojom message and the one place
            # NetworkContextParams are translated into HttpNetworkSessionParams.
            "services/network/public/mojom/network_context.mojom",
            "services/network/network_context.cc",
        )
        # BoringSSL remains a hard boundary: patching the TLS implementation
        # itself touches a security-critical handshake path and needs its own
        # review, so it is never covered by the net/ allowlist above.
        BORINGSSL_PREFIXES = (
            "third_party/boringssl/",
            "third_party/boringssl/src/",
        )
        net_files = sorted({f for f in all_files
                            if f.startswith("net/") or
                            f.startswith("services/network/")})
        unknown_net = [f for f in net_files if f not in NET_ALLOWLIST]
        if unknown_net:
            failures.append(
                "patch set touches network-stack files outside the "
                "fp TLS/HTTP2 control plane: %s -- if intentional, add them to "
                "NET_ALLOWLIST in check.py and document them in "
                "fingerprint/README.md" % unknown_net)
        boring = [f for f in all_files if f.startswith(BORINGSSL_PREFIXES)]
        if boring:
            failures.append(
                "patch set modifies BoringSSL source (%s): this is a hard "
                "boundary (security-critical handshake path). Drive it through "
                "the public API instead." % boring)
        if net_files and not unknown_net:
            # Network control plane present: the README must say so, otherwise
            # the doc silently contradicts the code (the original failure mode
            # this guard was written to prevent).
            readme_path = os.path.join(REPO, "fingerprint", "README.md")
            if os.path.exists(readme_path):
                readme = io.open(readme_path, encoding="utf-8",
                                 errors="replace").read()
                if "40-net-tls" not in readme:
                    failures.append(
                        "patch set contains the net TLS/HTTP2 control plane but "
                        "fingerprint/README.md does not mention '40-net-tls'; "
                        "update the '网络层指纹' section")
            else:
                failures.append(
                    "patch set contains net files but fingerprint/README.md "
                    "is missing")

        # 9. DOC DRIFT: prose stating an outdated key count.
        #
        # HISTORY: the tree grew from 56 (upstream) to 63 keys, and the docs kept
        # saying 56/60 in five files. The merge guide is the worst place for that:
        # a future porter regenerating patches on a new Chromium baseline would
        # read "60-key integrity check", see 63, and believe three keys had
        # appeared or vanished.
        #
        # The gate scans docs for a number-qualified key count that disagrees with
        # EXPECTED_KEYS (derived from the schema, so it cannot drift from code).
        # A count explicitly labelled as the upstream baseline is history, not
        # drift, and is allowed.
        DOC_FILES = (
            "fingerprint/README.md",
            "fingerprint/scripts/check.py",
            "docs/superpowers/plans/2026-08-26-electron-fingerprint.md",
            "docs/superpowers/specs/2026-08-26-electron-fingerprint-design.md",
            "docs/superpowers/specs/2026-08-29-fingerprint-patch-split-design.md",
        )
        _n = len(EXPECTED_KEYS)
        # Counts that could plausibly be a former/current total. Deliberately
        # excludes realistic false positives (e.g. "2 keys" in a prose sentence).
        _stale_re = re.compile(
            r"(?<![\w.])(4[0-9]|5[0-9]|6[0-9]|7[0-9])\s*(?:键|keys?\b)")
        for rel in DOC_FILES:
            p = os.path.join(REPO, *rel.split("/"))
            if not os.path.exists(p):
                continue
            try:
                body = io.open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            is_py = rel.endswith(".py")
            for lineno, line in enumerate(body.splitlines(), 1):
                # In source files, count-bearing prose lives in comments, and
                # THIS file's comments quote stale numbers as worked examples
                # ("fp-fingerprint.patch really did ship 56 keys"), which would
                # flag the file implementing the check. Skip Python comments and
                # only inspect real code lines there; docs are all prose, so
                # every line counts.
                if is_py and line.lstrip().startswith("#"):
                    continue
                hit = _stale_re.search(line)
                if not hit:
                    continue
                if int(hit.group(1)) == _n:
                    continue
                # A count labelled as the UPSTREAM BASELINE is history, not
                # drift: fp-fingerprint.patch really did ship 56 keys and this
                # project extended it to 63.
                #
                # The label has to be ADJACENT to the count, not merely on the
                # same line. A merge-guide line reading "...用上游 devutils/
                # gen_patch6.py ... （含 60 键完整性校验）" mentions an upstream
                # TOOL while the count describes OUR gate - matching on a bare
                # "上游" anywhere in the line suppressed a genuinely stale count.
                # Require the label within a few characters of the number.
                window = line[max(0, hit.start() - 12):hit.end() + 12]
                if re.search(r"上游|upstream", window, re.I):
                    continue
                # "余 N 键" / "remaining N keys" is a REMAINDER, not a total: a
                # config example listing 9 of 63 legitimately says "余 54 键".
                # Only claims about the overall total are drift.
                if re.search(r"余|剩|remaining|other", line, re.I):
                    continue
                failures.append(
                    "doc drift: %s:%d states %s keys but the schema has %d "
                    "-- update the prose (or mark it as the upstream baseline "
                    "if that is what it means)" % (rel, lineno, hit.group(1), _n))

        # 10. PATCH-SET DRIFT: the README directory table must match the tree.
        #
        # HISTORY: fingerprint/README.md listed only 4 patches and said the set
        # was "split into 4", while 40-net-tls, 50-electron-glue and
        # 60-electron-inspector had been in patches/ for months - 1400+ lines of
        # Inspector code that a reader following the table would never find.
        # Then, while fixing it, I hand-wrote the total as 228 hunks when the
        # active set has 136 (228 is the count INCLUDING the retired monolith).
        #
        # The key-count drift check above cannot catch this: it only looks at
        # key counts. And a table this easy to get wrong is exactly the table a
        # reader trusts, because it is the index into everything else.
        #
        # So: derive the counts from the patches that were already parsed, and
        # require the README to state them. This runs in the split branch where
        # `patches`, `all_files` and `total_hunks` are in scope.
        if patches:
            readme_p = os.path.join(REPO, "fingerprint", "README.md")
            if os.path.exists(readme_p):
                try:
                    rbody = io.open(readme_p, encoding="utf-8",
                                    errors="replace").read()
                except OSError:
                    rbody = ""
                n_patches = len(patches)
                # all_files counts only "--- a/" segments, i.e. files that
                # EXIST upstream and are modified. New files write "---
                # /dev/null" and have no such segment, so they are absent here
                # and show up only in "+++ b/". Both numbers are real; a doc
                # that quotes one without saying which is ambiguous - which is
                # precisely how I first wrote "63 文件" from the +++ count and
                # then had check.py report 59. Require BOTH, named.
                n_new = len({f for f in re.findall(r"(?m)^\+\+\+ b/(\S+)", joined)
                             if f not in set(all_files)})
                n_modified = len(all_files)
                n_targets = n_modified + n_new
                # Every patch name must be reachable from the README, otherwise
                # the index silently omits it.
                for _, ppath in patches:
                    label = os.path.basename(ppath)
                    if label not in rbody:
                        failures.append(
                            "doc drift: fingerprint/README.md never mentions "
                            "%s - it is in patches/ but missing from the "
                            "directory table, so a reader cannot find it" % label)
                # The numeric totals the table states must be the real ones.
                #
                # SCOPE THE SEARCH TO THE TABLE. First version matched anywhere
                # in the file, and the README's own caveat - explaining that 59
                # and 63 are both real and differ by counting method - mentions
                # BOTH numbers, so it satisfied the regex and the guard went
                # green on a table that said "63 个修改". A document explaining
                # its own numbers is exactly where a global match fails.
                #
                # So: match against the ONE line that carries the totals
                # ("生效合计"). Neither the section nor a blockquote-stripped
                # slice worked - the caveat prose explaining the two counting
                # methods quotes both numbers and sits inside every broader
                # scope I tried, so a table reading "63 个修改" still passed.
                # Anchoring on the 生效合计 line removes the scoping question
                # entirely: there is exactly one such line, and it is the claim.
                _tot = None
                for _line in rbody.splitlines():
                    if "生效合计" in _line:
                        _tot = _line
                        break
                table_body = _tot or ""
                expect = (
                    ("modified-file count",
                     r"%d\s*个修改" % n_modified),
                    ("new-file count",
                     r"%d\s*个新建" % n_new),
                    ("hunk total",
                     r"%d\s*个\s*hunk" % total_hunks),
                )
                for what, rx in expect:
                    if not re.search(rx, table_body):
                        failures.append(
                            "doc drift: fingerprint/README.md 目录结构 table does "
                            "not state the real %s (expected %d modified + %d new "
                            "= %d target files, %d hunks, %d patches) - note the "
                            "match is scoped to the table, so the caveat prose "
                            "below it cannot satisfy this by also quoting the "
                            "numbers"
                            % (what, n_modified, n_new, n_targets,
                               total_hunks, n_patches))
                # The patch-count claim ("split into N") also lives in the same
                # section and rotted for months at 4 while there were 7.
                # The bold markers wrap the WHOLE 生效合计 sentence
                # ("**拆分为 7 个生效补丁，...**"), so they sit before 拆分为,
                # not around the number. Anchoring \*\* around the digit never
                # matched and the check was vacuous.
                if not re.search(r"拆分为\s*%d\s*个生效补丁" % n_patches,
                                 table_body):
                    failures.append(
                        "doc drift: fingerprint/README.md 目录结构 does not state "
                        "the real active patch count (%d) - it previously said 4 "
                        "while three whole patches were undiscoverable"
                        % n_patches)
                # The SAME claim is repeated in the intro bullet at the top of
                # the file, because that is the first line a reader sees. Two
                # copies means two chances to drift: the intro still said
                # "拆分为 4 个" after the table was corrected. Check both.
                intro = rbody.split("## 目录结构")[0]
                if not re.search(r"拆分为\s*%d\s*个生效补丁" % n_patches, intro):
                    failures.append(
                        "doc drift: fingerprint/README.md 目录结构 does not state "
                        "the real active patch count (%d) - it previously said 4 "
                        "while three whole patches were undiscoverable"
                        % n_patches)

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
