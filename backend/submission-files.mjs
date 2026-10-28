import busboy from 'busboy';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const maxBytes = 10 * 1024 * 1024;
const storedNamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateSubmissionRoot(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Einreichungsordner ist nicht privat.');
  return root;
}

function mediaType(data) {
  if (data.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Nur PDF, JPEG, PNG und WebP sind erlaubt.');
}

export async function parseSubmission(req) {
  if (!req.headers['content-type']?.startsWith('multipart/form-data;') || Number(req.headers['content-length'] || 0) > maxBytes + 10000) throw new Error('Ungültiger oder zu großer Upload.');
  const parser = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 4, parts: 6, fieldSize: 2000, fieldNameSize: 30, headerPairs: 20 } });
  const fields = Object.create(null);
  const chunks = [];
  let fileSeen = false;
  let invalid = false;
  let partCount = 0;
  parser.on('field', (name, value, info) => {
    partCount++;
    if (partCount > 5 || !['csrf', 'title', 'note', 'id'].includes(name) || Object.hasOwn(fields, name) || info.nameTruncated || info.valueTruncated) invalid = true;
    else fields[name] = value;
  });
  parser.on('file', (name, file) => {
    partCount++;
    if (partCount > 5 || name !== 'file' || fileSeen) invalid = true;
    fileSeen = true;
    file.on('data', (chunk) => chunks.push(chunk));
    file.on('limit', () => { invalid = true; });
    file.on('end', () => { if (file.truncated) invalid = true; });
  });
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => { invalid = true; });
  await new Promise((resolve, reject) => {
    parser.once('close', resolve);
    parser.once('error', reject);
    req.once('aborted', () => reject(new Error('Upload abgebrochen.')));
    req.pipe(parser);
  });
  const data = Buffer.concat(chunks);
  if (invalid || !fileSeen || !data.length || !fields.csrf || !fields.title || fields.title.trim().length > 200 || (fields.note || '').length > 1000) throw new Error('Ungültige Einreichung.');
  return { csrf: fields.csrf, id: fields.id || null, title: fields.title, note: fields.note || '', data, mediaType: mediaType(data) };
}

export async function saveSubmissionFile(root, data) {
  validateSubmissionRoot(root);
  if (!Buffer.isBuffer(data) || !data.length || data.length > maxBytes) throw new Error('Ungültige Dateigröße.');
  const storedName = randomUUID();
  await writeFile(join(root, storedName), data, { flag: 'wx', mode: 0o600 });
  return storedName;
}

export async function removeSubmissionFile(root, storedName) {
  if (!storedNamePattern.test(storedName)) throw new Error('Ungültiger Dateiname.');
  await unlink(join(validateSubmissionRoot(root), storedName));
}

export async function getSubmissionFile(root, storedName) {
  if (!storedNamePattern.test(storedName)) throw new Error('Ungültiger Dateiname.');
  const path = join(validateSubmissionRoot(root), storedName);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw new Error('Einreichung nicht verfügbar.');
  return { path, size: stat.size };
}
