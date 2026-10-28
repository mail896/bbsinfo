import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const extractor = fileURLToPath(new URL('./pdf_text.py', import.meta.url));
const wordPattern = /[\p{L}\p{N}]+/gu;

export async function extractPdfText(filePath) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/python3', [extractor, filePath], {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', LC_ALL: 'C.UTF-8' },
    });
    const result = JSON.parse(stdout);
    if (!Array.isArray(result.pages) || result.pages.length !== result.pageCount || result.pages.length > 100) throw new Error('Ungültige Antwort.');
    return result;
  } catch {
    // execFile errors may carry private PDF text or a private file path.
    throw new Error('PDF-Textextraktion fehlgeschlagen.');
  }
}

export function ensureArchiveSearch(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS archive_pages_fts USING fts5(
    archive_id UNINDEXED, page UNINDEXED, number, school_year, period, body,
    tokenize='unicode61 remove_diacritics 2'
  )`);
}

export function indexArchive(db, archiveId, metadata, pages) {
  if (!Number.isSafeInteger(archiveId) || archiveId < 1) throw new Error('Ungültige Archiv-ID.');
  if (!metadata || !Number.isSafeInteger(metadata.number) || metadata.number < 1 || metadata.number > 9999) throw new Error('Ungültige Ausgabennummer.');
  for (const field of ['schoolYear', 'period']) if (typeof metadata[field] !== 'string' || metadata[field].length > 100) throw new Error('Ungültige Archiv-Metadaten.');
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100 || pages.some((p, i) => p.page !== i + 1 || typeof p.text !== 'string' || Buffer.byteLength(p.text) > 200 * 1024)) throw new Error('Ungültige PDF-Seiten.');
  ensureArchiveSearch(db);
  const remove = db.prepare('DELETE FROM archive_pages_fts WHERE archive_id = ?');
  const insert = db.prepare('INSERT INTO archive_pages_fts(archive_id,page,number,school_year,period,body) VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    remove.run(archiveId);
    for (const page of pages) insert.run(archiveId, page.page, String(metadata.number), metadata.schoolYear, metadata.period, page.text);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function removeArchiveIndex(db, archiveId) {
  if (!Number.isSafeInteger(archiveId) || archiveId < 1) throw new Error('Ungültige Archiv-ID.');
  ensureArchiveSearch(db);
  db.prepare('DELETE FROM archive_pages_fts WHERE archive_id = ?').run(archiveId);
}

export function searchArchive(db, query, limit = 30) {
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Ungültige Suche.');
  const words = [...query.matchAll(wordPattern)].map((match) => match[0]).filter((word) => word.length <= 50);
  if (!words.length) return [];
  if (words.length > 6) throw new Error('Zu viele Suchwörter.');
  const match = words.map((word) => `"${word}"`).join(' AND ');
  return db.prepare(`SELECT archive_id AS archiveId, page, number, school_year AS schoolYear, period,
    snippet(archive_pages_fts, 5, '', '', ' … ', 24) AS excerpt
    FROM archive_pages_fts WHERE archive_pages_fts MATCH ?
    ORDER BY bm25(archive_pages_fts) LIMIT ?`).all(match, limit);
}
