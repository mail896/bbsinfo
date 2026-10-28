import assert from 'node:assert/strict';
import test from 'node:test';
import { createCmsStore } from '../backend/cms-store.mjs';

const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fixture(failure = null, markerFailure = false) {
  const events = [];
  const dbError = new Error('private database failure details');
  const markerError = new Error('private filesystem failure details');
  const conn = {
    async beginTransaction() { events.push('begin'); if (failure === 'begin') throw dbError; },
    async commit() { events.push('commit'); if (failure === 'commit') throw dbError; },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
    async query(sql) {
      if (failure === 'business' && sql.startsWith('SELECT owner_uuid')) throw dbError;
      if (failure === 'audit' && sql.startsWith('INSERT INTO audit_events')) throw dbError;
      if (failure === 'usage' && sql.startsWith('INSERT INTO daily_usage')) throw dbError;
      if (sql.startsWith('SELECT u.id FROM updates')) return [{ id: 7 }];
      return { affectedRows: 1 };
    },
  };
  const marker = {
    async mark(category) {
      events.push(`mark:${category}`);
      if (markerFailure) throw markerError;
    },
  };
  return { store: createCmsStore({ async getConnection() { if (failure === 'acquire') { events.push('acquire'); throw dbError; } return conn; } }, { auditGapMarker: marker }), events, dbError };
}

test('erfolgreicher Audit-Eintrag setzt keinen Lückenmarker', async () => {
  const { store, events } = fixture();
  await store.recordAudit(actor, 'page.view', 'page', 'home');
  assert.deepEqual(events, ['begin', 'commit', 'release']);
});

for (const failure of ['audit', 'usage']) {
  test(`${failure}-Schreibfehler wird nach Rollback dauerhaft als Audit-Lücke markiert`, async () => {
    const { store, events, dbError } = fixture(failure);
    await assert.rejects(store.recordAudit(actor, 'page.view', 'page', 'home'), (error) => error === dbError);
    assert.deepEqual(events, ['begin', 'rollback', 'mark:audit.write_failed', 'release']);
  });
}

test('unsicherer Commit nach Audit-Versuch setzt den Lückenmarker', async () => {
  const { store, events, dbError } = fixture('commit');
  await assert.rejects(store.recordAudit(actor, 'page.view', 'page', 'home'), (error) => error === dbError);
  assert.deepEqual(events, ['begin', 'commit', 'rollback', 'mark:audit.write_failed', 'release']);
});

for (const failure of ['acquire', 'begin']) {
  test(`expliziter Audit-Eintrag markiert fehlgeschlagenen ${failure}-Schritt`, async () => {
    const { store, events, dbError } = fixture(failure);
    await assert.rejects(store.recordAudit(actor, 'page.view', 'page', 'home'), (error) => error === dbError);
    assert.deepEqual(events, failure === 'acquire' ? ['acquire', 'mark:audit.write_failed'] : ['begin', 'rollback', 'mark:audit.write_failed', 'release']);
  });
}

test('anonymer Anmeldefehler markiert einen Verbindungsfehler ebenfalls', async () => {
  const { store, events, dbError } = fixture('acquire');
  await assert.rejects(store.recordAuthFailure('auth.oidc_error'), (error) => error === dbError);
  assert.deepEqual(events, ['acquire', 'mark:audit.write_failed']);
});

test('Geschäftstransaktion markiert einen Verbindungsfehler ohne Auditversuch nicht', async () => {
  const { store, events, dbError } = fixture('acquire');
  await assert.rejects(store.claimUpdateMail(actor, [7], 'instant'), (error) => error === dbError);
  assert.deepEqual(events, ['acquire']);
});

test('Geschäftsabfrage vor Audit-Versuch erzeugt keinen Audit-Lückenmarker', async () => {
  const { store, events, dbError } = fixture('business');
  await assert.rejects(store.deleteSubmission(actor, 7), (error) => error === dbError);
  assert.deepEqual(events, ['begin', 'rollback', 'release']);
});

test('Commit ohne Audit-Versuch erzeugt keinen Audit-Lückenmarker', async () => {
  const { store, events, dbError } = fixture('commit');
  await assert.rejects(store.claimUpdateMail(actor, [7], 'instant'), (error) => error === dbError);
  assert.deepEqual(events, ['begin', 'commit', 'rollback', 'release']);
});

test('Fehler des Markers verdeckt den ursprünglichen Datenbankfehler nicht', async () => {
  const { store, events, dbError } = fixture('audit', true);
  await assert.rejects(store.recordAudit(actor, 'page.view', 'page', 'home'), (error) => error === dbError);
  assert.deepEqual(events, ['begin', 'rollback', 'mark:audit.write_failed', 'release']);
});
