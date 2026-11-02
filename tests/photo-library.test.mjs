import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { runInNewContext } from 'node:vm';
import { receivePhoto, photoFile, photoSha256, removePhotoFiles, streamAlbumZip } from '../backend/photo-files.mjs';
import { photoAlbumPage, photoDetailPage, photoIndexPage, photoMinePage, photoSetPage } from '../backend/photo-pages.mjs';
import { home, searchPage } from '../backend/web-pages.mjs';
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
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="IR-Bild Bahnhof Göttingen.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([prefix, original, suffix]);
    const request = Readable.from([body]);
    request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    const uploaded = await receivePhoto(request, root, 0);
    assert.equal(uploaded.originalName, 'IR-Bild Bahnhof Göttingen.jpg');
    assert.equal(uploaded.mediaType, 'image/jpeg');
    assert.equal(uploaded.capturedDate, '2026-10-28');
    assert.equal(uploaded.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(await photoSha256(root, uploaded.storedName), uploaded.sha256);
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

test('Ein Dateisystemfehler beim Foto-Upload wird kontrolliert zurückgegeben', async (context) => {
  if (process.getuid?.() === 0) return context.skip('Root kann auch in schreibgeschützte Testordner schreiben.');
  const root = await mkdtemp(join(tmpdir(), 'bbsinfo-photo-readonly-'));
  const boundary = 'bbsinfo-photo-readonly-boundary';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot-an-image\r\n--${boundary}--\r\n`);
  const request = Readable.from([body]);
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  try {
    await chmod(root, 0o500);
    await assert.rejects(receivePhoto(request, root, 0), /EACCES|EPERM/);
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test('ZIP ordnet Originale stabil und nennt Herkunft; Albumausgabe escaped Namen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bbsinfo-zip-test-'));
  try {
    const stored = '11111111-1111-4111-8111-111111111111';
    const path = join(root, stored);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from('original-photo-data'));
    const zipAlbum = { title: 'Weihnachtsfeier 2026' };
    const photos = [{ storedName: stored, originalName: '=SUM(1,2).jpg', uploaderName: 'Test Kollegin', capturedDate: '2026-12-17', sequenceNumber: 1, mediaType: 'image/jpeg' }];
    const response = new PassThrough();
    const chunks = [];
    response.writeHead = (status, headers) => {
      assert.equal(status, 200);
      assert.equal(headers['Content-Type'], 'application/zip');
      assert.match(headers['Content-Disposition'], /bbs-info_weihnachtsfeier-2026\.zip/);
    };
    response.on('data', (chunk) => chunks.push(chunk));
    await streamAlbumZip(response, root, zipAlbum, photos, 'bbs-info_weihnachtsfeier-2026.zip');
    await finished(response);
    const inspected = spawnSync(python, ['-c', 'import io,json,sys,zipfile\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nprint(json.dumps({"names":z.namelist(),"original":z.read(z.namelist()[0]).decode(),"manifest":z.read(z.namelist()[1]).decode("utf-8-sig")}))'], { input: Buffer.concat(chunks) });
    assert.equal(inspected.status, 0, inspected.stderr?.toString());
    const result = JSON.parse(inspected.stdout.toString());
    assert.deepEqual(result.names, ['bbs-info_weihnachtsfeier-2026/0001_2026-12-17.jpg', 'bbs-info_weihnachtsfeier-2026/bilder.csv']);
    assert.equal(result.original, 'original-photo-data');
    assert.match(result.manifest, /'=SUM\(1,2\)\.jpg/);
    const album = { id: 1, title: '<img src=x>', description: '', eventDate: null, photos: [{ id: 2, uploaderName: '<script>', sequenceNumber: 1 }] };
    assert.doesNotMatch(photoAlbumPage(album, 'csrf', false), /<img src=x>/);
    const gallery = photoAlbumPage({ ...album, photos: Array.from({ length: 7 }, (_, index) => ({ id: index + 1, status: 'published', sequenceNumber: index + 1 })) }, 'csrf', false);
    assert.equal((gallery.match(/loading="eager"/g) || []).length, 6);
    assert.equal((gallery.match(/loading="lazy"/g) || []).length, 1);
    assert.equal((gallery.match(/fetchpriority="high"/g) || []).length, 1);
    const photo = { id: 2, albumId: 1, sequenceNumber: 1, uploaderName: '<script>', capturedDate: null, originalName: 'test.jpg' };
    const readerDetail = photoDetailPage(photo, album, [], 'csrf', { uuid, editor: false });
    assert.doesNotMatch(readerDetail, /<script>/);
    assert.doesNotMatch(readerDetail, /photos\/(date-edit|delete)/);
    assert.match(readerDetail, /<h2>Kommentare<\/h2>/);
    const editorDetail = photoDetailPage(photo, album, [], 'csrf', { uuid, editor: true });
    assert.match(editorDetail, /photo-editor-tools/);
    assert.match(editorDetail, /photos\/date-edit/);
    assert.match(editorDetail, /photos\/delete/);
    assert(editorDetail.indexOf('<h2>Kommentare</h2>') < editorDetail.indexOf('photo-editor-tools'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Uploadstatus hat Fortschrittsanzeige und Redaktion sieht jedes Bild nur einmal', () => {
  const mine = photoMinePage([], 'csrf');
  assert.match(mine, /data-photo-upload-progress hidden/);
  assert.match(mine, /href="\/bbsinfo\/photos\/mine" aria-current="page">Meine Fotos<\/a>/);
  assert.match(mine, /href="\/bbsinfo\/contributions\/">Meine Beiträge<\/a>/);
  assert.doesNotMatch(photoIndexPage({ items: [], page: 1, pageCount: 1, total: 0 }, ''), /Bilder einreichen|Einreichungen sichten/);
  const photos = [
    { id: 11, status: 'private', originalName: 'eins.jpg', uploaderName: 'Test Person', capturedDate: null },
    { id: 12, status: 'private', originalName: 'zwei.jpg', uploaderName: 'Test Person', capturedDate: null },
  ];
  const set = { id: 3, title: 'Bilder', status: 'submitted', ownerName: 'Test Person', photos };
  const review = photoSetPage(set, 'csrf', true, false);
  assert.equal((review.match(/preview\.webp/g) || []).length, 2);
  assert.doesNotMatch(review, /class="photo-grid"/);
  assert.match(review, /Bilder für die Library auswählen/);
  assert.match(review, /Gleiche Titel verbinden Einreichungen nicht automatisch/);
  assert.match(review, /data-photo-review-form/);
  assert.match(review, /data-photo-new-album-fields/);
  assert.match(review, /data-photo-existing-album-note hidden/);
  const owner = photoSetPage(set, 'csrf', false, true);
  assert.doesNotMatch(owner, /<span>Test Person<\/span>/);
});

test('Albumwahl zeigt nur die passenden Angaben und Fotoaktionen teilen einen Farbakzent', async () => {
  const source = await readFile(new URL('../design/web/photos.js', import.meta.url), 'utf8');
  const fields = [{ disabled: false }, { disabled: false }, { disabled: false }];
  const newAlbumFields = { hidden: false, querySelectorAll: () => fields };
  const existingAlbumNote = { hidden: true };
  const album = { value: '', addEventListener(name, listener) { if (name === 'change') this.change = listener; } };
  const form = {
    elements: { namedItem: (name) => name === 'albumId' ? album : null },
    querySelector: (selector) => selector === '[data-photo-new-album-fields]' ? newAlbumFields : existingAlbumNote,
  };
  runInNewContext(source, {
    document: { querySelector: (selector) => selector === '[data-photo-review-form]' ? form : null, addEventListener() {} },
  });
  assert.equal(newAlbumFields.hidden, false);
  assert.equal(existingAlbumNote.hidden, true);
  album.value = '7';
  album.change();
  assert.equal(newAlbumFields.hidden, true);
  assert.equal(existingAlbumNote.hidden, false);
  assert(fields.every((field) => field.disabled));
  album.value = '';
  album.change();
  assert.equal(newAlbumFields.hidden, false);
  assert(fields.every((field) => !field.disabled));

  const start = home({ name: 'Redaktion', editor: true, auditOwner: false }, 'csrf', true, true, true, undefined, null, true);
  assert.match(start, /class="photo-action" href="\/bbsinfo\/photos\/">Fotolibrary/);
  assert.match(start, /class="photo-action" href="\/bbsinfo\/photos\/review">Fotos bearbeiten/);
});

test('Fotolibrary bietet Jahre und Albumseiten; globale Suche verlinkt nur freigegebene Alben', async () => {
  const row = { id: 4, title: 'Rohbau & Umbau', eventDate: '2006-03-23', photoCount: 30, coverId: 12 };
  const html = photoIndexPage({ items: [row], page: 2, pageCount: 3, total: 25 }, 'Rohbau', '2006', [{ year: 2026 }, { year: 2006 }, { year: null }]);
  assert.match(html, /Albumjahr wählen/);
  assert.match(html, /year=2006" aria-current="page">2006/);
  assert.match(html, /Ohne Datum/);
  assert.match(html, /q=Rohbau&amp;year=2006&amp;page=3/);
  assert.match(html, /Rohbau &amp; Umbau/);
  assert.match(html, /loading="eager" fetchpriority="high"/);
  const results = searchPage('Rohbau', { updates: [], issues: [], albums: [row] }, []);
  assert.match(results, /Fotoalben/);
  assert.match(results, /href="\/bbsinfo\/photos\/albums\/4"/);
  assert.doesNotMatch(results, /Keine Treffer gefunden/);
  const calls = [];
  const pool = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('COUNT(*) AS total')) return [{ total: 25 }];
    if (sql.includes('GROUP BY b.id')) return [row];
    throw new Error(`Unerwartete Abfrage: ${sql}`);
  } };
  const store = photoStoreMethods(pool, async () => {}, async () => {}, async () => {});
  const listing = await store.listPhotoAlbumPage('Rohbau', '2006', 2);
  assert.equal(listing.pageCount, 2);
  assert.deepEqual(listing.items, [row]);
  assert.deepEqual(calls[0].values, ['Rohbau', 'Rohbau', '2006-01-01', '2006-12-31']);
  assert.deepEqual(calls[1].values, ['Rohbau', 'Rohbau', '2006-01-01', '2006-12-31', 24, 24]);
  assert.match(calls[0].sql, /a\.status = 'published'/);
  assert.match(calls[1].sql, /a\.status = 'published'/);
  await assert.rejects(store.listPhotoAlbumPage('', '2006 OR 1=1'), /Ungültiges Albumjahr/);
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

test('Fortsetzen gleicht den erneut gewählten Ordner nach Inhalt ab und überträgt nur fehlende Fotos', async () => {
  const source = await readFile(new URL('../design/web/photos.js', import.meta.url), 'utf8');
  const present = Buffer.from('bereits vorhanden');
  const missing = Buffer.from('noch fehlend');
  const files = [
    { name: 'eins.jpg', size: present.length, arrayBuffer: async () => present, lastModified: Date.now() },
    { name: 'zwei.jpg', size: missing.length, arrayBuffer: async () => missing, lastModified: Date.now() },
  ];
  const fields = { folder: { files }, files: { files: [] }, csrf: { value: 'token' } };
  let submit;
  const status = { textContent: '' };
  const progress = { hidden: true, querySelector: (selector) => selector === 'progress' ? { value: 0 } : { textContent: '' } };
  const form = { dataset: { setId: '7' }, elements: { namedItem: (name) => fields[name] },
    querySelector: (selector) => selector === '[data-photo-upload-status]' ? status : selector === '[data-photo-upload-progress]' ? progress : { disabled: false },
    addEventListener: (name, listener) => { if (name === 'submit') submit = listener; } };
  const sent = [];
  let reloaded = false;
  class UploadRequest {
    constructor() { this.handlers = {}; this.upload = { addEventListener() {} }; }
    open() {}
    setRequestHeader() {}
    addEventListener(name, listener) { this.handlers[name] = listener; }
    send(body) {
      sent.push(body.file.name);
      this.status = 201;
      this.responseText = '{}';
      queueMicrotask(() => this.handlers.load());
    }
  }
  runInNewContext(source, {
    document: { querySelector: (selector) => selector === '[data-photo-more-form]' ? form : null, addEventListener() {} },
    XMLHttpRequest: UploadRequest, FormData: class { set(name, file) { this[name] = file; } }, URLSearchParams,
    crypto: webcrypto, location: { reload: () => { reloaded = true; } },
    fetch: async (url, options) => {
      assert.equal(url, '/bbsinfo/photos/sets/7/resume-check');
      assert.equal(options.body.getAll('size').length, 2);
      return { ok: true, json: async () => ({ entries: [{ size: present.length, sha256: createHash('sha256').update(present).digest('hex') }] }) };
    },
  });
  await submit({ preventDefault() {}, currentTarget: form });
  assert.equal(reloaded, true, status.textContent);
  assert.deepEqual(sent, ['zwei.jpg']);
});

test('Server erkennt doppelte Fotos in offener Einreichung auch bei erneuter Übertragung', async () => {
  const calls = [];
  const conn = { async query(sql, values) {
    calls.push(sql);
    if (sql.startsWith('SELECT id FROM photo_sets')) return [{ id: 5 }];
    if (sql.startsWith('SELECT id, stored_name AS storedName')) return [{ id: 12, storedName: '11111111-1111-4111-8111-111111111111' }];
    throw new Error(`Unerwartete Abfrage: ${sql}`);
  } };
  const audits = [];
  const store = photoStoreMethods({}, (work) => work(conn), async (...args) => { audits.push(args); }, async () => {});
  const result = await store.addPhoto(uuid, 5, { storedName: '22222222-2222-4222-8222-222222222222', originalName: 'anders-benannt.jpg', mediaType: 'image/jpeg', byteSize: 123, sha256: 'a'.repeat(64), capturedDate: null }, async (storedName, digest) => {
    assert.equal(storedName, '11111111-1111-4111-8111-111111111111');
    assert.equal(digest, 'a'.repeat(64));
    return true;
  });
  assert.deepEqual(result, { id: 12, duplicate: true });
  assert.equal(calls.some((sql) => sql.startsWith('INSERT INTO photo_assets')), false);
  assert.equal(audits[0][2], 'photo.upload_duplicate');
});

test('Neues Foto bleibt nach Inhaltsprüfung genau einmal in der Einreichung', async () => {
  let inserted = 0;
  const conn = { async query(sql) {
    if (sql.startsWith('SELECT id FROM photo_sets')) return [{ id: 5 }];
    if (sql.startsWith('SELECT id, stored_name AS storedName')) return [{ id: 12, storedName: '11111111-1111-4111-8111-111111111111' }];
    if (sql.startsWith('SELECT COUNT(*) AS count')) return [{ count: 1, bytes: 123 }];
    if (sql.startsWith('INSERT INTO photo_assets')) { inserted++; return { insertId: 13 }; }
    if (sql.startsWith('UPDATE photo_sets')) return [];
    throw new Error(`Unerwartete Abfrage: ${sql}`);
  } };
  const audits = [];
  const store = photoStoreMethods({}, (work) => work(conn), async (...args) => { audits.push(args); }, async () => {});
  const result = await store.addPhoto(uuid, 5, { storedName: '22222222-2222-4222-8222-222222222222', originalName: 'neu.jpg', mediaType: 'image/jpeg', byteSize: 123, sha256: 'b'.repeat(64), capturedDate: null }, async () => false);
  assert.deepEqual(result, { id: 13, duplicate: false });
  assert.equal(inserted, 1);
  assert.equal(audits[0][2], 'photo.upload');
});
