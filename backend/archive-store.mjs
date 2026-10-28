import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { searchArchive } from './archive-search.mjs';

const filenamePattern = /^BBS-Info-\d{2,4}\.pdf$/;
const schoolYearPattern = /(?:Schuljahr\s*)?(20\d{2})\s*[/.-]\s*(20\d{2}|\d{2})/i;

function schoolYearFromText(text) {
  const match = schoolYearPattern.exec(text || '');
  if (!match) return '';
  const start = Number(match[1]);
  const end = Number(match[2].slice(-2));
  return end === (start + 1) % 100 ? `${start}/${String(end).padStart(2, '0')}` : '';
}

function regularFile(path, maxBytes) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes ? stat : null;
}

export function openArchiveStore(root) {
  const db = new DatabaseSync(join(root, 'index.sqlite'), { readOnly: true });
  const listStatement = db.prepare(`SELECT number, page_count AS pageCount, low_text_pages AS lowTextPages,
    school_year AS schoolYear, period FROM archive_issues ORDER BY number DESC`);
  const fileStatement = db.prepare('SELECT filename FROM archive_issues WHERE number=?');
  const yearStatement = db.prepare('SELECT body FROM archive_pages_fts WHERE archive_id=? AND page=1 LIMIT 1');
  const issues = listStatement.all().map((row) => ({
    ...row,
    lowTextPages: JSON.parse(row.lowTextPages),
    schoolYear: row.schoolYear || schoolYearFromText(yearStatement.get(row.number)?.body),
  }));
  return {
    list() {
      return issues;
    },
    search(query) {
      return searchArchive(db, query, 50);
    },
    pdf(number) {
      if (!Number.isSafeInteger(number) || number < 1) return null;
      const row = fileStatement.get(number);
      if (!row || !filenamePattern.test(row.filename)) return null;
      const path = join(root, 'originals', row.filename);
      const stat = regularFile(path, 30 * 1024 * 1024);
      if (!stat) return null;
      return { path, filename: row.filename, size: stat.size };
    },
    thumbnail(number) {
      if (!Number.isSafeInteger(number) || number < 1 || !fileStatement.get(number)) return null;
      const path = join(root, 'thumbnails', `${number}.webp`);
      const stat = regularFile(path, 100_000);
      if (!stat) return null;
      return { path, size: stat.size };
    },
    close() { db.close(); },
  };
}
