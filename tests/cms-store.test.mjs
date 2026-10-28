import assert from 'node:assert/strict';
import test from 'node:test';
import { createCmsStore } from '../backend/cms-store.mjs';

const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('Neue Beiträge und Ausgaben speichern ihren Titel beim Anlegen und Veröffentlichen im Audit', async () => {
  const statements = [];
  let nextIssue = 94;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('INSERT INTO updates')) return { insertId: 7 };
      if (sql.startsWith('INSERT INTO issues')) return { insertId: 8 };
      if (sql.startsWith('SELECT status, title FROM updates')) return [{ status: 'draft', title: 'Beitrag bei Veröffentlichung' }];
      if (sql.startsWith('SELECT status, title FROM issues')) return [{ status: 'draft', title: 'Ausgabe bei Veröffentlichung' }];
      if (sql.startsWith('SELECT next_number AS nextNumber')) return [{ nextNumber: nextIssue++ }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });
  assert.equal(await store.createDraft(actor, 'Neuer Beitrag', 'Text'), 7);
  assert.equal(await store.publishUpdate(actor, 7), true);
  assert.equal(await store.createIssueDraft(actor, 'Neuer Ausgabenentwurf', 'Grußwort', '', '', []), 8);
  assert.equal(await store.publishIssue(actor, 8), 94);
  assert.equal(await store.createAndPublishIssue(actor, 'Direkt veröffentlichte Ausgabe', 'Grußwort', '', '', []), 95);
  const auditRows = statements.filter(({ sql }) => sql.startsWith('INSERT INTO audit_events')).map(({ params }) => params);
  assert.deepEqual(auditRows.map((params) => [params[1], params[3], params[4]]), [
    ['update.create', '7', 'Neuer Beitrag'],
    ['update.publish', '7', 'Beitrag bei Veröffentlichung'],
    ['issue.create', '8', 'Neuer Ausgabenentwurf'],
    ['issue.publish', '94', 'Ausgabe bei Veröffentlichung'],
    ['issue.publish', '95', 'Direkt veröffentlichte Ausgabe'],
  ]);
});

test('Steckbrief-Löschen sperrt die Zeile und entfernt nur eigene offene Einreichungen', async () => {
  const statements = [];
  let row = { ownerUuid: actor, status: 'submitted', title: 'Mein Steckbrief', storedName: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT owner_uuid AS ownerUuid, status, title, stored_name AS storedName')) return row ? [row] : [];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });
  assert.equal(await store.deleteSubmission(actor, 7), row.storedName);
  assert.ok(statements.some(({ sql }) => sql.endsWith('FROM submissions WHERE id = ? FOR UPDATE')));
  assert.ok(statements.some(({ sql }) => sql.startsWith('DELETE FROM submissions')));
  assert.ok(statements.some(({ sql, params }) => sql.startsWith('INSERT INTO audit_events') && params[1] === 'submission.delete' && params[4] === 'Mein Steckbrief'));
  statements.length = 0;
  row = { ...row, status: 'taken_over' };
  assert.equal(await store.deleteSubmission(actor, 7), null);
  assert.equal(statements.some(({ sql }) => sql.startsWith('DELETE FROM submissions')), false);
  statements.length = 0;
  row = { ...row, status: 'submitted', ownerUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  assert.equal(await store.deleteSubmission(actor, 7), null);
  assert.equal(statements.some(({ sql }) => sql.startsWith('DELETE FROM submissions')), false);
});

test('Redaktionsrecht bindet Schuladresse an die erste IServ-UUID und verweigert andere UUIDs', async () => {
  const account = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let bound = null;
  let pendingBound = null;
  const statements = [];
  const marker = '2026-10-28 12:00:00.123456';
  const connection = {
    async beginTransaction() { pendingBound = bound; },
    async commit() { bound = pendingBound; },
    async rollback() { pendingBound = bound; },
    release() {},
    async query(sql, params) {
      statements.push(sql);
      if (sql.includes('FROM editor_grants WHERE email = ? FOR UPDATE')) return [{ userUuid: pendingBound, createdAt: marker }];
      if (sql.startsWith('UPDATE editor_grants SET user_uuid')) { pendingBound = params[0]; return { affectedRows: 1 }; }
      if (sql.startsWith('INSERT INTO audit_events')) {
        assert.deepEqual(params, [account, 'editor.bind', 'editor', null, 'melanie@school.example']);
        return { affectedRows: 1 };
      }
      if (sql.startsWith('INSERT INTO daily_usage')) return { affectedRows: 1 };
      throw new Error(`Unerwartete Transaktionsabfrage: ${sql}`);
    },
  };
  const pool = {
    async query(sql, params) {
      statements.push(sql);
      if (sql.startsWith('SELECT email, user_uuid AS userUuid FROM editor_grants')) return [{ email: 'melanie@school.example', userUuid: bound }];
      if (sql.startsWith('SELECT DATE_FORMAT(created_at')) return [{ createdAt: marker }];
      throw new Error(`Unerwartete Pool-Abfrage: ${sql}`);
    },
    async getConnection() { return connection; },
  };
  const store = createCmsStore(pool);
  assert.equal(await store.hasEditorGrant({ uuid: account, email: 'melanie@school.example' }, async () => true), true);
  assert.equal(bound, account);
  assert.equal(await store.hasEditorGrant({ uuid: other, email: 'melanie@school.example' }), false);
  assert.equal(statements.filter((sql) => sql.startsWith('UPDATE editor_grants')).length, 1);
  assert.equal(statements.filter((sql) => sql.startsWith('INSERT INTO audit_events')).length, 1);
  assert.equal(await store.hasEditorGrant({ uuid: account, email: null }), true);
});

test('Bearbeiten eines veröffentlichten Updates protokolliert den Vorgang ohne neue Textversion', async () => {
  const statements = [];
  let committed = false;
  const connection = {
    async beginTransaction() {},
    async commit() { committed = true; },
    async rollback() {},
    release() {},
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT title, body, body_html')) return [{ title: 'Alter Titel', body: 'Alter Text', bodyHtml: null, status: 'published' }];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });

  assert.equal(await store.editUpdate(actor, 7, 'Neuer Titel', 'Neuer Text', 'published_edit'), true);
  assert.equal(committed, true);
  assert.ok(statements.some(({ sql }) => sql.startsWith('UPDATE updates SET title')));
  assert.ok(statements.some(({ sql, params }) => sql.startsWith('INSERT INTO audit_events') && params[1] === 'update.published_edit' && params[3] === '7' && params[4] === 'Neuer Titel'));
  assert.ok(statements.every(({ sql }) => !sql.includes('update_versions')));
});

test('Bearbeiten einer Ausgabe ersetzt Beitragsstände und Steckbriefe in einer Transaktion', async () => {
  const statements = [];
  let committed = false;
  const connection = {
    async beginTransaction() {},
    async commit() { committed = true; },
    async rollback() {},
    release() {},
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT id FROM issues')) return [{ id: 9 }];
      if (sql.startsWith('SELECT id, update_id AS updateId')) return [{ id: 23, updateId: null, title: 'Früherer Beitrag', body: 'Alter Text', bodyHtml: null }];
      if (sql.startsWith('SELECT id, title, body, body_html AS bodyHtml FROM updates')) return [{ id: 4, title: 'Neuer Beitrag', body: 'Neuer Text', bodyHtml: null }];
      if (sql.startsWith('SELECT id FROM submissions')) return [{ id: 5 }];
      if (sql.startsWith('SELECT contribution_id AS id FROM issue_contributions')) return [];
      if (sql.startsWith('SELECT us.update_id AS updateId')) return [{ updateId: 4, submissionId: 5, position: 1 }];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });

  assert.equal(await store.editPublishedIssue(actor, 93, 'Ausgabe korrigiert', 'Grußwort', 'Oktober 2026', ['4'], ['5'], ['23']), true);
  assert.equal(committed, true);
  assert.equal(statements.filter(({ sql }) => sql.startsWith('INSERT INTO issue_updates')).length, 2);
  assert.equal(statements.filter(({ sql }) => sql.startsWith('INSERT INTO issue_submissions')).length, 1);
  assert.equal(statements.some(({ sql }) => sql.includes('FROM update_submissions')), false);
  assert.ok(statements.some(({ sql, params }) => sql.startsWith('UPDATE issues SET title') && params[3] === 'Oktober 2026'));
  assert.ok(statements.some(({ sql, params }) => sql.startsWith('INSERT INTO audit_events') && params[1] === 'issue.edit' && params[3] === '93' && params[4] === 'Ausgabe korrigiert'));
});

test('Bereits in einer Ausgabe verwendeter Kollegenbeitrag darf erneut übernommen werden', async () => {
  const statements = [];
  let committed = false;
  const connection = {
    async beginTransaction() {},
    async commit() { committed = true; },
    async rollback() {},
    release() {},
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT next_number AS nextNumber')) return [{ nextNumber: 94 }];
      if (sql.startsWith('SELECT number FROM issues')) return [];
      if (sql.startsWith('INSERT INTO issues')) return { insertId: 9 };
      if (sql.startsWith('SELECT c.id, c.title')) return [{ id: 5, title: 'Schulveranstaltung', body: 'Bericht', bodyHtml: null, status: 'taken_over', author: 'Lea Test', usedBefore: 1 }];
      return { affectedRows: 1 };
    },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });
  assert.equal(await store.createAndPublishIssue(actor, 'Zweite Ausgabe', '', '2026/27', '', [], null, [], ['5']), 94);
  assert.equal(committed, true);
  assert.ok(statements.some(({ sql, params }) => sql.startsWith('INSERT INTO issue_contributions') && params[1] === 5));
});

test('Veröffentlichte Ausgabe liest alle Bestandteile aus demselben Datenbankstand', async () => {
  const original = {
    issue: { number: 95, title: 'Alter Titel' },
    updates: [{ snapshotId: 1, title: 'Alter Beitrag' }],
    contributions: [{ contributionId: 2, title: 'Alter Bericht' }],
    attachments: [{ id: 3, title: 'Alter Steckbrief' }],
  };
  const changed = {
    issue: { number: 95, title: 'Neuer Titel' },
    updates: [{ snapshotId: 4, title: 'Neuer Beitrag' }],
    contributions: [{ contributionId: 5, title: 'Neuer Bericht' }],
    attachments: [{ id: 6, title: 'Neuer Steckbrief' }],
  };
  let live = original;
  let snapshot;
  let committed = 0;
  let released = 0;
  const statements = [];
  const read = (sql, data) => {
    if (sql.includes('FROM issues WHERE status =')) return [data.issue];
    if (sql.includes('FROM issue_updates iu')) return data.updates;
    if (sql.includes('FROM issue_contributions ic')) return data.contributions;
    if (sql.includes('FROM issue_submissions isu')) return data.attachments;
    throw new Error(`Unerwartete SQL-Abfrage: ${sql}`);
  };
  const pool = {
    async query(sql) {
      const rows = read(sql, live);
      if (sql.includes('FROM issues WHERE status =')) live = changed;
      return rows;
    },
    async getConnection() {
      return {
        async query(sql) {
          statements.push(sql);
          if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') return {};
          if (sql === 'START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT') { snapshot = live; return {}; }
          const rows = read(sql, snapshot);
          if (sql.includes('FROM issues WHERE status =')) live = changed;
          return rows;
        },
        async commit() { committed++; },
        async rollback() {},
        release() { released++; },
      };
    },
  };

  const issue = await createCmsStore(pool).getPublishedIssue(95);
  assert.equal(issue.title, 'Alter Titel');
  assert.equal(issue.updates[0].title, 'Alter Beitrag');
  assert.equal(issue.contributions[0].title, 'Alter Bericht');
  assert.equal(issue.attachments[0].title, 'Alter Steckbrief');
  assert.equal(statements[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal(statements[1], 'START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');
  assert.equal(committed, 1);
  assert.equal(released, 1);
});

test('Ausgaben-Leseverbindung wird auch bei fehlender Ausgabe und Abfragefehler freigegeben', async () => {
  let releaseCount = 0;
  let rollbackCount = 0;
  let fail = false;
  const pool = {
    async getConnection() {
      return {
        async query(sql) {
          if (sql.startsWith('SELECT number')) {
            if (fail) throw new Error('Abfragefehler');
            return [];
          }
          return {};
        },
        async commit() {},
        async rollback() { rollbackCount++; },
        release() { releaseCount++; },
      };
    },
  };
  const store = createCmsStore(pool);
  assert.equal(await store.getPublishedIssue(95), null);
  assert.equal(releaseCount, 1);
  fail = true;
  await assert.rejects(store.getPublishedIssue(95), /Abfragefehler/);
  assert.equal(releaseCount, 2);
  assert.equal(rollbackCount, 1);
});
