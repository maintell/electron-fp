#!/usr/bin/env python3
"""Isolated fingerprint patch applicator.

Applies fingerprint/patches/fp-fingerprint.patch to Chromium src via
`git apply --3way` (no commit).
- Exits 0 if src not present (local without sync) so CI without src still passes.
- Return code pass-through on git failure.
- Windows path with spaces safe via list args + pathlib.
- Isolated to fingerprint/; does not touch script/apply_all_patches.py
"""
import argparse, hashlib, pathlib, subprocess, sys, tempfile
# ponytail: apply without commit, track via git diff; switch to mail header am when audit needed

def main() -> int:
    p = argparse.ArgumentParser(description="Apply fingerprint patch")
    p.add_argument("--src", default="src", help="Chromium src dir (default: src)")
    p.add_argument("--dry-run", action="store_true", help="check only, do not apply")
    p.add_argument("--patch", default=None, help="override patch path")
    a = p.parse_args()
    sd = pathlib.Path(__file__).resolve().parent
    rr = sd.parent.parent
    if a.patch:
        patch = pathlib.Path(a.patch)
        if not patch.is_absolute():
            patch = (pathlib.Path.cwd() / patch).resolve()
    else:
        patch = (rr / "fingerprint" / "patches" / "fp-fingerprint.patch").resolve()
    if not patch.exists():
        print(f"patch not found: {patch}", file=sys.stderr)
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
    raw = patch.read_bytes()
    h = hashlib.sha256(raw).hexdigest()[:8]
    tmp = pathlib.Path(tempfile.gettempdir()) / f"fp-{h}.patch"
    off = raw.find(b"--- a/")
    tmp.write_bytes(raw[off:] if off != -1 else raw)
    # ponytail: working-tree marker - index clean + tree dirty makes git apply --check fail; detect already-patched tree
    try:
        _helper = src / "third_party" / "blink" / "renderer" / "core" / "frame" / "fp_config_helpers.h"
        _screen = src / "third_party" / "blink" / "renderer" / "core" / "frame" / "screen.cc"
        marker = _helper.exists()
        if not marker and _screen.exists():
            t = _screen.read_text(encoding="utf-8", errors="replace")
            marker = t.find('FpConfigInt("screen_width"') != -1 or t.find("FpConfigInt") != -1
    except Exception:
        marker = False
    def chk():
        if marker:
            return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        return subprocess.run(["git", "-C", str(src), "apply", "--check", "--3way", str(tmp)], capture_output=True, text=True)
    if a.dry_run:
        if marker:
            print("patch already applied (working tree marker), skipping")
            return 0
        r = chk()
        if r.returncode == 0:
            print("dry-run: patch applies cleanly")
            return 0
        if "already applied" in (r.stderr + r.stdout).lower():
            print("dry-run: patch already applied (idempotent)", file=sys.stderr)
            return 0
        print("dry-run: patch would not apply cleanly", file=sys.stderr)
        if r.stderr:
            print(r.stderr, file=sys.stderr)
        return r.returncode
    if marker:
        print("patch already applied (working tree marker), skipping")
        return 0
    r = chk()
    if "already applied" in (r.stderr + r.stdout).lower():
        print("patch already applied, skipping", file=sys.stderr)
        return 0
    res = subprocess.run(["git", "-C", str(src), "apply", "--3way", "--whitespace=nowarn", str(tmp)], capture_output=True, text=True)
    if res.returncode != 0:
        if "does not match" in res.stderr:
            print("Apply via apply --3way; dirty working tree - consider git checkout -- <file> if block", file=sys.stderr)
        if res.stderr:
            print(res.stderr, file=sys.stderr)
        if res.stdout:
            print(res.stdout)
    return res.returncode

if __name__ == "__main__":
    sys.exit(main())
