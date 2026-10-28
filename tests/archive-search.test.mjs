import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { extractPdfText, indexArchive, removeArchiveIndex, searchArchive } from '../backend/archive-search.mjs';

test('Archivsuche findet Seiteninhalt und Metadaten, auch ohne Umlaut', () => {
  const db = new DatabaseSync(':memory:');
  try {
    indexArchive(db, 7, { number: 92, schoolYear: '2025/26', period: 'Oktober' }, [
      { page: 1, text: 'Eine fiktive Meldung aus Köln.' },
      { page: 2, text: 'Zweite Seite ohne das Suchwort.' },
    ]);
    assert.deepEqual(searchArchive(db, 'Koln').map((row) => row.page), [1]);
    assert.equal(searchArchive(db, 'Oktober')[0].archiveId, 7);
    assert.equal(searchArchive(db, 'fiktive Köln')[0].page, 1);
    assert.deepEqual(searchArchive(db, 'kein Treffer'), []);
    assert.deepEqual(searchArchive(db, '" OR body:*'), []);
    removeArchiveIndex(db, 7);
    assert.deepEqual(searchArchive(db, 'Koln'), []);
  } finally { db.close(); }
});

test('erneute Indizierung ersetzt den alten Suchstand', () => {
  const db = new DatabaseSync(':memory:');
  try {
    indexArchive(db, 8, { number: 93, schoolYear: '2026/27', period: 'November' }, [{ page: 1, text: 'Alter Text' }]);
    indexArchive(db, 8, { number: 93, schoolYear: '2026/27', period: 'November' }, [{ page: 1, text: 'Neuer Text' }]);
    assert.deepEqual(searchArchive(db, 'Alter'), []);
    assert.equal(searchArchive(db, 'Neuer').length, 1);
  } finally { db.close(); }
});

test('PDF-Extraktor lehnt Nicht-PDF ab, ohne Inhalt auszugeben', async () => {
  await assert.rejects(extractPdfText(new URL('../README.md', import.meta.url).pathname), (error) => {
    assert.equal(error.message, 'PDF-Textextraktion fehlgeschlagen.');
    return true;
  });
});
