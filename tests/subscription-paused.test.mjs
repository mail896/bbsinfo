import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMailConfig, TEST_RECIPIENT } from '../backend/mail.mjs';
import { createApp } from '../backend/server.mjs';

test('Abo-Seite und Speicherbestätigung zeigen bei fehlender IDM-Prüfung pausierten Versand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbsinfo-paused-mail-'));
  const path = join(dir, 'mail.json');
  writeFileSync(path, JSON.stringify({
    host: 'school.example', port: 465, encryption: 'ssl', username: 'mailer',
    from: 'mailer@school.example', issueRecipient: 'staff@school.example',
    testRecipient: TEST_RECIPIENT, password: 'test-only',
  }));
  chmodSync(path, 0o600);
  const mailConfig = readMailConfig(path);
  const userUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const info = { 'iserv:uuid': userUuid, 'iserv:groups': [{ name: 'Kollegium' }], name: 'Lea Test', email: 'lea.test@school.example' };
  let mode = 'off';
  const cmsStore = {
    async rememberIdentity() {}, async recordAudit() {},
    async listContentPage() { return { items: [], page: 1, pageCount: 1, hasNext: false }; },
    async subscriptionMode() { return mode; },
    async setSubscription(_uuid, value) { mode = value; },
  };
  const auth = {
    async begin() { return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/oauth/authorize?state=s' }; },
    async complete() { return { subject: 'subject', info, accessToken: 'token', expires: Date.now() + 300000 }; },
    async refresh() { return info; },
  };
  const app = createApp({
    settings: { clientId: 'test', clientSecret: 'test', auditOwnerUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', readerGroupName: 'Kollegium' },
    getProvider: async () => auth, cmsStore, mailConfig, verifySubscriberGroup: null,
  });
  try {
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${app.address().port}`;
    const request = (url, options = {}) => fetch(`${address}${url}`, { redirect: 'manual', ...options });
    const start = await request('/bbsinfo/oidc/login');
    const tx = start.headers.getSetCookie()[0].split(';')[0];
    const callback = await request('/bbsinfo/oidc/callback?code=ok&state=s', { headers: { cookie: tx } });
    assert.equal(callback.status, 303);
    const sid = callback.headers.getSetCookie().find((cookie) => cookie.startsWith('__Secure-bbsinfo-session=')).split(';')[0];
    const initial = await (await request('/bbsinfo/updates/', { headers: { cookie: sid } })).text();
    assert.match(initial, /Persönliche Update-Mails sind derzeit pausiert/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(initial)[1];
    const saved = await request('/bbsinfo/subscribe', {
      method: 'POST',
      headers: { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, mode: 'instant' }),
    });
    assert.equal(saved.status, 303);
    assert.equal(mode, 'instant');
    const after = await (await request('/bbsinfo/updates/', { headers: { cookie: sid } })).text();
    assert.match(after, /Auswahl gespeichert\. Persönliche Update-Mails sind derzeit pausiert/);
    assert.doesNotMatch(after, /Sofortige Update-Mails eingeschaltet/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
