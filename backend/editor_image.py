"""Convert a private editor upload or a protected display variant to compact WebP."""
import io
import sys

from PIL import Image, ImageOps, UnidentifiedImageError


def convert(source, max_size):
    with Image.open(source) as original:
        if original.width < 1 or original.height < 1 or original.width * original.height > 50_000_000:
            raise ValueError('Ungültige Bildgröße')
        picture = ImageOps.exif_transpose(original)
        picture.thumbnail(max_size, Image.Resampling.LANCZOS)
        if picture.mode in ('RGBA', 'LA') or 'transparency' in picture.info:
            picture = picture.convert('RGBA')
        else:
            picture = picture.convert('RGB')
        output = io.BytesIO()
        picture.save(output, format='WEBP', quality=86, method=4)
        return output.getvalue()


def main():
    if sys.argv[1] == 'upload':
        data = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
        if not data or len(data) > 3 * 1024 * 1024:
            raise ValueError('Ungültige Dateigröße')
        output = convert(io.BytesIO(data), (1800, 2200))
    elif sys.argv[1] == 'variant':
        width = int(sys.argv[3])
        if width not in (100, 200, 400, 600, 800, 1000, 1200, 1600):
            raise ValueError('Ungültige Vorschaubreite')
        output = convert(sys.argv[2], (width, 2200))
    else:
        raise ValueError('Ungültiger Bildmodus')
    if not output or len(output) > 3 * 1024 * 1024:
        raise ValueError('Optimiertes Bild zu groß')
    sys.stdout.buffer.write(output)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, UnidentifiedImageError) as error:
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
