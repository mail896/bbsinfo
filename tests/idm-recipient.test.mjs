import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdmGroupVerifier } from '../backend/idm-eligibility.mjs';
import { deliverVerifiedUpdates } from '../backend/notification-service.mjs';
import { TEST_RECIPIENT } from '../backend/mail.mjs';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const group = { hexUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', group: 'kollegium', name: 'Kollegium', deleted: null };
const email = 'lea@school.example';
const activeUser = { hexUuid: uuid, user: 'lea', emailAddress: email, deleted: null, locked: false };

function verifierWithUser(detail, calls = []) {
  return createIdmGroupVerifier({ clientId: 'client', clientSecret: 'secret' }, 'Kollegium', async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'token', token_type: 'Bearer', expires_in: 3600, scope: 'iserv:idm:api-read' });
    assert.equal(options.headers.Authorization, 'Bearer token');
    calls.push(url);
    if (url.pathname.endsWith('/groups')) {
      assert.equal(url.pathname, `/iserv/idm/api/v1/users/${uuid}/groups`);
      assert.equal(url.searchParams.get('_attributes'), 'hexUuid,group,name,deleted');
      return Response.json([group]);
    }
    assert.equal(url.pathname, `/iserv/idm/api/v1/users/${uuid}`);
    assert.equal(url.searchParams.get('_attributes'), 'hexUuid,user,emailAddress,deleted,locked');
    return Response.json(detail);
  });
}

test('IDM bestätigt vor dem Versand Gruppe und aktuelle Schuladresse derselben UUID', async () => {
  const calls = [];
  const verify = verifierWithUser(activeUser, calls);
  assert.equal(await verify(uuid, email.toUpperCase()), true);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((url) => url.pathname.endsWith('/groups')).length, 1);
});

test('Geänderte oder fremde IDM-Mailadresse sperrt einen bisher gespeicherten Empfänger', async () => {
  for (const current of ['andere@school.example', 'lea@extern.de', null]) {
    const verify = verifierWithUser({ ...activeUser, emailAddress: current });
    assert.notEqual(await verify(uuid, email), true);
  }
});

test('Gesperrte, gelöschte oder andere Benutzer-UUID sperren den Versand', async () => {
  for (const detail of [
    { ...activeUser, locked: true },
    { ...activeUser, deleted: true },
    { ...activeUser, hexUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
  ]) {
    const verify = verifierWithUser(detail);
    assert.notEqual(await verify(uuid, email), true);
  }
});

test('Fehlende oder fehlerhafte IDM-Benutzerfelder ergeben niemals eine Versandfreigabe', async () => {
  for (const key of ['hexUuid', 'user', 'emailAddress', 'deleted', 'locked']) {
    const detail = { ...activeUser };
    delete detail[key];
    const verify = verifierWithUser(detail);
    await assert.rejects(() => verify(uuid, email));
  }
  for (const detail of [{ ...activeUser, locked: null }, { ...activeUser, deleted: 'false' }, [activeUser]]) {
    const verify = verifierWithUser(detail);
    await assert.rejects(() => verify(uuid, email));
  }
});

test('IDM-Benutzerabfrage ohne Erfolg oder mit ungültiger Antwort sperrt den Versand', async () => {
  for (const userResponse of [new Response('', { status: 404 }), new Response('', { status: 503 }), new Response('{broken json', { headers: { 'Content-Type': 'application/json' } })]) {
    const verify = createIdmGroupVerifier({ clientId: 'client', clientSecret: 'secret' }, 'Kollegium', async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/token')) return Response.json({ access_token: 'token', token_type: 'Bearer', expires_in: 3600, scope: 'iserv:idm:api-read' });
      return path.endsWith('/groups') ? Response.json([group]) : userResponse;
    });
    if (userResponse.status === 404) assert.equal(await verify(uuid, email), false);
    else await assert.rejects(() => verify(uuid, email));
  }
});

test('Produktiver Mailpfad gibt die Empfängeradresse bei beiden IDM-Prüfungen weiter', async () => {
  const calls = [];
  const store = {
    async pendingUpdateMail() { return [{ userUuid: uuid, email, id: 3, title: 'Bericht' }]; },
    async claimUpdateMail() { calls.push('claim'); return true; },
    async releaseUpdateMail() { calls.push('release'); },
    async finishUpdateMail() { calls.push('finish'); },
  };
  const seen = [];
  const verify = async (userUuid, recipient) => { seen.push([userUuid, recipient]); return seen.length === 1; };
  const sent = await deliverVerifiedUpdates(store, { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' }, 'instant', verify, async () => calls.push('send'));
  assert.equal(sent, 0);
  assert.deepEqual(seen, [[uuid, email], [uuid, email]]);
  assert.deepEqual(calls, ['claim', 'release']);
});
