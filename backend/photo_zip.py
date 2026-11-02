#!/usr/bin/env python3
"""Write a ZIP of original album files and an attribution manifest to stdout."""
import csv
import io
import json
import os
import re
import sys
import unicodedata
import zipfile


def slug(text):
    folded = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii').lower()
    return re.sub(r'[^a-z0-9]+', '-', folded).strip('-')[:60] or 'album'


def safe_csv(value):
    text = str(value or '')
    return "'" + text if text[:1] in ('=', '+', '-', '@', '\t', '\r') else text


def main():
    payload = json.load(sys.stdin)
    folder = 'bbs-info_' + slug(payload['title'])
    root = payload['root']
    manifest = io.StringIO(newline='')
    writer = csv.writer(manifest, delimiter=';')
    writer.writerow(['Datei', 'Aufnahmedatum', 'Hochgeladen von', 'Originaldatei'])
    with zipfile.ZipFile(sys.stdout.buffer, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for photo in payload['photos']:
            name = photo['name']
            if not re.fullmatch(r'[0-9a-f-]{36}', name):
                raise ValueError('Invalid stored name')
            extension = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic'}[photo['mediaType']]
            sequence = int(photo['sequence'])
            if sequence < 1 or sequence > 999999:
                raise ValueError('Invalid sequence')
            date = photo['date'] or 'ohne-datum'
            filename = f'{sequence:04d}_{date}.{extension}'
            source = os.path.join(root, name)
            archive.write(source, f'{folder}/{filename}')
            writer.writerow([filename, photo['date'] or '', safe_csv(photo['uploader']), safe_csv(photo['originalName'])])
        archive.writestr(f'{folder}/bilder.csv', '\ufeff' + manifest.getvalue())


if __name__ == '__main__':
    main()
