import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../backend/server.mjs';
import { auditCsv, auditPage } from '../backend/web-pages.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const student = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const settings = { clientId: 'test', clientSecret: 'test', auditOwnerUuid: owner, readerGroupName: 'Kollegium' };

async function withLogin(complete, work, recordAuthFailure = async () => {}) {
  const app = createApp({
    settings,
    getProvider: async () => ({
      async begin() { return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/oauth/authorize?state=s' }; },
      complete,
    }),
    cmsStore: { recordAuthFailure },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${app.address().port}`;
  try {
    const start = await fetch(`${endpoint}/bbsinfo/oidc/login`, { redirect: 'manual' });
    assert.equal(start.status, 303);
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    return await work(endpoint, cookie);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

test('verifizierte Schülergruppe erhält verständliche Ablehnung mit bekannter UUID im Audit', async () => {
  const recorded = [];
  await withLogin(
    async () => ({ info: { 'iserv:uuid': student, uuid: student, 'iserv:groups': [{ name: 'Schüler' }] } }),
    async (endpoint, cookie) => {
      const response = await fetch(`${endpoint}/bbsinfo/oidc/callback?code=secret&state=s`, { headers: { cookie } });
      const html = await response.text();
      assert.equal(response.status, 403);
      assert.match(html, /für Mitglieder des Kollegiums freigeschaltet/);
      assert.doesNotMatch(html, /secret|cccccccc-cccc/);
      assert.equal(response.headers.getSetCookie().some((value) => value.startsWith('__Secure-bbsinfo-session=')), false);
    },
    async (...event) => recorded.push(event),
  );
  assert.deepEqual(recorded, [['auth.identity_denied', student]]);
});

test('widersprüchliche UUID-Claims werden als anonymer Fehler erfasst', async () => {
  const recorded = [];
  await withLogin(
    async () => ({ info: { 'iserv:uuid': student, uuid: owner, 'iserv:groups': [{ name: 'Kollegium' }] } }),
    async (endpoint, cookie) => {
      const response = await fetch(`${endpoint}/bbsinfo/oidc/callback?code=ok&state=s`, { headers: { cookie } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.getSetCookie().some((value) => value.startsWith('__Secure-bbsinfo-session=')), false);
    },
    async (...event) => recorded.push(event),
  );
  assert.deepEqual(recorded, [['auth.identity_denied', null]]);
});

test('IServ access_denied wird ohne unbekannte Person protokolliert und verständlich angezeigt', async () => {
  const recorded = [];
  const cause = Object.assign(new Error('secret'), { name: 'AuthorizationResponseError', error: 'access_denied' });
  const error = Object.assign(new Error('secret', { cause }), { step: 'token' });
  await withLogin(
    async () => { throw error; },
    async (endpoint, cookie) => {
      const response = await fetch(`${endpoint}/bbsinfo/oidc/callback?error=access_denied&state=s`, { headers: { cookie } });
      const html = await response.text();
      assert.equal(response.status, 403);
      assert.match(html, /für das Kollegium freigeschaltet/);
      assert.doesNotMatch(html, /secret|state=s/);
    },
    async (...event) => recorded.push(event),
  );
  assert.deepEqual(recorded, [['auth.access_denied', null]]);
});

test('IServ invalid_request erhält einen hilfreichen Hinweis ohne unbewiesene Schülerdiagnose', async () => {
  const recorded = [];
  const cause = Object.assign(new Error('secret'), { name: 'AuthorizationResponseError', error: 'invalid_request' });
  const error = Object.assign(new Error('secret', { cause }), { step: 'token' });
  await withLogin(
    async () => { throw error; },
    async (endpoint, cookie) => {
      const response = await fetch(`${endpoint}/bbsinfo/oidc/callback?error=invalid_request&state=s`, { headers: { cookie } });
      const html = await response.text();
      assert.equal(response.status, 503);
      assert.match(html, /IServ konnte die Anmeldung nicht abschließen/);
      assert.match(html, /für das Kollegium vorgesehen/);
      assert.doesNotMatch(html, /Schülerkonto|secret|state=s/);
    },
    async (...event) => recorded.push(event),
  );
  assert.deepEqual(recorded, [['auth.oidc_error', null]]);
});

test('ungültiger Callback erzeugt keine frei auslösbaren Auditeinträge', async () => {
  const recorded = [];
  await withLogin(
    async () => { throw new Error('should not run'); },
    async (endpoint) => {
      const response = await fetch(`${endpoint}/bbsinfo/oidc/callback?code=anything`);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /Anmeldung ist abgelaufen/);
    },
    async (...event) => recorded.push(event),
  );
  assert.deepEqual(recorded, []);
});

test('Auditstörung ändert die Ablehnung nicht und gewährt keine Sitzung', async () => {
  await withLogin(
    async () => ({ info: { 'iserv:uuid': student, 'iserv:groups': [{ name: 'Schüler' }] } }),
    async (endpoint, cookie) => {
      const response = await fetch(`${endpoint}/bbsinfo/oidc/callback?code=ok&state=s`, { headers: { cookie } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.getSetCookie().some((value) => value.startsWith('__Secure-bbsinfo-session=')), false);
    },
    async () => { throw new Error('DB unavailable'); },
  );
});

test('Audit-Oberfläche unterscheidet anonyme Anmeldefehler von unbekannten Namen', () => {
  const events = [
    { id: 2, occurredAt: '2026-10-28 16:00:00', actorUuid: null, actorName: null, action: 'auth.oidc_error', objectType: 'auth', objectId: null },
    { id: 1, occurredAt: '2026-10-28 15:00:00', actorUuid: student, actorName: null, action: 'auth.identity_denied', objectType: 'auth', objectId: null },
  ];
  const html = auditPage({ events, page: 1, pageCount: 1, through: '2' });
  assert.match(html, /IServ-Anmeldung fehlgeschlagen/);
  assert.match(html, /Ohne zugeordnete Person/);
  assert.match(html, /Keine BBS-Info-Berechtigung/);
  assert.match(html, /Name noch nicht erfasst/);
  assert.doesNotMatch(html, /cccccccc-cccc/);
  const csv = auditCsv(events);
  assert.match(csv, /"auth.oidc_error","auth","",""/);
  assert.doesNotMatch(csv, /null|undefined/);
});
