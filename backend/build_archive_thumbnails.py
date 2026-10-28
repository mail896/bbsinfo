"""Build small private first-page previews for historical BBS Info PDFs.

Usage: python3 backend/build_archive_thumbnails.py ARCHIVE_ROOT
Original PDFs and their full-text index stay unchanged.
"""

import argparse
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile

from PIL import Image


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def build(root, issue, output):
    number, filename, sha256 = issue
    if not re.fullmatch(r"BBS-Info-\d{2,4}\.pdf", filename):
        raise ValueError("Ungültiger PDF-Dateiname im Index")
    source = root / "originals" / filename
    if source.is_symlink() or not source.is_file() or digest(source) != sha256:
        raise ValueError(f"Original von Ausgabe {number} stimmt nicht mit dem Index überein")
    with tempfile.TemporaryDirectory(prefix="bbsinfo-thumb-") as temp:
        picture = Path(temp) / "first.png"
        subprocess.run(["/usr/bin/gs", "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE",
                        "-sDEVICE=png16m", "-r95", "-dFirstPage=1", "-dLastPage=1",
                        f"-sOutputFile={picture}", str(source)], check=True, timeout=45,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"})
        with Image.open(picture) as original:
            preview = original.convert("RGB")
            preview.thumbnail((260, 370), Image.Resampling.LANCZOS)
            preview.save(output, "WEBP", quality=72, method=6)
        os.chmod(output, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    output_root = root / "thumbnails"
    output_root.mkdir(mode=0o700, exist_ok=True)
    os.chmod(output_root, 0o700)
    connection = sqlite3.connect(f"file:{root / 'index.sqlite'}?mode=ro", uri=True)
    try:
        issues = connection.execute("SELECT number, filename, sha256 FROM archive_issues ORDER BY number").fetchall()
    finally:
        connection.close()
    if not issues:
        raise ValueError("Archiv ist leer")
    for issue in issues:
        target = output_root / f"{issue[0]}.webp"
        if target.is_file() and target.stat().st_size > 0:
            continue
        temporary = output_root / f".{issue[0]}.webp.tmp"
        try:
            build(root, issue, temporary)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"{len(issues)} PDF-Vorschauen geprüft")


if __name__ == "__main__":
    main()
