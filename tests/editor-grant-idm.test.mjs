import test from 'node:test';
import assert from 'node:assert/strict';
import { createCmsStore } from '../backend/cms-store.mjs';
import { createApp } from '../backend/server.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const colleague = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const email = 'melanie@school.example';

test('Ein neues Redaktionsrecht bleibt trotz bekannter lokaler Adresse zunächst ungebunden', async () => {
  const statements = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT email FROM editor_grants')) return [];
      if (sql.startsWith('SELECT COUNT(*) AS n FROM editor_grants')) return [{ n: 0 }];
      if (sql.startsWith('SELECT user_uuid AS userUuid FROM iserv_identities')) return [{ userUuid: colleague }];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });
  assert.equal(await store.addEditorGrant(owner, email), true);
  const insert = statements.find(({ sql }) => sql.startsWith('INSERT INTO editor_grants'));
  assert.equal(insert.params[0], email);
  assert.equal(insert.params[1], null);
});

test('Mehrdeutige bekannte IServ-Adresse wird vor dem Anlegen zurückgewiesen', async () => {
  const statements = [];
  let rolledBack = false;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() { rolledBack = true; }, release() {},
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT email FROM editor_grants')) return [];
      if (sql.startsWith('SELECT COUNT(*) AS n FROM editor_grants')) return [{ n: 0 }];
      if (sql.startsWith('SELECT user_uuid AS userUuid FROM iserv_identities')) return [
        { userUuid: colleague },
        { userUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      ];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });
  await assert.rejects(store.addEditorGrant(owner, email), /IServ-Adresse ist nicht eindeutig/);
  assert.equal(rolledBack, true);
  assert.equal(statements.some(({ sql }) => sql.startsWith('INSERT INTO editor_grants')), false);
});

test('Offenes Redaktionsrecht bindet nur nach aktueller IDM-Bestätigung', async () => {
  let bound = null;
  let pendingBound = null;
  let updates = 0;
  let race = false;
  let audited = 0;
  const marker = '2026-10-28 12:00:00.123456';
  const connection = {
    async beginTransaction() { pendingBound = bound; },
    async commit() { bound = pendingBound; },
    async rollback() { pendingBound = bound; },
    release() {},
    async query(sql, params) {
      if (sql.includes('FROM editor_grants WHERE email = ? FOR UPDATE')) return [{ userUuid: pendingBound, createdAt: marker }];
      if (sql.startsWith('UPDATE editor_grants SET user_uuid')) {
        updates++;
        assert.match(sql, /created_at = \?/);
        assert.equal(params[2], marker);
        if (race) return { affectedRows: 0 };
        pendingBound = params[0];
        return { affectedRows: 1 };
      }
      if (sql.startsWith('INSERT INTO audit_events')) {
        assert.deepEqual(params, [colleague, 'editor.bind', 'editor', null, email]);
        audited++;
        return { affectedRows: 1 };
      }
      if (sql.startsWith('INSERT INTO daily_usage')) return { affectedRows: 1 };
      throw new Error(`Unerwartete Transaktionsabfrage: ${sql}`);
    },
  };
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT email, user_uuid AS userUuid FROM editor_grants')) return [{ email, userUuid: bound }];
      if (sql.startsWith('SELECT DATE_FORMAT(created_at')) return [{ createdAt: marker }];
      throw new Error(`Unerwartete Pool-Abfrage: ${sql}`);
    },
    async getConnection() { return connection; },
  };
  const store = createCmsStore(pool);
  const identity = { uuid: colleague, email };
  assert.equal(await store.hasEditorGrant(identity, async () => false), false);
  assert.equal(updates, 0);
  await assert.rejects(store.hasEditorGrant(identity, async () => { throw new Error('IDM nicht verfügbar'); }), /IDM nicht verfügbar/);
  assert.equal(updates, 0);
  race = true;
  assert.equal(await store.hasEditorGrant(identity, async (uuid, address) => {
    assert.equal(uuid, colleague);
    assert.equal(address, email);
    return true;
  }), false);
  assert.equal(bound, null);
  race = false;
  assert.equal(await store.hasEditorGrant(identity, async () => true), true);
  assert.equal(bound, colleague);
  assert.equal(audited, 1);
  assert.equal(await store.hasEditorGrant({ uuid: colleague, email: null }, async () => false), true);
});

test('Audit-Fehler rollt die erste Redaktionsbindung zurück', async () => {
  const marker = '2026-10-28 12:00:00.123456';
  let bound = null;
  let pendingBound = null;
  let failAudit = true;
  let rolledBack = 0;
  let released = 0;
  const connection = {
    async beginTransaction() { pendingBound = bound; },
    async commit() { bound = pendingBound; },
    async rollback() { pendingBound = bound; rolledBack++; },
    release() { released++; },
    async query(sql, params) {
      if (sql.includes('FROM editor_grants WHERE email = ? FOR UPDATE')) return [{ userUuid: pendingBound, createdAt: marker }];
      if (sql.startsWith('UPDATE editor_grants SET user_uuid')) { pendingBound = params[0]; return { affectedRows: 1 }; }
      if (sql.startsWith('INSERT INTO audit_events')) {
        assert.deepEqual(params, [colleague, 'editor.bind', 'editor', null, email]);
        if (failAudit) throw new Error('Audit nicht verfügbar');
        return { affectedRows: 1 };
      }
      if (sql.startsWith('INSERT INTO daily_usage')) return { affectedRows: 1 };
      throw new Error(`Unerwartete Transaktionsabfrage: ${sql}`);
    },
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith('SELECT email, user_uuid AS userUuid FROM editor_grants')) return [{ email, userUuid: bound }];
      if (sql.startsWith('SELECT DATE_FORMAT(created_at')) return [{ createdAt: marker }];
      throw new Error(`Unerwartete Pool-Abfrage: ${sql}`);
    },
    async getConnection() { return connection; },
  };
  const store = createCmsStore(pool);
  const identity = { uuid: colleague, email };
  await assert.rejects(store.hasEditorGrant(identity, async () => true), /Audit nicht verfügbar/);
  assert.equal(bound, null);
  assert.equal(rolledBack, 1);
  failAudit = false;
  assert.equal(await store.hasEditorGrant(identity, async () => true), true);
  assert.equal(bound, colleague);
  assert.equal(released, 2);
});

test('Ein während der IDM-Prüfung neu angelegtes Redaktionsrecht bleibt ungebunden', async () => {
  const oldMarker = '2026-10-28 12:00:00.123456';
  const newMarker = '2026-10-28 12:01:00.123456';
  let updates = 0;
  let auditEvents = 0;
  let released = false;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() { released = true; },
    async query(sql) {
      if (sql.includes('FROM editor_grants WHERE email = ? FOR UPDATE')) return [{ userUuid: null, createdAt: newMarker }];
      if (sql.startsWith('UPDATE editor_grants SET user_uuid')) updates++;
      if (sql.startsWith('INSERT INTO audit_events')) auditEvents++;
      return { affectedRows: 1 };
    },
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith('SELECT email, user_uuid AS userUuid FROM editor_grants')) return [{ email, userUuid: null }];
      if (sql.startsWith('SELECT DATE_FORMAT(created_at')) return [{ createdAt: oldMarker }];
      throw new Error(`Unerwartete Pool-Abfrage: ${sql}`);
    },
    async getConnection() { return connection; },
  };
  assert.equal(await createCmsStore(pool).hasEditorGrant({ uuid: colleague, email }, async () => true), false);
  assert.equal(updates, 0);
  assert.equal(auditEvents, 0);
  assert.equal(released, true);
});

test('Ohne aktuellen IDM-Verifier wird ein offenes Redaktionsrecht nicht gebunden', async () => {
  let attemptedBinding = false;
  const store = createCmsStore({
    async query(sql) {
      if (sql.startsWith('SELECT email, user_uuid AS userUuid FROM editor_grants')) return [{ email, userUuid: null }];
      attemptedBinding = true;
      return [];
    },
    async getConnection() {
      attemptedBinding = true;
      throw new Error('Keine Bindung erwartet');
    },
  });
  assert.equal(await store.hasEditorGrant({ uuid: colleague, email }), false);
  assert.equal(attemptedBinding, false);
});

test('IDM-Störung lässt die Leser-Anmeldung zu, hält aber das offene Redaktionsrecht zurück', async () => {
  const info = { 'iserv:uuid': colleague, 'iserv:groups': [{ name: 'Kollegium' }], name: 'Melanie Test', email };
  const settings = { clientId: 'test', clientSecret: 'test', auditOwnerUuid: owner, readerGroupName: 'Kollegium' };
  const cases = [
    { verifySubscriberGroup: null, editor: false },
    { verifySubscriberGroup: async () => { throw new Error('IDM nicht verfügbar'); }, editor: false },
    { verifySubscriberGroup: async () => true, editor: true },
  ];
  for (const { verifySubscriberGroup, editor } of cases) {
    let calls = 0;
    const auth = {
      async begin() { return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/oauth/authorize?state=s' }; },
      async complete() { return { subject: 'subject', info, accessToken: 'token', expires: Date.now() + 300000 }; },
      async refresh() { return info; },
    };
    const cmsStore = {
      async hasEditorGrant(identity, verifyPending) {
        calls++;
        assert.equal(typeof verifyPending, 'function');
        return verifyPending(identity.uuid, identity.email);
      },
      async rememberIdentity() {}, async recordAudit() {},
      async homeHighlights() { return { updates: [], issues: [] }; },
    };
    const app = createApp({ settings, getProvider: async () => auth, cmsStore, verifySubscriberGroup });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const start = await fetch(`${base}/bbsinfo/oidc/login`, { redirect: 'manual' });
      const tx = start.headers.getSetCookie()[0].split(';')[0];
      const callback = await fetch(`${base}/bbsinfo/oidc/callback?code=ok&state=s`, { redirect: 'manual', headers: { cookie: tx } });
      assert.equal(callback.status, 303);
      const session = callback.headers.getSetCookie().find((value) => value.startsWith('__Secure-bbsinfo-session=')).split(';')[0];
      const home = await fetch(`${base}/bbsinfo/`, { headers: { cookie: session } });
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.equal(html.includes('Beiträge bearbeiten'), editor);
      assert.ok(calls > 0);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  }
});
