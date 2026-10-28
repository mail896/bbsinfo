import test from 'node:test';
import assert from 'node:assert/strict';
import { createCmsStore, normalizeAuditFilters } from '../backend/cms-store.mjs';
import { auditPage } from '../backend/web-pages.mjs';

test('Audit-Datumsfilter verwenden ganze Berliner Kalendertage auch beim Zeitwechsel', () => {
  const spring = normalizeAuditFilters({ from: '2026-03-29', to: '2026-03-29' });
  assert.equal(spring.fromUtc, '2026-03-28 23:00:00');
  assert.equal(spring.toUtc, '2026-03-29 22:00:00');
  const autumn = normalizeAuditFilters({ from: '2026-10-25', to: '2026-10-25' });
  assert.equal(autumn.fromUtc, '2026-10-24 22:00:00');
  assert.equal(autumn.toUtc, '2026-10-25 23:00:00');
});

test('Audit-Filter verwerfen ungültige Daten und ungebundene Texte', () => {
  for (const filters of [
    { from: '2026-02-30' }, { to: '2026-13-01' },
    { from: '2026-10-29', to: '2026-10-28' },
    { object: 'x'.repeat(101) }, { object: 'BBS\nInfo' },
    { actor: 'x'.repeat(101) }, { action: 'x'.repeat(49) },
  ]) assert.throws(() => normalizeAuditFilters(filters), /Ungültiger Audit/);
});

test('Objekt- und Datumsfilter gelten identisch für Audit-Seite und CSV und bleiben parametrisiert', async () => {
  const statements = [];
  const pool = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT COUNT(*) AS count, MAX(e.id)')) return [{ count: 2, newestId: 91 }];
      return [];
    },
  };
  const store = createCmsStore(pool);
  const filters = { actor: 'Marc', action: 'issue.edit', object: 'BBS Info 94', from: '2026-03-29', to: '2026-03-29' };
  const page = await store.listAuditPage(1, filters);
  assert.equal(page.through, '91');
  assert.equal(page.pageCount, 1);
  await store.listAudit(null, 1000, filters);
  assert.equal(statements.length, 3);
  for (const { sql, params } of statements) {
    assert.match(sql, /e\.occurred_at >= \?/);
    assert.match(sql, /e\.occurred_at < \?/);
    assert.match(sql, /e\.object_id/);
    assert.match(sql, /LEFT JOIN updates u/);
    assert.match(sql, /LEFT JOIN issues draft_issue ON e\.object_type = 'issue' AND e\.action = 'issue\.create' AND draft_issue\.id = e\.object_id/);
    assert.match(sql, /LEFT JOIN issues published_issue ON e\.object_type = 'issue' AND e\.action <> 'issue\.create' AND published_issue\.number = e\.object_id/);
    assert.match(sql, /CONCAT\('BBS Info ', e\.object_id/);
    assert.doesNotMatch(sql, /BBS Info 94|2026-03-29 22:00:00/);
    assert.equal(params.filter((value) => value === 'BBS Info 94').length, 4);
    assert.ok(params.includes('2026-03-28 23:00:00'));
    assert.ok(params.includes('2026-03-29 22:00:00'));
  }
  assert.equal(statements[1].params[0], '91');
  assert.deepEqual(statements[1].params.slice(-2), [51, 0]);
  assert.equal(statements[2].params.at(-1), 1000);
});

test('Audit-Ansicht bewahrt alle Filter beim Blättern und beim CSV-Export', () => {
  const html = auditPage({ events: [], page: 2, pageCount: 3, through: '91' }, { actor: 'Marc', action: 'issue.edit', object: 'BBS Info 94', from: '2026-03-29', to: '2026-03-29' });
  assert.match(html, /name="object" value="BBS Info 94"/);
  assert.match(html, /name="from" value="2026-03-29"/);
  assert.match(html, /name="to" value="2026-03-29"/);
  assert.match(html, /actor=Marc&amp;action=issue\.edit&amp;object=BBS\+Info\+94&amp;from=2026-03-29&amp;to=2026-03-29&amp;page=3&amp;through=91/);
  assert.match(html, /audit\/export\.csv\?actor=Marc&amp;action=issue\.edit&amp;object=BBS\+Info\+94&amp;from=2026-03-29&amp;to=2026-03-29/);
  assert.match(auditPage({ events: [], page: 1, pageCount: 1 }, { object: '<script>' }), /value="&lt;script&gt;"/);
});

test('Audit zeigt Entwürfe ohne öffentliche Ausgabennummer und benennt die erste Redakteursbindung', () => {
  const events = [
    { id: 1, occurredAt: '2026-10-28 12:00:00', actorUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorName: 'Marc Schulz', action: 'issue.create', objectType: 'issue', objectId: '19', objectTitle: 'Erster Titel' },
    { id: 2, occurredAt: '2026-10-28 12:01:00', actorUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorName: 'Marc Schulz', action: 'issue.publish', objectType: 'issue', objectId: '94', objectTitle: 'Neuer Titel' },
    { id: 3, occurredAt: '2026-10-28 12:02:00', actorUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorName: 'Marc Schulz', action: 'editor.bind', objectType: 'editor', objectId: null, objectTitle: 'editor@school.example' },
  ];
  const html = auditPage({ events, page: 1, pageCount: 1 });
  assert.match(html, /Ausgabenentwurf: Erster Titel/);
  assert.doesNotMatch(html, /BBS Info 19/);
  assert.match(html, /BBS Info 94: Neuer Titel/);
  assert.match(html, /Redaktionsrecht an Konto gebunden/);
});
