import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIdmGroupVerifier, readIdmCredentials } from '../backend/idm-eligibility.mjs';

const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = { hexUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', group: 'kollegium', name: 'Kollegium', deleted: null };

test('IDM-Zugang bleibt in privater Datei und lehnt offene Dateirechte ab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbsinfo-idm-'));
  const path = join(dir, 'idm-credentials');
  try {
    writeFileSync(path, JSON.stringify({ clientId: 'client', clientSecret: 'secret' }), { mode: 0o600 });
    assert.deepEqual(readIdmCredentials(path), { clientId: 'client', clientSecret: 'secret' });
    chmodSync(path, 0o644);
    assert.throws(() => readIdmCredentials(path), /privat/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('IDM prüft die aktuelle Gruppe für jede Mail neu, ohne Mitgliedschaft zu cachen', async () => {
  let requests = 0;
  let groupReads = 0;
  const fetchMock = async (input, options) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal instanceof AbortSignal, true);
    if (url.pathname.endsWith('/token')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('scope'), 'iserv:idm:api-read');
      assert.equal(options.body.get('grant_type'), 'client_credentials');
      return Response.json({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600, scope: 'iserv:idm:api-read' });
    }
    assert.equal(options.method, 'GET');
    assert.equal(url.href, `https://idm.school.example/iserv/idm/api/v1/users/${user}/groups?_attributes=hexUuid%2Cgroup%2Cname%2Cdeleted`);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    groupReads++;
    return Response.json(groupReads === 1 ? [member] : []);
  };
  const verify = createIdmGroupVerifier({ clientId: 'client', clientSecret: 'secret' }, 'Kollegium', fetchMock);
  assert.equal(await verify(user), true);
  assert.equal(await verify(user), false);
  assert.equal(requests, 3);
  assert.equal(groupReads, 2);
});

test('IDM lehnt gelöschte und fehlerhafte Gruppen, unerwartete Tokens und ungültige UUIDs ab', async () => {
  const credentials = { clientId: 'client', clientSecret: 'secret' };
  const verify = createIdmGroupVerifier(credentials, 'Kollegium', async (input) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/token')
      ? Response.json({ access_token: 'token', expires_in: 3600, scope: 'iserv:idm:api-read' })
      : Response.json([{ ...member, deleted: true }]);
  });
  assert.equal(await verify(user), false);
  await assert.rejects(() => verify('../../groups'), /UUID/);
  const badScope = createIdmGroupVerifier(credentials, 'Kollegium', async () => Response.json({ access_token: 'token', expires_in: 3600, scope: 'iserv:idm:api-write' }));
  await assert.rejects(() => badScope(user), /scope/i);
  const malformed = createIdmGroupVerifier(credentials, 'Kollegium', async (input) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : Response.json({ groups: [member] });
  });
  await assert.rejects(() => malformed(user), /collection/i);
  const malformedAfterMatch = createIdmGroupVerifier(credentials, 'Kollegium', async (input) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : Response.json([member, { name: 'Andere Gruppe' }]);
  });
  await assert.rejects(() => malformedAfterMatch(user), /group/i);
});

test('IDM-Token und Gruppenantwort haben feste Größenlimits', async () => {
  const credentials = { clientId: 'client', clientSecret: 'secret' };
  const hugeToken = createIdmGroupVerifier(credentials, 'Kollegium', async () => new Response('x'.repeat(70000)));
  await assert.rejects(() => hugeToken(user), /large/i);
  const hugeGroups = createIdmGroupVerifier(credentials, 'Kollegium', async (input) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : new Response('x'.repeat(2000001));
  });
  await assert.rejects(() => hugeGroups(user), /large/i);
});

test('Nicht mehr vorhandene IServ-Konten gelten als nicht berechtigt', async () => {
  const verify = createIdmGroupVerifier({ clientId: 'client', clientSecret: 'secret' }, 'Kollegium', async (input) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : new Response('', { status: 404 });
  });
  assert.equal(await verify(user), false);
});

test('IDM-Gruppen ohne expliziten Löschstatus gelten nie als bestätigt', async () => {
  const verify = createIdmGroupVerifier({ clientId: 'client', clientSecret: 'secret' }, 'Kollegium', async (input) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : Response.json([{ hexUuid: member.hexUuid, group: 'kollegium', name: 'Kollegium' }]);
  });
  await assert.rejects(() => verify(user), /group/i);
});
