import assert from 'node:assert/strict';
import test from 'node:test';
import { createCmsStore } from '../backend/cms-store.mjs';
import { deliverPendingUpdates } from '../backend/notification-service.mjs';
import { auditCsv, auditPage } from '../backend/web-pages.mjs';
import { TEST_RECIPIENT } from '../backend/mail.mjs';

const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mailStore({ failAudit = false } = {}) {
  const calls = [];
  const marker = { async mark(category) { calls.push(['marker', category]); } };
  const connection = {
    async beginTransaction() { calls.push(['begin']); },
    async query(sql, params) {
      calls.push(['query', sql, params]);
      if (sql.startsWith('SELECT u.id, p.display_name AS recipientName')) return [{ id: 3, recipientName: 'Marc Schulz' }];
      if (sql.startsWith('SELECT display_name AS name')) return [{ name: 'Marc Schulz' }];
      if (failAudit && sql.startsWith('INSERT INTO audit_events')) throw new Error('audit unavailable');
      return { affectedRows: 1 };
    },
    async commit() { calls.push(['commit']); },
    async rollback() { calls.push(['rollback']); },
    release() { calls.push(['release']); },
  };
  return { store: createCmsStore({ async getConnection() { return connection; } }, { auditGapMarker: marker }), calls };
}

test('Persönliche Mailreservierung und Audit-Start werden gemeinsam bestätigt', async () => {
  const { store, calls } = mailStore();
  assert.equal(await store.claimUpdateMail(user, [3], 'instant'), true);
  const audit = calls.find(([kind, sql]) => kind === 'query' && sql.startsWith('INSERT INTO audit_events'));
  assert.deepEqual(audit[2], [null, 'update.mail_start', 'subscription', user, 'Marc Schulz']);
  assert.ok(calls.findIndex(([kind, sql]) => kind === 'query' && sql.startsWith('INSERT INTO update_mail_delivery')) < calls.indexOf(audit));
  assert.ok(calls.indexOf(audit) < calls.findIndex(([kind]) => kind === 'commit'));
  assert.equal(calls.filter(([kind]) => kind === 'commit').length, 1);
});

test('Fehlender Audit-Eintrag verwirft die Mailreservierung und markiert die Lücke', async () => {
  const { store, calls } = mailStore({ failAudit: true });
  await assert.rejects(() => store.claimUpdateMail(user, [3], 'instant'), /audit unavailable/);
  assert.equal(calls.filter(([kind]) => kind === 'commit').length, 0);
  assert.equal(calls.filter(([kind]) => kind === 'rollback').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'marker').length, 1);
});

test('SMTP-Annahme und Empfängername werden zusammen mit dem Mailstatus protokolliert', async () => {
  const { store, calls } = mailStore();
  await store.finishUpdateMail(user, [3], true);
  const status = calls.find(([kind, sql]) => kind === 'query' && sql.startsWith('UPDATE update_mail_delivery'));
  assert.deepEqual(status[2], ['sent', user, 3]);
  const audit = calls.find(([kind, sql]) => kind === 'query' && sql.startsWith('INSERT INTO audit_events'));
  assert.deepEqual(audit[2], [null, 'update.mail_sent', 'subscription', user, 'Marc Schulz']);
  assert.ok(calls.indexOf(audit) < calls.findIndex(([kind]) => kind === 'commit'));
});

test('Nicht angenommene SMTP-Mail erhält nur den Status unklar', async () => {
  const { store, calls } = mailStore();
  await store.finishUpdateMail(user, [3], false);
  const status = calls.find(([kind, sql]) => kind === 'query' && sql.startsWith('UPDATE update_mail_delivery'));
  assert.deepEqual(status[2], ['uncertain', user, 3]);
  const audit = calls.find(([kind, sql]) => kind === 'query' && sql.startsWith('INSERT INTO audit_events'));
  assert.equal(audit[2][1], 'update.mail_uncertain');
});

test('Ein Audit-Fehler beim Abschluss setzt den Status nicht ohne Audit fest', async () => {
  const { store, calls } = mailStore({ failAudit: true });
  await assert.rejects(() => store.finishUpdateMail(user, [3], true), /audit unavailable/);
  assert.equal(calls.filter(([kind]) => kind === 'commit').length, 0);
  assert.equal(calls.filter(([kind]) => kind === 'rollback').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'marker').length, 1);
});

test('Nach SMTP-Annahme führt ein Datenbankfehler zu keinem zweiten Abschluss oder Versand', async () => {
  const calls = [];
  const store = {
    async pendingUpdateMail() { calls.push('pending'); return [{ userUuid: user, email: 'admin@school.example', id: 3, title: 'Meldung' }]; },
    async claimUpdateMail() { calls.push('claim'); return true; },
    async finishUpdateMail(_user, _ids, sent) { calls.push(['finish', sent]); throw new Error('database unavailable'); },
  };
  const config = { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' };
  assert.equal(await deliverPendingUpdates(store, config, 'instant', async () => { calls.push('send'); }), 0);
  assert.deepEqual(calls, ['pending', 'claim', 'send', ['finish', true]]);
});

test('Auch nach SMTP- und Abschlussfehler bleibt die Reservierung stehen und es gibt keinen Doppelversand', async () => {
  const calls = [];
  let scans = 0;
  const store = {
    async pendingUpdateMail() {
      calls.push('pending');
      return ++scans === 1 ? [{ userUuid: user, email: 'admin@school.example', id: 3, title: 'Meldung' }] : [];
    },
    async claimUpdateMail() { calls.push('claim'); return true; },
    async finishUpdateMail(_user, _ids, sent) { calls.push(['finish', sent]); throw new Error('private database detail'); },
  };
  const config = { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' };
  const send = async () => { calls.push('send'); throw new Error('private SMTP detail'); };
  assert.equal(await deliverPendingUpdates(store, config, 'instant', send), 0);
  assert.equal(await deliverPendingUpdates(store, config, 'instant', send), 0);
  assert.deepEqual(calls, ['pending', 'claim', 'send', ['finish', false], 'pending']);
});

test('Audit-Oberfläche zeigt den technischen Absender und Empfänger ohne HTML-Ausführung', () => {
  const row = { id: 1, occurredAt: '2026-10-28 13:00:00', actorUuid: null, actorName: null, action: 'update.mail_sent', objectType: 'subscription', objectId: user, objectTitle: 'Marc <script>' };
  const html = auditPage({ events: [row], page: 1, pageCount: 1 });
  assert.match(html, /Persönliche Update-Mail beim Mailserver abgegeben/);
  assert.match(html, /Marc &lt;script&gt;/);
  assert.match(html, /<strong>BBS Info<\/strong>/);
  assert.doesNotMatch(html, /Marc <script>/);
  const csv = auditCsv([row]);
  assert.match(csv, /"BBS Info","","update\.mail_sent"/);
});

test('Personenfilter findet auch den technischen Akteur BBS Info', async () => {
  const queries = [];
  const store = createCmsStore({ async query(sql, params) { queries.push({ sql, params }); return []; } });
  await store.listAuditPage(1, { actor: 'BBS Info' });
  const filtered = queries.find(({ sql }) => sql.includes('update.mail_start'));
  assert.ok(filtered);
  assert.deepEqual(filtered.params.filter((value) => value === 'BBS Info'), ['BBS Info', 'BBS Info']);
});
