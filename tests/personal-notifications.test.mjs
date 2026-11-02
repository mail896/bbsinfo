import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCmsStore } from '../backend/cms-store.mjs';
import { photoStoreMethods } from '../backend/photo-store.mjs';
import { deliverVerifiedUpdates } from '../backend/notification-service.mjs';
import { digestNotice, TEST_RECIPIENT } from '../backend/mail.mjs';
import { handlePhotoRoute } from '../backend/photo-routes.mjs';

const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stored = '11111111-1111-4111-8111-111111111111';

test('Bestehende Update-Abos bleiben beim Opt-in erhalten; Alben beginnen ab dem Opt-in', async () => {
  const calls = [];
  const conn = {
    async beginTransaction() {}, async commit() {}, release() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT mode, notify_updates')) return [{ mode: 'daily', notifyUpdates: 1, notifyAlbums: 0 }];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return conn; } });
  await store.setSubscription(user, { mode: 'daily', notifyUpdates: true, notifyAlbums: true });
  const saved = calls.find(({ sql }) => sql.startsWith('INSERT INTO update_subscriptions'));
  assert.deepEqual(saved.params, [user, true, 'daily', true, true, true, false, true]);
  assert.match(saved.sql, /albums_since = IF\(\?, UTC_TIMESTAMP\(6\), albums_since\)/);
  assert.match(saved.sql, /changed_at = IF\(\?, UTC_TIMESTAMP\(6\), changed_at\)/);
});

test('Auswahl berücksichtigt beide Themen und Tagesfenster in derselben Mailabfrage', async () => {
  let query;
  const store = createCmsStore({ async query(sql, params) { query = { sql, params }; return []; } });
  await store.pendingUpdateMail('daily', 50, '2026-11-02 17:00:00', user);
  assert.match(query.sql, /s\.notify_updates = 1/);
  assert.match(query.sql, /s\.notify_albums = 1 AND s\.albums_since IS NOT NULL/);
  assert.match(query.sql, /n\.published_at >= s\.albums_since/);
  assert.match(query.sql, /photo_album_mail_delivery recent/);
  assert.match(query.sql, /update_mail_delivery recent/);
  assert.equal(query.params.length, 10);
});

test('Redaktion erzeugt für neue und ergänzte Alben je ein Ereignis pro Sichtung', async () => {
  for (const existing of [false, true]) {
    const calls = [];
    const conn = { async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT title, status')) return [{ title: 'Einreichung', status: 'submitted' }];
      if (sql.startsWith('SELECT id FROM photo_assets')) return [{ id: 11 }, { id: 12 }];
      if (sql.startsWith('SELECT id, title FROM photo_albums')) return [{ id: 7, title: 'Schulfest' }];
      if (sql.startsWith('INSERT INTO photo_albums')) return { insertId: 7 };
      if (sql.startsWith('SELECT COALESCE(MAX(sequence_number)')) return [{ n: 0 }];
      return { affectedRows: 1 };
    } };
    const store = photoStoreMethods(null, (work) => work(conn), async () => {}, async () => {});
    assert.equal(await store.reviewPhotoSet(user, 3, ['11', '12'], existing ? 7 : '', 'Schulfest', '', ''), 7);
    const notices = calls.filter(({ sql }) => sql.startsWith('INSERT INTO photo_album_notifications'));
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].params, [7, 3, existing ? 'expanded' : 'new', 2, 'Schulfest']);
  }
});

test('Aktuelles und Albumereignis werden nach zwei IDM-Prüfungen gemeinsam versendet', async () => {
  const calls = [];
  const rows = [
    { userUuid: user, email: 'lea@school.example', kind: 'update', id: 4, title: 'Aktuelles', body: 'Text' },
    { userUuid: user, email: 'lea@school.example', kind: 'album', id: 8, albumId: 3, albumAction: 'expanded', photoCount: 5, title: 'Schulfest' },
  ];
  const store = {
    async pendingUpdateMail() { return rows; },
    async claimUpdateMail(_user, keys) { calls.push(['claim', keys]); return true; },
    async releaseUpdateMail() { throw new Error('unexpected release'); },
    async finishUpdateMail(_user, keys, sent) { calls.push(['finish', keys, sent]); },
  };
  const config = { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' };
  const delivered = await deliverVerifiedUpdates(store, config, 'instant', async () => { calls.push(['idm']); return true; }, async (_config, recipient, items) => { calls.push(['send', recipient, items]); });
  assert.equal(delivered, 2);
  assert.deepEqual(calls.map(([action]) => action), ['idm', 'claim', 'idm', 'send', 'finish']);
  assert.deepEqual(calls[1][1], [4, 'album:8']);
  const notice = digestNotice(rows);
  assert.match(notice.body, /Schulfest\n5 neue Bilder im Album/);
  assert.match(notice.body, /\/bbsinfo\/photos\/albums\/3/);
  assert.doesNotMatch(notice.body, /lea@/);
});

test('Freigegebene Vorschau validiert den Browsercache erst nach erneuter Zugriffsprüfung', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bbsinfo-preview-cache-'));
  try {
    await writeFile(join(root, `${stored}.webp`), Buffer.from('preview'));
    let accessChecks = 0;
    const headers = {};
    const etag = `"photo-${stored}-7"`;
    const res = { setHeader(name, value) { headers[name] = value; }, writeHead(status) { this.status = status; }, end() { this.ended = true; } };
    await handlePhotoRoute({
      req: { method: 'HEAD', headers: { 'if-none-match': etag } }, res,
      path: '/bbsinfo/photos/published/9/preview.webp', url: new URL('https://apps.school.example/bbsinfo/photos/published/9/preview.webp'),
      identity: { uuid: user, editor: false }, csrf: '', photoRoot: root,
      cmsStore: { async getPhotoAsset() { accessChecks++; return { id: 9, status: 'published', storedName: stored, mediaType: 'image/jpeg' }; } },
      send() { throw new Error('unexpected response'); },
    });
    assert.equal(accessChecks, 1);
    assert.equal(res.status, 304);
    assert.equal(headers['Cache-Control'], 'private, no-cache');
    assert.equal(headers.Vary, 'Cookie');
    assert.equal(headers.ETag, etag);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Private Vorschauen sind über die Cache-Route nicht erreichbar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bbsinfo-private-preview-'));
  try {
    await writeFile(join(root, `${stored}.webp`), Buffer.from('preview'));
    const response = { status: null, headers: {} };
    await handlePhotoRoute({
      req: { method: 'HEAD', headers: {} },
      res: { setHeader(name, value) { response.headers[name] = value; }, writeHead(status) { response.status = status; }, end() {} },
      path: '/bbsinfo/photos/published/9/preview.webp', url: new URL('https://apps.school.example/bbsinfo/photos/published/9/preview.webp'),
      identity: { uuid: user, editor: false }, csrf: '', photoRoot: root,
      cmsStore: { async getPhotoAsset() { return { id: 9, status: 'private', storedName: stored, mediaType: 'image/jpeg' }; } },
      send(status) { response.status = status; },
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers['Cache-Control'], undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
