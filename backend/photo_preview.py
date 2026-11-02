#!/usr/bin/env python3
"""Validate an original image and create a metadata-free gallery preview."""
import json
import os
import re
import subprocess
import sys
import tempfile
from PIL import Image, ImageOps, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 50_000_000


def capture_date(path, image):
    try:
        value = image.getexif().get(36867) or image.getexif().get(306)
        if value and re.match(r'^\d{4}:\d{2}:\d{2}', str(value)):
            return str(value)[:10].replace(':', '-')
    except (AttributeError, ValueError, TypeError):
        pass
    try:
        result = subprocess.run(['/usr/bin/exiftool', '-s3', '-d', '%Y-%m-%d', '-DateTimeOriginal', '-CreateDate', path], capture_output=True, timeout=8, check=False)
        if result.returncode == 0:
            for line in result.stdout.decode('utf-8', 'replace').splitlines():
                if re.fullmatch(r'\d{4}-\d{2}-\d{2}', line):
                    return line
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def main(original, preview):
    converted = None
    try:
        with open(original, 'rb') as source:
            prefix = source.read(32)
        brands = (b'heic', b'heix', b'hevc', b'hevx')
        if prefix[4:8] == b'ftyp' and any(prefix[index:index + 4] in brands for index in (8, 16, 20, 24, 28)):
            info = subprocess.run(['/usr/bin/heif-info', original], capture_output=True, timeout=8, check=False)
            dimensions = re.findall(rb'^image: (\d+)x(\d+)', info.stdout, re.MULTILINE)
            if info.returncode != 0 or len(dimensions) != 1 or int(dimensions[0][0]) * int(dimensions[0][1]) > 50_000_000:
                raise ValueError('Invalid HEIC dimensions')
            fd, converted = tempfile.mkstemp(suffix='.png', dir=os.path.dirname(original))
            os.close(fd)
            result = subprocess.run(['/usr/bin/heif-convert', original, converted], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=35, check=False)
            if result.returncode != 0:
                raise ValueError('HEIC decoding failed')
            path = converted
        else:
            path = original
        with Image.open(path) as image:
            if getattr(image, 'n_frames', 1) != 1 or image.width * image.height > 50_000_000:
                raise ValueError('Invalid dimensions or animated image')
            captured = capture_date(original, image)
            image = ImageOps.exif_transpose(image)
            image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            image.convert('RGB').save(preview, 'WEBP', quality=82, method=4)
        os.chmod(preview, 0o600)
        print(json.dumps({'capturedDate': captured}))
    finally:
        if converted:
            try:
                os.unlink(converted)
            except FileNotFoundError:
                pass


if __name__ == '__main__':
    try:
        main(sys.argv[1], sys.argv[2])
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError, subprocess.TimeoutExpired):
        sys.exit(1)
