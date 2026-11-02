import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { receivePhoto, photoFile, removePhotoFiles } from '../backend/photo-files.mjs';
import { photoAlbumPage, photoDetailPage, photoIndexPage, photoMinePage, photoSetPage } from '../backend/photo-pages.mjs';
import { photoStoreMethods } from '../backend/photo-store.mjs';

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

test('Uploadstatus hat Fortschrittsanzeige und Redaktion sieht jedes Bild nur einmal', () => {
  const mine = photoMinePage([], 'csrf');
  assert.match(mine, /data-photo-upload-progress hidden/);
  assert.match(mine, /href="\/bbsinfo\/photos\/mine" aria-current="page">Meine Fotos<\/a>/);
  assert.match(mine, /href="\/bbsinfo\/contributions\/">Meine Beiträge<\/a>/);
  assert.doesNotMatch(photoIndexPage([], ''), /Bilder einreichen|Einreichungen sichten/);
  const photos = [
    { id: 11, status: 'private', originalName: 'eins.jpg', uploaderName: 'Test Person', capturedDate: null },
    { id: 12, status: 'private', originalName: 'zwei.jpg', uploaderName: 'Test Person', capturedDate: null },
  ];
  const set = { id: 3, title: 'Bilder', status: 'submitted', ownerName: 'Test Person', photos };
  const review = photoSetPage(set, 'csrf', true, false);
  assert.equal((review.match(/preview\.webp/g) || []).length, 2);
  assert.doesNotMatch(review, /class="photo-grid"/);
  assert.match(review, /Bilder für die Library auswählen/);
  const owner = photoSetPage(set, 'csrf', false, true);
  assert.doesNotMatch(owner, /<span>Test Person<\/span>/);
});

test('Albumtitelbild ist redaktionell wählbar und muss zu einem veröffentlichten Bild des Albums gehören', async () => {
  const photos = [
    { id: 11, sequenceNumber: 1, uploaderName: 'Test Person', originalName: 'eins.jpg' },
    { id: 12, sequenceNumber: 2, uploaderName: 'Test Person', originalName: 'zwei.jpg' },
  ];
  const album = { id: 4, title: 'Bilder', description: '', coverPhotoId: 12, photos };
  const html = photoAlbumPage(album, 'csrf', true);
  assert.match(html, /name="coverPhotoId" value="12" checked/);
  assert.doesNotMatch(html, /<span>Test Person<\/span>/);
  assert.doesNotMatch(photoAlbumPage(album, 'csrf', false), /name="coverPhotoId"/);
  let saved = false;
  const conn = { async query(sql, values) {
    if (sql.startsWith('SELECT id, cover_photo_id')) return [{ id: 4, coverPhotoId: null }];
    if (sql.startsWith('SELECT id FROM photo_assets')) return values[0] === 12 && values[1] === 4 ? [{ id: 12 }] : [];
    if (sql.startsWith('UPDATE photo_albums')) { saved = true; return []; }
    throw new Error(`Unerwartete Abfrage: ${sql}`);
  } };
  const store = photoStoreMethods({}, (work) => work(conn), async () => {}, async () => {});
  await assert.rejects(store.editPhotoAlbum(uuid, 4, 'Bilder', '', '', 99), /Titelbild gehört nicht/);
  assert.equal(saved, false);
  assert.equal(await store.editPhotoAlbum(uuid, 4, 'Bilder', '', '', 12), true);
  assert.equal(saved, true);
});

test('Uploadfortschritt zeigt echte Übertragung und erst nach Serverantwort 100 Prozent', async () => {
  const source = await readFile(new URL('../design/web/photos.js', import.meta.url), 'utf8');
  const values = [];
  const messages = [];
  const bar = { set value(value) { values.push(value); } };
  const status = { set textContent(value) { messages.push(value); } };
  const progress = { hidden: true, querySelector: (selector) => selector === 'progress' ? bar : { set textContent(value) {} } };
  const fields = {
    folder: { files: [] }, files: { files: [{ name: 'foto.jpg', size: 100, lastModified: Date.now() }] },
    csrf: { value: 'token' }, title: { value: 'Album' }, eventDate: { value: '' },
  };
  let submit;
  const form = { action: '/bbsinfo/photos/sets/create', elements: { namedItem: (name) => fields[name] },
    querySelector: (selector) => selector === '[data-photo-upload-status]' ? status : selector === '[data-photo-upload-progress]' ? progress : { disabled: false },
    addEventListener: (name, listener) => { if (name === 'submit') submit = listener; } };
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const location = { set href(value) { complete(value); } };
  class UploadRequest {
    constructor() {
      this.uploadHandlers = {};
      this.handlers = {};
      this.upload = { addEventListener: (name, listener) => { this.uploadHandlers[name] = listener; } };
    }
    open() {}
    setRequestHeader() {}
    addEventListener(name, listener) { this.handlers[name] = listener; }
    send() {
      this.uploadHandlers.progress({ lengthComputable: true, loaded: 50, total: 100 });
      this.uploadHandlers.load();
      assert.equal(values.at(-1), 50);
      queueMicrotask(() => {
        this.status = 201;
        this.responseText = '{"capturedDate":"2026-11-02"}';
        this.handlers.load();
      });
    }
  }
  runInNewContext(source, {
    document: { querySelector: (selector) => selector === '[data-photo-upload-form]' ? form : null, addEventListener() {} },
    XMLHttpRequest: UploadRequest, FormData: class { set() {} }, URLSearchParams, location,
    fetch: async () => ({ ok: true, json: async () => ({ id: 7 }) }),
  });
  await submit({ preventDefault() {}, currentTarget: form });
  assert.equal(await done, '/bbsinfo/photos/sets/7');
  assert.equal(progress.hidden, false);
  assert.deepEqual(values, [0, 50, 100]);
  assert(messages.some((message) => message.includes('wird verarbeitet')));
});
