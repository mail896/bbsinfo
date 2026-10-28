import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../backend/server.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const editor = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reader = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function fixture(uuid, audit = async () => {}) {
  const info = { 'iserv:uuid': uuid, 'iserv:groups': [{ name: 'Kollegium' }], name: 'Testkonto' };
  let currentInfo = info;
  const app = createApp({
    settings: { clientId: 'test', clientSecret: 'test', auditOwnerUuid: owner, editorUuids: [editor], readerGroupName: 'Kollegium' },
    getProvider: async () => ({
      async begin() { return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/oauth/authorize?state=s' }; },
      async complete() { return { info, expires: Date.now() + 300000 }; },
      async refresh() { return currentInfo; },
    }),
    cmsStore: {
      recordAudit: audit,
      async rememberIdentity() {},
      async getSubmission() { return { id: 17, ownerUuid: owner }; },
    },
    submissionRoot: '/tmp',
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${app.address().port}`;
  return {
    endpoint,
    revoke() { currentInfo = { ...info, 'iserv:groups': [{ name: 'Schüler' }] }; },
    async login() {
      const start = await fetch(`${endpoint}/bbsinfo/oidc/login`, { redirect: 'manual' });
      const transaction = start.headers.getSetCookie()[0].split(';')[0];
      const callback = await fetch(`${endpoint}/bbsinfo/oidc/callback?code=code-secret&state=s`, { headers: { cookie: transaction }, redirect: 'manual' });
      assert.equal(callback.status, 303);
      return callback.headers.getSetCookie().find((value) => value.startsWith('__Secure-bbsinfo-session=')).split(';')[0];
    },
    async close() { await new Promise((resolve) => app.close(resolve)); },
  };
}

test('nur verifizierte Berechtigungsablehnungen werden mit fester Bereichskennung erfasst', async () => {
  const events = [];
  const app = await fixture(reader, async (...event) => events.push(event));
  try {
    assert.equal((await fetch(`${app.endpoint}/bbsinfo/audit/?secret=ignored`)).status, 401);
    assert.equal((await fetch(`${app.endpoint}/bbsinfo/editor/`)).status, 401);
    assert.equal((await fetch(`${app.endpoint}/bbsinfo/submissions/17/file`)).status, 401);
    assert.deepEqual(events, []);

    const cookie = await app.login();
    events.length = 0;
    const checks = [
      ['/bbsinfo/editor/?token=never-log', 'editor'],
      ['/bbsinfo/editor/issues/', 'editor.issues'],
      ['/bbsinfo/audit/?actor=confidential', 'audit'],
      ['/bbsinfo/audit/export.csv?before=42', 'audit'],
      ['/bbsinfo/stats/?days=90', 'stats'],
      ['/bbsinfo/submissions/17/file', 'submissions'],
    ];
    for (const [route] of checks) assert.equal((await fetch(`${app.endpoint}${route}`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${app.endpoint}/bbsinfo/editor/drafts?token=never-log`, { method: 'POST', headers: { cookie, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=Test' })).status, 403);
    assert.deepEqual(events, [...checks.map(([, section]) => [reader, 'access.denied', 'page', section]), [reader, 'access.denied', 'page', 'editor']]);
    assert.doesNotMatch(JSON.stringify(events), /never-log|confidential|code-secret|17|42/);

    app.revoke();
    assert.equal((await fetch(`${app.endpoint}/bbsinfo/editor/`, { headers: { cookie } })).status, 403);
    assert.equal(events.length, checks.length + 1);
  } finally { await app.close(); }
});

test('Redakteur ohne Audit-Recht wird auch bei Einstellungen erfasst', async () => {
  const events = [];
  const app = await fixture(editor, async (...event) => events.push(event));
  try {
    const cookie = await app.login();
    events.length = 0;
    assert.equal((await fetch(`${app.endpoint}/bbsinfo/editor/drafts`, { method: 'POST', headers: { cookie, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=wrong&title=Test' })).status, 403);
    assert.deepEqual(events, []);
    assert.equal((await fetch(`${app.endpoint}/bbsinfo/editor/settings/?tab=editors`, { headers: { cookie } })).status, 403);
    assert.deepEqual(events, [[editor, 'access.denied', 'page', 'editor']]);
  } finally { await app.close(); }
});

test('Audit-Schreibfehler gewährt keinen Zugriff und zeigt keine Interna', async () => {
  const app = await fixture(reader, async (_actor, action) => { if (action === 'access.denied') throw new Error('secret database path'); });
  try {
    const cookie = await app.login();
    const response = await fetch(`${app.endpoint}/bbsinfo/audit/`, { headers: { cookie } });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /secret database path/);
  } finally { await app.close(); }
});
