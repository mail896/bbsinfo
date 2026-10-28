import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { dailyCutoffUtc, deliverPendingUpdates, isDailyMailWindow, isWeeklyMailWindow } from '../backend/notification-service.mjs';
import { sendSubscriberDigest, TEST_RECIPIENT } from '../backend/mail.mjs';

test('Wöchentlicher Versand folgt Berliner Montag um 07:00 Uhr auch bei Zeitumstellung', () => {
  assert.equal(isWeeklyMailWindow(Date.parse('2026-10-26T06:00:00Z')), true);
  assert.equal(isWeeklyMailWindow(Date.parse('2026-10-19T05:00:00Z')), true);
  assert.equal(isWeeklyMailWindow(Date.parse('2026-10-26T05:00:00Z')), false);
  assert.equal(isWeeklyMailWindow(Date.parse('2026-10-27T06:00:00Z')), false);
});

test('Täglicher Versand beginnt um 18:00 Uhr Berliner Zeit mit festem Tagesstichtag', () => {
  assert.equal(isDailyMailWindow(Date.parse('2026-10-28T17:00:00Z')), true);
  assert.equal(isDailyMailWindow(Date.parse('2026-10-28T16:59:59Z')), false);
  assert.equal(dailyCutoffUtc(Date.parse('2026-10-28T19:25:00Z')), '2026-10-28 17:00:00');
  assert.equal(dailyCutoffUtc(Date.parse('2026-07-28T20:25:00Z')), '2026-07-28 16:00:00');
  assert.equal(dailyCutoffUtc(Date.parse('2026-03-29T17:25:00Z')), '2026-03-29 16:00:00');
  assert.equal(dailyCutoffUtc(Date.parse('2026-10-25T18:25:00Z')), '2026-10-25 17:00:00');
  assert.throws(() => dailyCutoffUtc(Date.parse('2026-10-28T12:00:00Z')), /Außerhalb/);
});

test('Tägliche Sammelmail übernimmt denselben Stichtag in Abfrage und Versandreservierung', async () => {
  const cutoff = '2026-10-28 17:00:00';
  const config = { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' };
  const calls = [];
  const store = {
    async pendingUpdateMail(mode, limit, at) {
      calls.push({ mode, limit, at });
      return [{ userUuid: 'a', email: 'l.test@school.example', id: 11, title: 'Meldung' }];
    },
    async claimUpdateMail(user, ids, mode, at) { calls.push({ user, ids, mode, at }); return true; },
    async finishUpdateMail(user, ids, sent) { calls.push({ user, ids, sent }); },
  };
  assert.equal(await deliverPendingUpdates(store, config, 'daily', async () => {}, cutoff), 1);
  assert.deepEqual(calls[0], { mode: 'daily', limit: 50, at: cutoff });
  assert.deepEqual(calls[1], { user: 'a', ids: [11], mode: 'daily', at: cutoff });
});

test('Ohne eingerichteten SMTP-Versand werden weder Empfänger abgefragt noch Mails versendet', async () => {
  let called = false;
  const store = { async pendingUpdateMail() { called = true; throw new Error('Empfänger abgefragt'); } };
  const count = await deliverPendingUpdates(store, { deliveryEnabled: false }, 'weekly', async () => { called = true; });
  assert.equal(count, 0);
  assert.equal(called, false);
});

test('Freigegebener Testlauf bündelt offene Beiträge pro Person und verbucht nur angenommene Mails', async () => {
  const previous = process.env.BBSINFO_COLLEGIUM_SEND_ENABLED;
  process.env.BBSINFO_COLLEGIUM_SEND_ENABLED = '1';
  const claims = [];
  const finishes = [];
  const sent = [];
  const store = {
    async pendingUpdateMail() { return [
      { userUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'lea@school.example', id: 3, title: 'Bericht' },
      { userUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'lea@school.example', id: 4, title: 'Projekt' },
    ]; },
    async claimUpdateMail(user, ids, mode) { claims.push({ user, ids, mode }); return true; },
    async finishUpdateMail(user, ids, okay) { finishes.push({ user, ids, okay }); },
  };
  try {
    assert.equal(await deliverPendingUpdates(store, { deliveryEnabled: true, password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' }, 'weekly', async (_config, email, updates) => { sent.push({ email, updates }); }), 2);
    assert.deepEqual(claims[0].ids, [3, 4]);
    assert.equal(claims[0].mode, 'weekly');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, 'lea@school.example');
    assert.equal(finishes[0].okay, true);
  } finally {
    if (previous === undefined) delete process.env.BBSINFO_COLLEGIUM_SEND_ENABLED;
    else process.env.BBSINFO_COLLEGIUM_SEND_ENABLED = previous;
  }
});

test('Persönliche Abos erreichen alle angemeldeten Schuladressen, aber niemals die Sammeladresse', async () => {
  const config = { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' };
  const sent = [];
  const claims = [];
  const store = {
    async pendingUpdateMail(_mode, _limit, cutoff) {
      assert.equal(cutoff, null);
      return [
        { userUuid: 'a', email: 'l.test@school.example', id: 10, title: 'Test' },
        { userUuid: 'b', email: 'staff@school.example', id: 10, title: 'Test' },
        { userUuid: 'c', email: 'andere@school.example', id: 10, title: 'Test' },
      ];
    },
    async claimUpdateMail(user) { claims.push(user); return true; },
    async finishUpdateMail() {},
  };
  assert.equal(await deliverPendingUpdates(store, config, 'instant', async (_config, email) => sent.push(email)), 2);
  assert.deepEqual(sent, ['l.test@school.example', 'andere@school.example']);
  assert.deepEqual(claims, ['a', 'c']);
  await assert.rejects(sendSubscriberDigest(config, 'staff@school.example', [{ id: 10, title: 'Test' }], async () => {}), /gesperrt/);
  await sendSubscriberDigest(config, 'andere@school.example', [{ id: 10, title: 'Test' }], async () => {});
  await assert.rejects(sendSubscriberDigest(config, 'andere@example.com', [{ id: 10, title: 'Test' }], async () => {}), /gesperrt/);
});

test('SMTP-Transport blockiert den Kollegiumsverteiler auch bei allgemeiner Versandfreigabe', () => {
  const script = "import runpy; m=runpy.run_path('backend/smtp_sender.py',run_name='test'); p={'host':'school.example','port':465,'encryption':'ssl','from':'mailer@school.example','to':'staff@school.example','liveAllowed':True,'subject':'Test','body':'Test'}; exec('try:\\n m[\"build_message\"](p)\\n raise AssertionError(\"group allowed\")\\nexcept ValueError:\\n pass'); p['to']='lehrkraft@school.example'; m['build_message'](p)";
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
