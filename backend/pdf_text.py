"""Bounded text extraction for one private archive PDF. Emits JSON, never file contents to logs."""

import json
import logging
import os
import resource
import stat
import sys

MAX_FILE_BYTES = 30 * 1024 * 1024
MAX_PAGES = 100
MAX_PAGE_TEXT_BYTES = 200 * 1024
MAX_TOTAL_TEXT_BYTES = 1024 * 1024


def main(path):
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    logging.getLogger("pypdf").setLevel(logging.ERROR)

    from pypdf import PdfReader

    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as source:
        size = os.fstat(source.fileno())
        if not stat.S_ISREG(size.st_mode) or size.st_size > MAX_FILE_BYTES:
            raise ValueError("PDF-Datei ist ungültig oder zu groß")
        if source.read(5) != b"%PDF-":
            raise ValueError("Keine PDF-Datei")
        source.seek(0)
        reader = PdfReader(source, strict=False)
        if reader.is_encrypted:
            raise ValueError("Verschlüsseltes PDF kann nicht indiziert werden")
        if not 1 <= len(reader.pages) <= MAX_PAGES:
            raise ValueError("Seitenzahl liegt außerhalb der Grenze")

        pages = []
        total = 0
        for number, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").replace("\x00", "")
            encoded = text.encode("utf-8")
            if len(encoded) > MAX_PAGE_TEXT_BYTES:
                raise ValueError("Zu viel Text auf einer Seite")
            total += len(encoded)
            if total > MAX_TOTAL_TEXT_BYTES:
                raise ValueError("Zu viel Text im PDF")
            pages.append({"page": number, "text": text, "lowText": sum(not char.isspace() for char in text) < 50})
        return {"pages": pages, "pageCount": len(pages), "lowTextPages": [p["page"] for p in pages if p["lowText"]]}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("PDF-Pfad fehlt")
        json.dump(main(sys.argv[1]), sys.stdout, ensure_ascii=False)
    except Exception:
        # Do not echo path, PDF text, parser details or other private content.
        print("PDF-Textextraktion fehlgeschlagen.", file=sys.stderr)
        sys.exit(1)
