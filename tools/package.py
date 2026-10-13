#!/usr/bin/env python3
"""Package ReceiptShield into a distributable ZIP.

Uses an explicit allowlist rather than "zip the directory", so local-only
artefacts (.dev/, logs, an earlier build) and anything resembling a secret
can never leak into the archive by accident.

The archive is deterministic: fixed timestamps, sorted entries, so re-running
this script reproduces the same bytes.

Usage:  python tools/package.py [--out receiptshield.zip]
"""

import argparse
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP = "receiptshield"          # the single top-level folder inside the archive

# Every file that ships. Adding a file here is the only way to get it in.
INCLUDE = [
    "index.html",
    "assets/css/styles.css",
    "assets/js/util.js",
    "assets/js/samples.js",
    "assets/js/ocr.js",
    "assets/js/parse.js",
    "assets/js/validate.js",
    "assets/js/visual.js",
    "assets/js/report.js",
    "assets/js/app.js",
    "tools/serve.js",
    "tools/bundle.js",
    "tools/package.py",
    "package.json",
    "README.md",
    "SOURCE.md",
    "receiptshield-standalone.html",
    ".gitignore",
]

# Belt-and-braces: refuse to add anything matching these, even if allowlisted.
BLOCKED_DIRS = {".dev", "node_modules", ".git", "__pycache__", ".venv", "venv"}
BLOCKED_SUFFIXES = (".log", ".zip", ".pyc", ".pem", ".key", ".p12", ".env")
BLOCKED_NAMES = {".env", ".env.local", ".env.production", "id_rsa", "id_ed25519"}

# A fixed stamp keeps the archive reproducible and avoids baking the
# packager's local clock (and timezone) into the file.
FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def is_blocked(rel):
    parts = rel.replace("\\", "/").split("/")
    if any(p in BLOCKED_DIRS for p in parts):
        return True
    if parts[-1] in BLOCKED_NAMES:
        return True
    if rel.lower().endswith(BLOCKED_SUFFIXES):
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="receiptshield.zip")
    args = ap.parse_args()

    out_path = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)

    missing = []
    included = []
    for rel in INCLUDE:
        src = os.path.join(ROOT, rel)
        if not os.path.isfile(src):
            missing.append(rel)
            continue
        if is_blocked(rel):
            print("refusing to package blocked path: " + rel, file=sys.stderr)
            return 2
        included.append(rel)

    if missing:
        print("missing required files, nothing written:", file=sys.stderr)
        for m in missing:
            print("  " + m, file=sys.stderr)
        return 1

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in sorted(included):
            with open(os.path.join(ROOT, rel), "rb") as fh:
                data = fh.read()
            info = zipfile.ZipInfo(TOP + "/" + rel.replace("\\", "/"), date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16          # -rw-r--r--
            zf.writestr(info, data)

    size = os.path.getsize(out_path)
    print("wrote " + os.path.basename(out_path) + "  (" + str(size) + " bytes)")
    print("files packaged: " + str(len(included)))
    for rel in sorted(included):
        print("  " + TOP + "/" + rel)

    # Re-open and prove the archive is readable before we hand it over.
    with zipfile.ZipFile(out_path) as zf:
        bad = zf.testzip()
        if bad is not None:
            print("archive failed integrity check at: " + bad, file=sys.stderr)
            return 3
    print("integrity check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
