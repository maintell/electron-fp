#!/usr/bin/env python3
"""Isolated fingerprint patch applicator.

Applies the fingerprint patch set to Chromium src via `git apply`.

The patch set lives in fingerprint/patches/ and is split by runtime
subsystem so that a Chromium upgrade only requires re-anchoring the one
subsystem that broke, instead of a single monolith:

    00-core.patch           fp_config_helpers.h (created; included by the rest)
    10-blink-core.patch     Blink core: screen, canvas, timing, fonts, geo
    20-blink-modules.patch  Blink modules: webgl, webgpu, audio, media, ...
    30-webrtc.patch         WebRTC: custom IP override
    40-net-tls.patch        net/: fp_* fields on SSLContextConfig + HTTP/2 params

They are applied in filename order. 00-core must go first because it creates
fp_config_helpers.h, which the other patches' files include.

Two further patches (50-electron-glue, 60-electron-inspector) target the
ELECTRON tree (shell/...), not Chromium, so this script skips them - see
ELECTRON_PATCHES below. The docstring used to stop at 30-webrtc and say "32 of
36 files", which was true of the original 4-patch split and silently went stale
when 40/50/60 were added.

Each patch has its OWN idempotency marker, keyed on a string that only that
patch introduces. This is deliberate: the previous single marker
(fp_config_helpers.h exists) was correct for a monolith but would make
10/20/30 all report "already applied" and silently skip once 00-core ran.

- Exits 0 if src not present (local without sync) so CI without src passes.
- Return code pass-through on git failure.
- Windows path with spaces safe via list args + pathlib.
- Isolated to fingerprint/; does not touch script/apply_all_patches.py
"""
import argparse, hashlib, pathlib, re, subprocess, sys, tempfile

# Per-patch "already applied" markers: (file relative to src, needle).
# The needle is a string that ONLY this patch introduces, so each patch can
# tell its own state apart from the others'.
MARKERS = {
    "00-core": (
        "third_party/blink/renderer/core/frame/fp_config_helpers.h",
        None,  # file existence is the marker
    ),
    "10-blink-core": (
        "third_party/blink/renderer/core/frame/screen.cc",
        'FpConfigInt("screen_width"',
    ),
    "20-blink-modules": (
        "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc",
        'FpConfigInt("webgl_max_texture_size"',
    ),
    "30-webrtc": (
        "third_party/webrtc/rtc_base/network.cc",
        "SetCustomWebRtcIpOverride",
    ),
    # Without a marker, apply.py reported "patch does not apply" on a tree where
    # 40-net-tls was ALREADY applied - it retried the hunk instead of skipping,
    # and the failure looked like a broken tree. The needle is a symbol only
    # this patch introduces.
    "40-net-tls": (
        "net/socket/ssl_client_socket_impl.cc",
        "GetSSLContextForGrease",
    ),
}

# 50-electron-glue and 60-electron-inspector target the ELECTRON tree, not the
# Chromium tree: every one of their paths is shell/... under the electron-fp
# checkout. This script only ever applies to Chromium, so they are expected to
# report "No such file or directory" here - that is NOT a broken patch. Verify
# them with check.py and by applying them to the electron-fp tree directly.
ELECTRON_PATCHES = {"50-electron-glue", "60-electron-inspector"}


def is_applied(src: pathlib.Path, name: str) -> bool:
    if name not in MARKERS:
        return False
    rel, needle = MARKERS[name]
    f = src / rel
    if not f.exists():
        return False
    if needle is None:
        return True
    try:
        return needle in f.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False


def diff_body(raw: bytes) -> bytes:
    """Strip the leading '#' documentation block; git apply wants the diff."""
    m = re.search(rb"^(?:--- a/|diff --git )", raw, re.M)
    return raw[m.start():] if m else raw


def discover(patches_dir: pathlib.Path):
    """Return split patches in filename order, falling back to the monolith."""
    found = sorted(patches_dir.glob("[0-9][0-9]-*.patch"))
    if found:
        return found, "split"
    mono = patches_dir / "fp-fingerprint.patch"
    if mono.exists():
        return [mono], "monolith"
    return [], "none"


def main() -> int:
    p = argparse.ArgumentParser(description="Apply fingerprint patch set")
    p.add_argument("--src", default="src", help="Chromium src dir (default: src)")
    p.add_argument("--dry-run", action="store_true", help="check only, do not apply")
    p.add_argument("--patch", default=None,
                   help="apply a single patch instead of the whole set")
    a = p.parse_args()
    sd = pathlib.Path(__file__).resolve().parent
    rr = sd.parent.parent

    patches_dir = (rr / "fingerprint" / "patches").resolve()
    if a.patch:
        patch = pathlib.Path(a.patch)
        if not patch.is_absolute():
            patch = (pathlib.Path.cwd() / patch).resolve()
        patches, mode = [patch], "single"
    else:
        patches, mode = discover(patches_dir)
    if not patches:
        print(f"no patches found in {patches_dir}", file=sys.stderr)
        return 1

    src = pathlib.Path(a.src)
    if not src.is_absolute():
        cand = (rr / a.src).resolve()
        src = cand if cand.exists() else (pathlib.Path.cwd() / a.src).resolve()
    if not (src / "third_party" / "blink").exists():
        if not src.exists():
            print(f"src not found at {src}, skipping (no Chromium checkout)", file=sys.stderr)
            return 0
        print(f"src at {src} does not look like Chromium (third_party/blink missing), skipping", file=sys.stderr)
        return 0

    print(f"fingerprint patch set: {mode} ({len(patches)} file(s))")
    for patch in patches:
        if not patch.exists():
            print(f"patch not found: {patch}", file=sys.stderr)
            return 1
        name = patch.stem
        raw = patch.read_bytes()
        h = hashlib.sha256(raw).hexdigest()[:8]
        tmp = pathlib.Path(tempfile.gettempdir()) / f"fp-{name}-{h}.patch"
        tmp.write_bytes(diff_body(raw))

        if is_applied(src, name):
            print(f"  {name}: already applied (marker), skipping")
            continue

        # Electron-tree patches (see the note above MARKERS). Their paths do not
        # exist under the Chromium tree, so git apply can only ever report
        # "No such file or directory". Reporting that as a failure made a
        # healthy checkout look broken; skip them here and say why.
        if name in ELECTRON_PATCHES:
        # Point at the step that ACTUALLY verifies these. This used to say
        # "(verify with check.py)", but check.py only greps the patch text - it
        # never attempts to apply anything. So the instruction sent the reader
        # to a gate that cannot detect a patch that no longer applies, while the
        # real check (Client/test-patch-apply.js, which runs git apply --check
        # in both directions) was unmentioned. A pointer to the wrong verifier
        # is worse than none: it produces false confidence.
            print(f"  {name}: Electron-tree patch, not applicable to Chromium "
                  f"(verify with node Client/test-patch-apply.js)")
            continue

        if a.dry_run:
            r = subprocess.run(["git", "-C", str(src), "apply", "--check", str(tmp)],
                               capture_output=True, text=True)
            if r.returncode == 0:
                print(f"  {name}: dry-run applies cleanly")
                continue
            combined = (r.stderr + r.stdout).lower()
            if "already applied" in combined or "already exists" in combined:
                print(f"  {name}: dry-run already applied (idempotent)")
                continue
            print(f"  {name}: dry-run would NOT apply cleanly", file=sys.stderr)
            if r.stderr:
                print(r.stderr, file=sys.stderr)
            return r.returncode
        else:
            r = subprocess.run(["git", "-C", str(src), "apply", "--whitespace=nowarn", str(tmp)],
                               capture_output=True, text=True)
            if r.returncode == 0:
                print(f"  {name}: applied")
                continue
            combined = (r.stderr + r.stdout).lower()
            if "already applied" in combined or "already exists" in combined:
                print(f"  {name}: already applied, skipping")
                continue
            print(f"  {name}: FAILED", file=sys.stderr)
            if "does not match" in r.stderr:
                print("dirty working tree - consider `git checkout -- <file>`", file=sys.stderr)
            if r.stderr:
                print(r.stderr, file=sys.stderr)
            if r.stdout:
                print(r.stdout)
            return r.returncode

    print("fingerprint patch set: done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
