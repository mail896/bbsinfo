"""Import protected historical BBS-Info PDFs into the private archive index.

The original PDF is copied unchanged. Only selected extracted text enters SQLite.
Nothing in this command publishes a web route or sends mail.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile

PROJECT = Path(__file__).resolve().parent.parent
INBOX = PROJECT / "private/historical-inbox"
ARCHIVE = PROJECT / "private/archive"
ORIGINALS = ARCHIVE / "originals"
TEMP = ARCHIVE / "temp"
DATABASE = ARCHIVE / "index.sqlite"
EXTRACTOR = PROJECT / "backend/pdf_text.py"
FILENAME = re.compile(r"BBS-Info-(\d{2,4})\.pdf\Z")
MAX_FILE_BYTES = 30 * 1024 * 1024


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def extract(path):
    process = subprocess.run(
        ["/usr/bin/python3", str(EXTRACTOR), str(path)],
        capture_output=True, timeout=35, check=False,
        env={"PATH": "/usr/bin:/bin", "PYTHONNOUSERSITE": "1", "LC_ALL": "C.UTF-8"},
    )
    if process.returncode:
        raise ValueError("PDF-Textextraktion fehlgeschlagen")
    try:
        result = json.loads(process.stdout)
        if not 1 <= result["pageCount"] <= 100 or len(result["pages"]) != result["pageCount"]:
            raise ValueError
        return result
    except (ValueError, KeyError, TypeError):
        raise ValueError("Ungültige PDF-Textextraktion") from None


def significant(text):
    return sum(not char.isspace() for char in text)


def merge_text(native, recognized):
    combined = []
    for old, new in zip(native["pages"], recognized["pages"], strict=True):
        old_count, new_count = significant(old["text"]), significant(new["text"])
        # Keep the PDF's real text layer unless OCR clearly adds missing text.
        chosen = new["text"] if (old_count < 50 and new_count >= 50) or (old_count >= 50 and new_count > old_count * 1.25) else old["text"]
        combined.append({"page": old["page"], "text": chosen})
    return combined


def recognize(source, native):
    if not native["lowTextPages"]:
        return native["pages"], "native"
    with tempfile.TemporaryDirectory(prefix="ocr-", dir=TEMP) as folder:
        output = Path(folder) / "searchable.pdf"
        mode = "--force-ocr" if len(native["lowTextPages"]) == native["pageCount"] else "--redo-ocr"
        command = [
            "/usr/bin/ocrmypdf", mode, "--oversample", "300", "--output-type", "pdf",
            "--optimize", "0", "--jobs", "1", "--skip-big", "25",
            "--tesseract-timeout", "60", "-l", "deu+eng", "--quiet", str(source), str(output),
        ]
        environment = {**os.environ, "TMPDIR": str(TEMP)}
        try:
            process = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     env=environment, timeout=180, check=False)
            if process.returncode:
                return native["pages"], "ocr_failed"
            recognized = extract(output)
            if recognized["pageCount"] != native["pageCount"]:
                return native["pages"], "ocr_failed"
            return merge_text(native, recognized), "ocr_done"
        except (OSError, subprocess.TimeoutExpired, ValueError):
            return native["pages"], "ocr_failed"


def prepare_database():
    connection = sqlite3.connect(DATABASE)
    os.chmod(DATABASE, 0o600)
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("""CREATE TABLE IF NOT EXISTS archive_issues (
        number INTEGER PRIMARY KEY, filename TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL, page_count INTEGER NOT NULL,
        low_text_pages TEXT NOT NULL, ocr_state TEXT NOT NULL,
        school_year TEXT NOT NULL DEFAULT '', period TEXT NOT NULL DEFAULT '',
        indexed_at TEXT NOT NULL
    )""")
    connection.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS archive_pages_fts USING fts5(
        archive_id UNINDEXED, page UNINDEXED, number, school_year, period, body,
        tokenize='unicode61 remove_diacritics 2'
    )""")
    connection.commit()
    return connection


def copy_original(source, destination, expected_hash):
    if destination.exists():
        if digest(destination) != expected_hash:
            raise ValueError("Abweichende archivierte Originaldatei")
        return
    with tempfile.NamedTemporaryFile(prefix=".incoming-", suffix=".pdf", dir=ORIGINALS, delete=False) as target:
        temporary = Path(target.name)
        os.chmod(target.name, 0o600)
        try:
            with source.open("rb") as incoming:
                shutil.copyfileobj(incoming, target, length=1024 * 1024)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    try:
        if digest(temporary) != expected_hash:
            raise ValueError("Originaldatei hat sich während des Imports geändert")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def sources(only):
    found = []
    for path in INBOX.iterdir():
        if path.is_symlink() or not path.is_file():
            raise ValueError("Eingangsordner enthält einen unzulässigen Eintrag")
        match = FILENAME.fullmatch(path.name)
        if not match:
            raise ValueError("Eingangsordner enthält einen Dateinamen außerhalb des Musters")
        number = int(match.group(1))
        if only and number not in only:
            continue
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"Ausgabe {number}: PDF ist zu groß")
        found.append((number, path))
    found.sort()
    if len({number for number, _ in found}) != len(found):
        raise ValueError("Doppelte Ausgabennummer")
    if only and {number for number, _ in found} != only:
        raise ValueError("Gewählte Ausgabe fehlt")
    return found


def import_one(connection, number, source):
    original_hash = digest(source)
    existing = connection.execute("SELECT sha256 FROM archive_issues WHERE number=?", (number,)).fetchone()
    if existing:
        if existing[0] != original_hash:
            raise ValueError(f"Ausgabe {number}: abweichende Datei bereits archiviert")
        destination = ORIGINALS / source.name
        if not destination.is_file() or digest(destination) != original_hash:
            raise ValueError(f"Ausgabe {number}: archivierte Originaldatei fehlt oder ist beschädigt")
        return "unchanged", 0, []
    native = extract(source)
    pages, state = recognize(source, native)
    low = [page["page"] for page in pages if significant(page["text"]) < 50]
    destination = ORIGINALS / source.name
    copy_original(source, destination, original_hash)
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute("DELETE FROM archive_pages_fts WHERE archive_id=?", (number,))
        connection.executemany(
            "INSERT INTO archive_pages_fts(archive_id,page,number,school_year,period,body) VALUES(?,?,?,?,?,?)",
            [(number, page["page"], str(number), "", "", page["text"]) for page in pages],
        )
        connection.execute(
            "INSERT INTO archive_issues(number,filename,sha256,size_bytes,page_count,low_text_pages,ocr_state,indexed_at) VALUES(?,?,?,?,?,?,?,?)",
            (number, source.name, original_hash, destination.stat().st_size, len(pages), json.dumps(low), state,
             dt.datetime.now(dt.timezone.utc).isoformat()),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return state, len(pages), low


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", type=int, action="append", help="Import only this issue number; repeatable")
    args = parser.parse_args()
    only = set(args.only or [])
    candidates = sources(only)
    if not candidates:
        raise ValueError("Keine PDFs im Eingangsordner")
    ARCHIVE.mkdir(mode=0o700, parents=True, exist_ok=True)
    ORIGINALS.mkdir(mode=0o700, exist_ok=True)
    TEMP.mkdir(mode=0o700, exist_ok=True)
    for path in (ARCHIVE, ORIGINALS, TEMP):
        os.chmod(path, 0o700)
    with prepare_database() as connection:
        counts = {"imported": 0, "unchanged": 0, "pages": 0, "low_text": 0, "ocr_failed": 0}
        for number, source in candidates:
            state, page_count, low = import_one(connection, number, source)
            counts["unchanged" if state == "unchanged" else "imported"] += 1
            counts["pages"] += page_count
            counts["low_text"] += len(low)
            counts["ocr_failed"] += state == "ocr_failed"
            print(f"Ausgabe {number:02d}: {state}, Seiten {page_count}, Textpruefung {len(low)}", flush=True)
        print(json.dumps(counts, sort_keys=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # The error class and a numeric issue are safe; never print file contents.
        print(f"Archivimport fehlgeschlagen: {exc}", flush=True)
        raise SystemExit(1)
