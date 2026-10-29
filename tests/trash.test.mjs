import assert from 'node:assert/strict';
import test from 'node:test';
import { createCmsStore } from '../backend/cms-store.mjs';
import { settingsPage, trashPage } from '../backend/web-pages.mjs';

const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function transactionStore(select) {
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT')) return select(sql, params);
      return { affectedRows: 1 };
    },
  };
  return { calls, pool: { async getConnection() { return conn; } } };
}

test('Gelöschte veröffentlichte Updates behalten Anhänge und Mailstatus und werden beim Wiederherstellen nicht neu versendet', async () => {
  const { calls, pool } = transactionStore((sql) => sql.startsWith('SELECT id, title, status FROM updates') ? [{ id: 7, title: 'Wichtig', status: 'published' }] : []);
  const store = createCmsStore(pool);
  assert.equal(await store.deleteUpdate(actor, 7), true);
  assert.ok(calls.some((call) => call.sql?.includes("mail_suppressed = IF(status = 'published', TRUE, mail_suppressed)")));
  assert.ok(calls.every((call) => !call.sql?.startsWith('DELETE FROM update_submissions') && !call.sql?.startsWith('DELETE FROM updates')));
  assert.ok(calls.some((call) => call.sql?.startsWith('INSERT INTO audit_events') && call.params[1] === 'update.delete'));
  assert.equal(calls.at(-2), 'commit');

  const mailCalls = [];
  const mailStore = createCmsStore({
    async query(sql) { mailCalls.push(sql); return []; },
    async getConnection() { return { ...pool, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, async query(sql) { mailCalls.push(sql); return []; } }; },
  });
  await mailStore.pendingUpdateMail('instant');
  assert.equal(await mailStore.claimUpdateMail(actor, [7], 'instant'), false);
  assert.equal(mailCalls.filter((sql) => sql.includes('mail_suppressed = FALSE')).length, 2);
  assert.equal(mailCalls.filter((sql) => sql.includes('u.deleted_at IS NULL')).length, 2);
});

test('Wiederherstellung prüft Rollen, Eigentum und 30-Tage-Frist in der Transaktion', async () => {
  const { calls, pool } = transactionStore((sql) => sql.startsWith('SELECT title') ? [{ title: 'Privat', number: 94 }] : []);
  const store = createCmsStore(pool);
  await assert.rejects(store.restoreTrash(actor, 'issue', 3, false), /Ungültiger/);
  assert.equal(calls.length, 0);
  assert.equal(await store.restoreTrash(actor, 'contribution', 3, false), true);
  assert.ok(calls.some((call) => call.sql?.includes("owner_uuid = ? AND status = 'submitted' AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY") && call.params[1] === actor));
  assert.equal(await store.restoreTrash(actor, 'contribution', 3, true), true);
  assert.ok(calls.some((call) => call.sql?.includes("FROM contributions WHERE id = ? AND status = 'submitted' AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY") && call.params.length === 1));
  assert.equal(await store.restoreTrash(actor, 'issue', 4, true), true);
  assert.ok(calls.some((call) => call.sql?.startsWith('INSERT INTO audit_events') && call.params[1] === 'issue.restore' && call.params[3] === '94'));
});

test('Redaktion darf nur offene fremde Einreichungen in den Papierkorb verschieben und wiederherstellen', async () => {
  const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { calls, pool } = transactionStore((sql) => {
    if (sql.startsWith('SELECT title FROM contributions')) return sql.includes('owner_uuid = ?') ? [] : [{ title: 'Fremder Beitrag' }];
    if (sql.startsWith('SELECT owner_uuid AS ownerUuid, status, title, stored_name AS storedName FROM submissions')) return [{ ownerUuid: foreign, status: 'submitted', title: 'Fremder Steckbrief', storedName: 'private-file' }];
    return [];
  });
  const store = createCmsStore(pool);
  assert.equal(await store.deleteContribution(actor, 8), false);
  assert.equal(await store.deleteContribution(actor, 8, true), true);
  assert.equal(await store.deleteSubmission(actor, 9), null);
  assert.equal(await store.deleteSubmission(actor, 9, true), 'private-file');
  assert.ok(calls.some((call) => call.sql?.includes("FROM contributions WHERE id = ? AND status = 'submitted' AND deleted_at IS NULL FOR UPDATE") && call.params.length === 1));
  assert.ok(calls.some((call) => call.sql?.startsWith('INSERT INTO audit_events') && call.params[1] === 'contribution.delete'));
  assert.ok(calls.some((call) => call.sql?.startsWith('INSERT INTO audit_events') && call.params[1] === 'submission.delete'));
  await assert.rejects(store.deleteContribution(actor, 8, 'yes'), /Ungültige Redaktionsrolle/);
  await assert.rejects(store.deleteSubmission(actor, 9, 'yes'), /Ungültige Redaktionsrolle/);
});

test('Redaktionspapierkorb lädt Beiträge aller Nutzer mit Text und Eigentümer, persönlicher Papierkorb nur eigene', async () => {
  const queries = [];
  const store = createCmsStore({ async query(sql, params) { queries.push({ sql, params }); return []; } });
  await store.listTrash(actor, true);
  const contributionQuery = queries.find((entry) => entry.sql.includes('FROM contributions c LEFT JOIN'));
  const submissionQuery = queries.find((entry) => entry.sql.includes('FROM submissions s LEFT JOIN'));
  assert.ok(contributionQuery.sql.includes('c.body_html AS bodyHtml') && contributionQuery.sql.includes('p.display_name AS ownerName'));
  assert.ok(!contributionQuery.sql.includes('c.owner_uuid = ?') && !submissionQuery.sql.includes('s.owner_uuid = ?'));
  assert.ok(submissionQuery.sql.includes("s.status IN ('submitted', 'taken_over')"));
  queries.length = 0;
  await store.listTrash(actor, false);
  assert.ok(queries.find((entry) => entry.sql.includes('FROM contributions c LEFT JOIN')).sql.includes('c.owner_uuid = ?'));
  const ownSubmissions = queries.find((entry) => entry.sql.includes('FROM submissions s LEFT JOIN'));
  assert.ok(ownSubmissions.params.includes(actor));
  assert.ok(ownSubmissions.sql.includes("s.status = 'submitted'"));
  queries.length = 0;
  await store.getSubmission(6, true);
  assert.ok(queries[0].sql.includes("status IN ('submitted', 'taken_over') AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY"));
});

test('Übernommene Steckbriefe dürfen nur ohne Update- oder Ausgabenverknüpfung in den Papierkorb', async () => {
  let linked = 1;
  const { calls, pool } = transactionStore((sql) => {
    if (sql.startsWith('SELECT owner_uuid AS ownerUuid, status, title, stored_name AS storedName FROM submissions')) return [{ ownerUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'taken_over', title: 'Profil', storedName: 'private-file' }];
    if (sql.includes('FROM update_submissions WHERE submission_id')) return [{ used: linked }];
    if (sql.startsWith('SELECT title FROM submissions')) return [{ title: 'Profil' }];
    return [];
  });
  const store = createCmsStore(pool);
  assert.equal(await store.deleteSubmission(actor, 7, true), null);
  assert.ok(!calls.some((call) => call.sql?.startsWith('UPDATE submissions SET deleted_at')));
  linked = 0;
  assert.equal(await store.deleteSubmission(actor, 7, true), 'private-file');
  assert.ok(calls.some((call) => call.sql?.includes('EXISTS(SELECT 1 FROM issue_submissions WHERE submission_id = ?)') && call.params[0] === 7 && call.params[1] === 7));
  assert.equal(await store.deleteSubmission(actor, 7, false), null);
  assert.equal(await store.restoreTrash(actor, 'submission', 7, true), true);
  assert.ok(calls.some((call) => call.sql?.includes("FROM submissions WHERE id = ? AND status IN ('submitted', 'taken_over') AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY")));
  await store.restoreTrash(actor, 'submission', 7, false);
  assert.ok(calls.some((call) => call.sql?.includes("FROM submissions WHERE id = ? AND owner_uuid = ? AND status = 'submitted' AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY")));
});

test('Endgültige Bereinigung erhält Ausgabennummer bis zur Löschung und entfernt Steckbriefdatei vor der DB-Zeile', async () => {
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); }, release() {},
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT title, number, status FROM issues')) return [{ title: 'Ausgabe', number: 94, status: 'published' }];
      if (sql.startsWith('SELECT title FROM submissions')) return [{ title: 'Profil' }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    },
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith('SELECT id, title FROM issues')) return [{ id: 5, title: 'Ausgabe' }];
      if (sql.startsWith('SELECT id, title, stored_name AS storedName FROM submissions')) return [{ id: 8, title: 'Profil', storedName: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }];
      return [];
    },
    async getConnection() { return conn; },
  };
  await createCmsStore(pool).pruneTrash(async (name) => calls.push(`file:${name}`));
  const issueDelete = calls.indexOf('DELETE FROM issues WHERE id = ?');
  const numberFree = calls.findIndex((call) => typeof call === 'string' && call.startsWith('UPDATE issue_sequence SET next_number = LEAST'));
  const fileDelete = calls.findIndex((call) => typeof call === 'string' && call.startsWith('file:'));
  const submissionDelete = calls.indexOf('DELETE FROM submissions WHERE id = ?');
  assert.ok(issueDelete >= 0 && numberFree > issueDelete);
  assert.ok(fileDelete >= 0 && submissionDelete > fileDelete);
  assert.ok(calls.some((call) => typeof call === 'string' && call.startsWith('DELETE FROM issue_contributions')));
});

test('Papierkorb zeigt Ausgabe und private Einreichung als Text ohne HTML-Ausführung', () => {
  const trash = { updates: [], issues: [{ id: 4, number: 94, title: '<img src=x>', status: 'published', deletedAtUtc: '2026-10-29 10:00:00' }], contributions: [{ id: 5, title: 'Test', body: '<script>alert(1)</script>', ownerName: 'Frau <Test>', deletedAtUtc: '2026-10-29 10:00:00' }], submissions: [{ id: 6, title: '<script>', ownerName: 'Herr Test', deletedAtUtc: '2026-10-29 10:00:00' }] };
  const html = trashPage(trash, 'csrf', true);
  assert.match(html, /BBS Info 94/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Frau &lt;Test&gt;/);
  assert.match(html, /<summary>Beitrag ansehen<\/summary>/);
  assert.match(html, /href="\/bbsinfo\/trash\/submissions\/6\/file"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /name="kind" value="issue"/);
  const settings = settingsPage({ mailSubject: 'Test', mailBody: '{link}', digestCadence: 'disabled' }, 'csrf', 'trash', [], false, [], trash);
  assert.match(settings, /Papierkorb/);
  assert.match(settings, /BBS Info 94/);
  assert.match(trashPage({ ...trash, page: 2, hasNext: true }, 'csrf', true), /trash\/\?page=3/);
});
