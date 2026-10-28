import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openArchiveStore } from '../backend/archive-store.mjs';
import { indexArchive } from '../backend/archive-search.mjs';

test('Archivspeicher liest nur vorhandene, reguläre Originaldateien', () => {
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-archive-test-'));
  let store;
  try {
    mkdirSync(join(root, 'originals'));
    mkdirSync(join(root, 'thumbnails'));
    const db = new DatabaseSync(join(root, 'index.sqlite'));
    db.exec(`CREATE TABLE archive_issues (
      number INTEGER PRIMARY KEY, filename TEXT NOT NULL, page_count INTEGER NOT NULL,
      low_text_pages TEXT NOT NULL, school_year TEXT NOT NULL, period TEXT NOT NULL
    )`);
    db.prepare('INSERT INTO archive_issues VALUES(?,?,?,?,?,?)').run(1, 'BBS-Info-01.pdf', 1, '[]', '', '');
    indexArchive(db, 1, { number: 1, schoolYear: '', period: '' }, [{ page: 1, text: 'Schuljahr 2026/27. Nur ein fiktiver Testtext.' }]);
    db.close();
    writeFileSync(join(root, 'originals', 'BBS-Info-01.pdf'), '%PDF-1.4\n');
    writeFileSync(join(root, 'thumbnails', '1.webp'), 'RIFFxxxxWEBP');
    store = openArchiveStore(root);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].schoolYear, '2026/27');
    assert.equal(store.search('fiktiver')[0].archiveId, 1);
    assert.equal(store.pdf(1).filename, 'BBS-Info-01.pdf');
    assert.equal(store.pdf(2), null);
    assert.equal(store.thumbnail(1).size, 12);
    assert.equal(store.thumbnail(2), null);
    unlinkSync(join(root, 'originals', 'BBS-Info-01.pdf'));
    assert.equal(store.pdf(1), null);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
