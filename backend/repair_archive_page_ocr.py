"""Add a verified OCR pass to one page of the private derived search index.

The source PDF is never modified. The index is backed up before its single-row
change. Example: python3 backend/repair_archive_page_ocr.py ROOT 92 1 Bittner
"""

import argparse
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def recognize(pdf, page, folder):
    image = folder / "page.png"
    common = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
              "timeout": 45, "check": True,
              "env": {"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"}}
    subprocess.run(["/usr/bin/gs", "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE",
                    "-sDEVICE=pnggray", "-r180", f"-dFirstPage={page}",
                    f"-dLastPage={page}", f"-sOutputFile={image}", str(pdf)], **common)
    result = subprocess.run(["/usr/bin/tesseract", str(image), "stdout", "-l", "deu+eng",
                             "--psm", "11"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=45, check=True,
                            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"})
    if len(result.stdout) > 200000:
        raise ValueError("OCR-Ausgabe zu groß")
    return result.stdout.decode("utf-8", "replace")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("number", type=int)
    parser.add_argument("page", type=int)
    parser.add_argument("expected_term")
    args = parser.parse_args()
    if not (1 <= args.number <= 9999 and 1 <= args.page <= 100):
        raise ValueError("Ungültige Ausgabe oder Seite")
    if not re.fullmatch(r"[\wÄÖÜäöüß-]{2,60}", args.expected_term):
        raise ValueError("Ungültiger Prüfterm")
    root = args.root.resolve(strict=True)
    db_path = root / "index.sqlite"
    connection = sqlite3.connect(db_path)
    try:
        issue = connection.execute("SELECT filename, sha256, page_count FROM archive_issues WHERE number=?", (args.number,)).fetchone()
        if not issue or args.page > issue[2] or not re.fullmatch(r"BBS-Info-\d{2,4}\.pdf", issue[0]):
            raise ValueError("Ausgabe oder Seite nicht vorhanden")
        pdf = root / "originals" / issue[0]
        if pdf.is_symlink() or not pdf.is_file() or digest(pdf) != issue[1]:
            raise ValueError("Original-PDF stimmt nicht mit dem Index überein")
        row = connection.execute("SELECT rowid, archive_id, page, number, school_year, period, body FROM archive_pages_fts WHERE archive_id=? AND page=?", (args.number, args.page)).fetchone()
        if not row:
            raise ValueError("Indexseite fehlt")
        if args.expected_term.casefold() in row[6].casefold():
            print("Prüfterm bereits im Index")
            return
        with tempfile.TemporaryDirectory(prefix="bbsinfo-ocr-") as temp:
            recognized = recognize(pdf, args.page, Path(temp))
        if not re.search(rf"(?<!\w){re.escape(args.expected_term)}(?!\w)", recognized, re.IGNORECASE):
            raise ValueError("Prüfterm im neuen OCR-Ergebnis nicht gefunden")
        backup_path = root / f"index.before-ocr-{args.number}-{args.page}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.sqlite"
        backup = sqlite3.connect(backup_path)
        try:
            connection.backup(backup)
        finally:
            backup.close()
        os.chmod(backup_path, 0o600)
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute("DELETE FROM archive_pages_fts WHERE rowid=?", (row[0],))
            connection.execute("INSERT INTO archive_pages_fts(archive_id,page,number,school_year,period,body) VALUES(?,?,?,?,?,?)",
                               (*row[1:6], row[6] + "\n" + recognized))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        print(f"OCR-Suchtext für Ausgabe {args.number}, Seite {args.page} ergänzt; Backup erstellt")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
