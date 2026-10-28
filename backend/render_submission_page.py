"""Render one protected PDF page as a sharp, compact WebP image."""
import io
import subprocess
import sys

from PIL import Image


def main():
    path = sys.argv[1]
    page = int(sys.argv[2])
    if not 1 <= page <= 100:
        raise ValueError('Ungültige PDF-Seite')
    rendered = subprocess.run(
        ['/usr/bin/gs', '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m',
         '-dPDFFitPage', '-g2000x2800', f'-dFirstPage={page}', f'-dLastPage={page}',
         '-sOutputFile=-', path],
        capture_output=True, check=True, timeout=12,
    ).stdout
    with Image.open(io.BytesIO(rendered)) as image:
        output = io.BytesIO()
        image.save(output, format='WEBP', quality=94, method=4)
        if output.tell() > 6 * 1024 * 1024:
            raise ValueError('PDF-Vorschau zu groß')
        sys.stdout.buffer.write(output.getvalue())


if __name__ == '__main__':
    main()
