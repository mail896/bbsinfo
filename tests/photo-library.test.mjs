import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { receivePhoto, photoFile, removePhotoFiles } from '../backend/photo-files.mjs';
import { photoAlbumPage, photoDetailPage } from '../backend/photo-pages.mjs';

const python = '/usr/bin/python3';
const uuid = '00000000-0000-4000-8000-000000000001';

test('Fotooriginal bleibt unverändert, Vorschau enthält keine Metadaten und ungültiger Upload wird entfernt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bbsinfo-photo-test-'));
  try {
    const imagePath = join(root, 'source.jpg');
    const generated = spawnSync(python, ['-c', `from PIL import Image\nim=Image.new('RGB',(120,80),(30,80,120))\ne=Image.Exif(); e[36867]='2026:10:28 12:34:00'\nim.save(${JSON.stringify(imagePath)}, exif=e)`]);
    assert.equal(generated.status, 0);
    const original = await readFile(imagePath);
    const boundary = 'bbsinfo-photo-test-boundary';
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="IMG_1.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([prefix, original, suffix]);
    const request = Readable.from([body]);
    request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    const uploaded = await receivePhoto(request, root, 0);
    assert.equal(uploaded.mediaType, 'image/jpeg');
    assert.equal(uploaded.capturedDate, '2026-10-28');
    assert.deepEqual(await readFile(photoFile(root, uploaded.storedName).path), original);
    const preview = await readFile(photoFile(root, uploaded.storedName, true).path);
    assert.equal(preview.toString('ascii', 0, 4), 'RIFF');
    assert.equal(preview.includes(Buffer.from('2026:10:28')), false);
    await removePhotoFiles(root, uploaded.storedName);
    assert.throws(() => photoFile(root, uploaded.storedName));
    const invalid = Readable.from([Buffer.from('invalid')]);
    invalid.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': '7' };
    await assert.rejects(receivePhoto(invalid, root, 0));
    await assert.rejects(receivePhoto(invalid, root, 1_000_000_000_000), /Foto-Speicher derzeit voll/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ZIP ordnet Originale stabil und nennt Herkunft; Albumausgabe escaped Namen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bbsinfo-zip-test-'));
  try {
    const stored = '11111111-1111-4111-8111-111111111111';
    const path = join(root, stored);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from('original-photo-data'));
    const payload = { root, title: 'Weihnachtsfeier 2026', photos: [{ name: stored, originalName: '=SUM(1,2).jpg', uploader: 'Test Kollegin', date: '2026-12-17', sequence: 1, mediaType: 'image/jpeg' }] };
    const zipped = spawnSync(python, [new URL('../backend/photo_zip.py', import.meta.url).pathname], { input: JSON.stringify(payload) });
    assert.equal(zipped.status, 0);
    const inspected = spawnSync(python, ['-c', 'import io,json,sys,zipfile\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nprint(json.dumps({"names":z.namelist(),"original":z.read(z.namelist()[0]).decode(),"manifest":z.read(z.namelist()[1]).decode("utf-8-sig")}))'], { input: zipped.stdout });
    assert.equal(inspected.status, 0);
    const result = JSON.parse(inspected.stdout.toString());
    assert.deepEqual(result.names, ['bbs-info_weihnachtsfeier-2026/0001_2026-12-17.jpg', 'bbs-info_weihnachtsfeier-2026/bilder.csv']);
    assert.equal(result.original, 'original-photo-data');
    assert.match(result.manifest, /'=SUM\(1,2\)\.jpg/);
    const album = { id: 1, title: '<img src=x>', description: '', eventDate: null, photos: [{ id: 2, uploaderName: '<script>', sequenceNumber: 1 }] };
    assert.doesNotMatch(photoAlbumPage(album, 'csrf', false), /<img src=x>/);
    const photo = { id: 2, albumId: 1, sequenceNumber: 1, uploaderName: '<script>', capturedDate: null, originalName: 'test.jpg' };
    assert.doesNotMatch(photoDetailPage(photo, album, [], 'csrf', { uuid, editor: false }), /<script>/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
