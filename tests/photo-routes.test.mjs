import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePhotoRoute } from '../backend/photo-routes.mjs';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(path, method = 'GET', identity = { uuid, editor: false, auditOwner: false }) {
  const result = { status: null, html: '', audits: [], deleted: false };
  const store = {
    async getPhotoAlbum() { return { id: 7, title: 'Schulfest', eventDate: '2026-10-01', description: '', photos: [] }; },
    async recordAudit(...args) { result.audits.push(args); },
    async deletePhotoAlbum() { result.deleted = true; return true; },
  };
  const options = {
    req: { method, headers: { origin: 'https://apps.school.example' } },
    res: {}, path, url: new URL(path, 'https://apps.school.example'), identity, csrf: 'valid', cmsStore: store,
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

test('Album-Besuch wird einmal auditiert', async () => {
  const album = fixture('/bbsinfo/photos/albums/7');
  await handlePhotoRoute(album.options);
  assert.equal(album.result.status, 200);
  assert.deepEqual(album.result.audits, [[uuid, 'photo_album.visit', 'photo_album', 7, 'Schulfest']]);
  assert.match(album.result.html, /Schulfest/);
});
