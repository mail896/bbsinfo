import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../backend/server.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const colleague = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const settings = { clientId: 'test', clientSecret: 'test', auditOwnerUuid: owner, readerGroupName: 'Kollegium' };

async function withAccount(uuid, auditGapMarker, work) {
  const info = { 'iserv:uuid': uuid, name: 'Testperson', 'iserv:groups': [{ name: 'Kollegium' }] };
  const cmsStore = {
    async rememberIdentity() {},
    async recordAudit() {},
    async hasEditorGrant() { return false; },
    async listAuditPage() { return { events: [], page: 1, pageCount: 1, through: '' }; },
    async listUsageStats() { return { days: 30, daily: [], topContent: [], searchTerms: [], searchPeople: [], activeUsers: 0, subscriptions: 0 }; },
  };
  const app = createApp({
    settings,
    cmsStore,
    auditGapMarker,
    getProvider: async () => ({
      async begin() { return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/oauth/authorize?state=s' }; },
      async complete() { return { info, subject: 'test', accessToken: 'test', expires: Date.now() + 60_000 }; },
      async refresh() { return info; },
    }),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${app.address().port}`;
  try {
    const start = await fetch(`${endpoint}/bbsinfo/oidc/login`, { redirect: 'manual' });
    assert.equal(start.status, 303);
    const transactionCookie = start.headers.getSetCookie()[0].split(';')[0];
    const callback = await fetch(`${endpoint}/bbsinfo/oidc/callback?code=ok&state=s`, { redirect: 'manual', headers: { cookie: transactionCookie } });
    assert.equal(callback.status, 303);
    const sessionCookie = callback.headers.getSetCookie().find((value) => value.startsWith('__Secure-bbsinfo-session='))?.split(';')[0];
    assert.ok(sessionCookie);
    await work(endpoint, sessionCookie);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

test('dauerhafte Audit-Warnung erscheint nur auf Marcs Audit- und Statistikseiten', async () => {
  let reads = 0;
  const marker = { async read() { reads++; return { occurredAt: '2026-10-28T16:00:00.000Z', category: 'audit.write_failed' }; } };
  await withAccount(owner, marker, async (endpoint, cookie) => {
    for (const route of ['audit/', 'stats/']) {
      const response = await fetch(`${endpoint}/bbsinfo/${route}`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Audit-Erfassung prüfen/);
      assert.match(html, /Ereignisse könnten fehlen/);
    }
  });
  assert.equal(reads, 2);

  reads = 0;
  await withAccount(colleague, marker, async (endpoint, cookie) => {
    for (const route of ['audit/', 'stats/']) {
      const response = await fetch(`${endpoint}/bbsinfo/${route}`, { headers: { cookie } });
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /Audit-Erfassung prüfen/);
    }
  });
  assert.equal(reads, 0);
});

test('unlesbarer privater Audit-Status wird Marc als Prüfhinweis angezeigt', async () => {
  await withAccount(owner, { async read() { throw new Error('secret path'); } }, async (endpoint, cookie) => {
    const response = await fetch(`${endpoint}/bbsinfo/audit/`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Audit-Status nicht prüfbar/);
    assert.doesNotMatch(html, /secret path/);
  });
});
