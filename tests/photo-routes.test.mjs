import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePhotoRoute } from '../backend/photo-routes.mjs';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(path, method = 'GET', identity = { uuid, editor: false, auditOwner: false }) {
  const result = { status: null, html: '', audits: [], deleted: false };
  const store = {
    async getPhotoAlbum() { return { id: 7, title: 'Schulfest', eventDate: '2026-10-01', description: '', photos: [] }; },
    async listPhotoAlbumPage() { return { items: [], page: 1, pageCount: 1, total: 0 }; },
    async listPhotoAlbumYears() { return [{ year: 2026 }]; },
    async recordAudit(...args) { result.audits.push(args); },
    async deletePhotoAlbum() { result.deleted = true; return true; },
  };
  const options = {
    req: { method, headers: { origin: 'https://apps.school.example' } },
    res: {}, path: new URL(path, 'https://apps.school.example').pathname, url: new URL(path, 'https://apps.school.example'), identity, csrf: 'valid', cmsStore: store,
    photoRoot: '/tmp', editorImageRoot: '/tmp', origin: 'https://apps.school.example',
    send(status, html) { result.status = status; result.html = html; },
    redirect() { throw new Error('unexpected redirect'); },
    async readForm() { return new URLSearchParams({ csrf: 'valid', id: '7', confirm: 'yes' }); },
    sameToken(a, b) { return a === b; },
  };
  return { result, options };
}

test('nur Redaktion löscht Alben; nur Audit-Verantwortlicher liest Kommentarverlauf', async () => {
  const deletion = fixture('/bbsinfo/photos/albums/delete', 'POST');
  await handlePhotoRoute(deletion.options);
  assert.equal(deletion.result.status, 403);
  assert.equal(deletion.result.deleted, false);
  const history = fixture('/bbsinfo/photos/comments/3/history');
  await handlePhotoRoute(history.options);
  assert.equal(history.result.status, 403);
});

test('Albumjahr und Seite werden geprüft und die Suche bleibt erhalten', async () => {
  const invalid = fixture('/bbsinfo/photos/?year=2006%20OR%201%3D1');
  await handlePhotoRoute(invalid.options);
  assert.equal(invalid.result.status, 400);
  const requested = fixture('/bbsinfo/photos/?q=Rohbau&year=2006&page=2');
  let args;
  requested.options.cmsStore.listPhotoAlbumPage = async (...values) => {
    args = values;
    return { items: [{ id: 8, title: 'Rohbau', eventDate: '2006-03-23', photoCount: 1, coverId: 9 }], page: 2, pageCount: 2, total: 25 };
  };
  requested.options.cmsStore.listPhotoAlbumYears = async () => [{ year: 2006 }];
  await handlePhotoRoute(requested.options);
  assert.equal(requested.result.status, 200);
  assert.deepEqual(args, ['Rohbau', '2006', 2]);
  assert.match(requested.result.html, /aria-current="page">2006/);
  assert.match(requested.result.html, /href="\/bbsinfo\/photos\/albums\/8"/);
  assert.deepEqual(requested.result.audits, [[uuid, 'photo_album.search', 'photo_album', null]]);
});

test('Album-Besuch wird einmal auditiert', async () => {
  const album = fixture('/bbsinfo/photos/albums/7');
  await handlePhotoRoute(album.options);
  assert.equal(album.result.status, 200);
  assert.deepEqual(album.result.audits, [[uuid, 'photo_album.visit', 'photo_album', 7, 'Schulfest']]);
  assert.match(album.result.html, /Schulfest/);
});

test('nur Redaktion kann ein Albumtitelbild speichern; die Auswahl erreicht die geprüfte Store-Methode', async () => {
  const denied = fixture('/bbsinfo/photos/albums/edit', 'POST');
  await handlePhotoRoute(denied.options);
  assert.equal(denied.result.status, 403);
  const editor = fixture('/bbsinfo/photos/albums/edit', 'POST', { uuid, editor: true, auditOwner: false });
  let saved;
  editor.options.cmsStore.editPhotoAlbum = async (...args) => { saved = args; return true; };
  editor.options.readForm = async () => new URLSearchParams({ csrf: 'valid', id: '7', title: 'Schulfest', eventDate: '', description: '', coverPhotoId: '12' });
  editor.options.redirect = (path) => { editor.result.status = 303; editor.result.path = path; };
  await handlePhotoRoute(editor.options);
  assert.deepEqual(saved, [uuid, '7', 'Schulfest', '', '', '12']);
  assert.equal(editor.result.path, '/bbsinfo/photos/albums/7');
});
