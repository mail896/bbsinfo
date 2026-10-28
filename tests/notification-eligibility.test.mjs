import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverPendingUpdates, deliverVerifiedUpdates } from '../backend/notification-service.mjs';
import { TEST_RECIPIENT } from '../backend/mail.mjs';

const config = { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' };
const userUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const makeStore = (calls) => ({
  async pendingUpdateMail() { calls.push('pending'); return [{ userUuid, email: 'lea@school.example', id: 3, title: 'Bericht' }]; },
  async claimUpdateMail() { calls.push('claim'); return true; },
  async releaseUpdateMail() { calls.push('release'); },
  async finishUpdateMail() { calls.push('finish'); },
});

test('Entzogene Kollegiumsgruppe verhindert Reservierung und Mailversand', async () => {
  const calls = [];
  assert.equal(await deliverPendingUpdates(makeStore(calls), config, 'instant', async () => calls.push('send'), null, async (uuid) => {
    assert.equal(uuid, userUuid);
    calls.push('idm');
    return false;
  }), 0);
  assert.deepEqual(calls, ['pending', 'idm']);
});

test('IDM-Ausfall verhindert Reservierung und Mailversand und bleibt für nächsten Lauf wiederholbar', async () => {
  const calls = [];
  await assert.rejects(() => deliverPendingUpdates(makeStore(calls), config, 'instant', async () => calls.push('send'), null, async () => {
    calls.push('idm');
    throw new Error('IDM nicht erreichbar');
  }), /IDM/);
  assert.deepEqual(calls, ['pending', 'idm']);
});

test('Aktuell berechtigtes Kollegiumsmitglied wird erst nach IDM-Prüfung reserviert und versendet', async () => {
  const calls = [];
  assert.equal(await deliverPendingUpdates(makeStore(calls), config, 'instant', async () => calls.push('send'), null, async () => { calls.push('idm'); return true; }), 1);
  assert.deepEqual(calls, ['pending', 'idm', 'claim', 'send', 'finish']);
});

test('Unklare IDM-Antwort zählt nie als Gruppenfreigabe', async () => {
  const calls = [];
  assert.equal(await deliverPendingUpdates(makeStore(calls), config, 'instant', async () => calls.push('send'), null, async () => undefined), 0);
  assert.deepEqual(calls, ['pending']);
});

test('Entzogene Mitglieder am Anfang einer vollen Auswahl blockieren andere Abos nicht dauerhaft', async () => {
  const revoked = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const eligible = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const scanState = { afterUserUuid: null };
  const calls = [];
  const store = {
    async pendingUpdateMail(_mode, _limit, _cutoff, afterUserUuid) {
      calls.push(['pending', afterUserUuid]);
      if (!afterUserUuid) return Array.from({ length: 50 }, (_, index) => ({ userUuid: revoked, email: 'alt@school.example', id: index + 1, title: 'Alt' }));
      return [{ userUuid: eligible, email: 'neu@school.example', id: 51, title: 'Neu' }];
    },
    async claimUpdateMail(uuid) { calls.push(['claim', uuid]); return true; },
    async releaseUpdateMail(uuid) { calls.push(['release', uuid]); },
    async finishUpdateMail() {},
  };
  const verify = async (uuid) => uuid === eligible;
  const send = async (_config, recipient) => calls.push(['send', recipient]);
  assert.equal(await deliverPendingUpdates(store, config, 'instant', send, null, verify, scanState), 0);
  assert.equal(scanState.afterUserUuid, revoked);
  assert.equal(await deliverPendingUpdates(store, config, 'instant', send, null, verify, scanState), 1);
  assert.equal(scanState.afterUserUuid, null);
  assert.deepEqual(calls.filter(([kind]) => kind === 'send'), [['send', 'neu@school.example']]);
});

test('IDM-Entzug zwischen Reservierung und SMTP gibt Reservierung frei und versendet nicht', async () => {
  const calls = [];
  let check = 0;
  const store = makeStore(calls);
  const verify = async () => { calls.push('idm'); return ++check === 1; };
  assert.equal(await deliverVerifiedUpdates(store, config, 'instant', verify, async () => calls.push('send')), 0);
  assert.deepEqual(calls, ['pending', 'idm', 'claim', 'idm', 'release']);
});

test('IDM-Ausfall zwischen Reservierung und SMTP gibt Reservierung frei und bleibt wiederholbar', async () => {
  const calls = [];
  let check = 0;
  const scanState = { afterUserUuid: null };
  const store = makeStore(calls);
  const verify = async () => { calls.push('idm'); if (++check === 2) throw new Error('IDM unavailable'); return true; };
  await assert.rejects(() => deliverVerifiedUpdates(store, config, 'instant', verify, async () => calls.push('send'), null, scanState), /IDM unavailable/);
  assert.deepEqual(calls, ['pending', 'idm', 'claim', 'idm', 'release']);
  assert.equal(scanState.afterUserUuid, userUuid);
});

test('Produktiver Versand verlangt einen verpflichtenden IDM-Prüfer', async () => {
  const calls = [];
  await assert.rejects(() => deliverVerifiedUpdates(makeStore(calls), config, 'instant', null, async () => calls.push('send')), /IDM-Prüfer/);
  assert.deepEqual(calls, []);
  assert.equal(await deliverVerifiedUpdates(makeStore(calls), config, 'instant', async () => true, async () => calls.push('send')), 1);
  assert.deepEqual(calls, ['pending', 'claim', 'send', 'finish']);
});

test('IDM-Fehler verschiebt den Scan hinter das betroffene Konto; ein anderes Abo bleibt erreichbar', async () => {
  const failing = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const eligible = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const scanState = { afterUserUuid: null };
  const calls = [];
  const store = {
    async pendingUpdateMail(_mode, _limit, _cutoff, afterUserUuid) {
      calls.push(['pending', afterUserUuid]);
      return afterUserUuid ? [{ userUuid: eligible, email: 'neu@school.example', id: 51, title: 'Neu' }]
        : Array.from({ length: 50 }, (_, index) => ({ userUuid: failing, email: 'alt@school.example', id: index + 1, title: 'Alt' }));
    },
    async claimUpdateMail(uuid) { calls.push(['claim', uuid]); return true; },
    async releaseUpdateMail(uuid) { calls.push(['release', uuid]); },
    async finishUpdateMail() {},
  };
  const send = async (_config, recipient) => calls.push(['send', recipient]);
  const verify = async (uuid) => { if (uuid === failing) throw new Error('IDM unavailable'); return true; };
  await assert.rejects(() => deliverVerifiedUpdates(store, config, 'instant', verify, send, null, scanState), /IDM unavailable/);
  assert.equal(scanState.afterUserUuid, failing);
  assert.deepEqual(calls.filter(([kind]) => kind === 'claim' || kind === 'send'), []);
  assert.equal(await deliverVerifiedUpdates(store, config, 'instant', verify, send, null, scanState), 1);
  assert.deepEqual(calls.filter(([kind]) => kind === 'send'), [['send', 'neu@school.example']]);
});
