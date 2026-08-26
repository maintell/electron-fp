#!/usr/bin/env python3
"""Isolated fingerprint patch applicator.

Applies fingerprint/patches/fp-fingerprint.patch to Chromium src via
`git am --keep-non-patch --3way`.
- Exits 0 if src not present (local without sync) so CI without src still passes.
- Return code pass-through on git failure.
- Windows path with spaces safe via list args + pathlib.
- Isolated to fingerprint/; does not touch script/apply_all_patches.py
"""
import argparse
import pathlib
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply fingerprint patch")
    parser.add_argument("--src", default="src", help="Chromium src dir (default: src)")
    parser.add_argument("--dry-run", action="store_true", help="check only, do not apply")
    parser.add_argument("--patch", default=None, help="override patch path")
    args = parser.parse_args()

    script_dir = pathlib.Path(__file__).resolve().parent
    repo_root = script_dir.parent.parent  # fingerprint/scripts/ -> repo
    if args.patch:
        patch = pathlib.Path(args.patch)
        if not patch.is_absolute():
            patch = (pathlib.Path.cwd() / patch).resolve()
    else:
        patch = (repo_root / "fingerprint" / "patches" / "fp-fingerprint.patch").resolve()

    if not patch.exists():
        print(f"patch not found: {patch}", file=sys.stderr)
        return 1

    src = pathlib.Path(args.src)
    if not src.is_absolute():
        # resolve relative to repo root for stability; fallback to cwd
        cand = (repo_root / args.src).resolve()
        if cand.exists():
            src = cand
        else:
            src = (pathlib.Path.cwd() / args.src).resolve()

    # src missing -> graceful skip (local dev without Chromium checkout)
    if not (src / "third_party" / "blink").exists():
        # also accept src == repo_root/src layout check: src itself may be repo_root
        # if src dir doesn't exist at all, skip
        if not src.exists():
            print(f"src not found at {src}, skipping (no Chromium checkout)", file=sys.stderr)
            return 0
        # src exists but not a Chromium tree -> still skip
        print(f"src at {src} does not look like Chromium (third_party/blink missing), skipping", file=sys.stderr)
        return 0

    if args.dry_run:
        # dry-run: git apply --check --3way via `git am --3way` not trivial;
        # use `git apply --check` as lightweight check
        ret = subprocess.call(
            ["git", "-C", str(src), "apply", "--check", "--3way", str(patch)]
        )
        if ret == 0:
            print("dry-run: patch applies cleanly")
        else:
            print("dry-run: patch would not apply cleanly", file=sys.stderr)
        return ret

    ret = subprocess.call(
        ["git", "-C", str(src), "am", "--keep-non-patch", "--3way", "--", str(patch)]
    )
    return ret


if __name__ == "__main__":
    sys.exit(main())
