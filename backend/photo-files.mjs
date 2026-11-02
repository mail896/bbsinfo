import busboy from 'busboy';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync, createReadStream, statfsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { validateSubmissionRoot } from './submission-files.mjs';
import { runMediaJob, createMediaLimiter } from './media-jobs.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxBytes = 40 * 1024 * 1024;
const previewScript = fileURLToPath(new URL('./photo_preview.py', import.meta.url));
const zipScript = fileURLToPath(new URL('./photo_zip.py', import.meta.url));
const runPhotoJob = createMediaLimiter({ maxActive: 1, maxQueued: 8, maxWaitMs: 45000 });
const runZipJob = createMediaLimiter({ maxActive: 1, maxQueued: 4, maxWaitMs: 15000 });
const digestCache = new Map();
export const photoPath = (root, name, preview = false) => {
  if (!uuid.test(name)) throw new Error('Ungültiger Fotodateiname.');
  return join(validateSubmissionRoot(root), `${name}${preview ? '.webp' : ''}`);
};
export const photoFile = (root, name, preview = false) => {
  const path = photoPath(root, name, preview);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw new Error('Foto nicht verfügbar.');
  return { path, size: stat.size, mtimeMs: stat.mtimeMs };
};
export async function removePhotoFiles(root, name) {
  for (const preview of [false, true]) try { await unlink(photoPath(root, name, preview)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function prunePhotoFiles(store, root) {
  for (let batch = 0; batch < 10; batch++) {
    const files = await store.expiredPhotoFiles();
    if (!files.length) break;
    for (const file of files) await store.purgeExpiredPhoto(file.id, (name) => removePhotoFiles(root, name));
  }
}
export async function photoSha256(root, name) {
  const file = photoFile(root, name);
  const cached = digestCache.get(file.path);
  if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.value;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file.path)) hash.update(chunk);
  const value = hash.digest('hex');
  digestCache.delete(file.path);
  digestCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, value });
  if (digestCache.size > 1000) digestCache.delete(digestCache.keys().next().value);
  return value;
}
function mediaType(prefix) {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return 'image/jpeg';
  if (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (prefix.toString('ascii', 4, 8) === 'ftyp' && [8, 16, 20, 24, 28].some((offset) => /^(heic|heix|hevc|hevx)$/.test(prefix.toString('ascii', offset, offset + 4)))) return 'image/heic';
  throw new Error('Nur JPEG, PNG, WebP und HEIC sind erlaubt.');
}
export async function receivePhoto(req, root, minFreeBytes = 10 * 1024 * 1024 * 1024) {
  validateSubmissionRoot(root);
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw new Error('Ungültige Speichergrenze.');
  const space = statfsSync(root);
  if (Number(space.bavail) * Number(space.bsize) < minFreeBytes + maxBytes) throw new Error('Foto-Speicher derzeit voll.');
  if (!req.headers['content-type']?.startsWith('multipart/form-data;') || Number(req.headers['content-length'] || 0) > maxBytes + 10000) throw new Error('Ungültiger Foto-Upload.');
  const parser = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 0, fileSize: maxBytes, parts: 2, headerPairs: 20 } });
  const name = randomUUID();
  const path = photoPath(root, name);
  let originalName = '', size = 0, prefix = Buffer.alloc(0), seen = false, invalid = false, fileDone = Promise.resolve();
  const hash = createHash('sha256');
  parser.on('file', (field, stream, info) => {
    if (seen || field !== 'file' || !info.filename) invalid = true;
    seen = true;
    originalName = info.filename;
    const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    fileDone = pipeline(stream, new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new Error('Foto zu groß.'));
        hash.update(chunk);
        if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
        done(null, chunk);
      },
    }), out).then(() => { if (stream.truncated) invalid = true; });
    // The parser may finish later; keep an immediate rejection handler on the file job.
    fileDone.catch(() => {});
  });
  parser.on('field', () => { invalid = true; });
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => { invalid = true; });
  try {
    await new Promise((resolve, reject) => {
      parser.once('close', resolve);
      parser.once('error', reject);
      req.once('aborted', () => reject(new Error('Upload abgebrochen.')));
      req.pipe(parser);
    });
    await fileDone;
    if (!seen || invalid || !size) throw new Error('Ungültiger Foto-Upload.');
    const type = mediaType(prefix);
    const metadata = await runPhotoJob(() => runMediaJob(() => new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/python3', [previewScript, path, photoPath(root, name, true)], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      let length = 0;
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 45000);
      child.stdout.on('data', (chunk) => { length += chunk.length; if (length > 2048) child.kill('SIGKILL'); else chunks.push(chunk); });
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error('Bild konnte nicht verarbeitet werden.'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Bildmetadaten fehlen.')); }
      });
    })));
    return { storedName: name, originalName, mediaType: type, byteSize: size, sha256: hash.digest('hex'), capturedDate: metadata.capturedDate || null };
  } catch (error) {
    try { await fileDone; } catch { /* preserve original error */ }
    await removePhotoFiles(root, name);
    throw error;
  }
}
export function streamPhoto(res, file) {
  createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
}
export function streamAlbumZip(res, root, album, photos, filename) {
  const payload = { root: validateSubmissionRoot(root), title: album.title, photos: photos.map((p) => ({ name: p.storedName, originalName: p.originalName, uploader: p.uploaderName || p.uploaderUuid, date: p.capturedDate, sequence: p.sequenceNumber, mediaType: p.mediaType })) };
  return runZipJob(() => new Promise((resolve, reject) => {
    if (res.destroyed) return resolve();
    const child = spawn('/usr/bin/python3', [zipScript], { stdio: ['pipe', 'pipe', 'ignore'] });
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"` });
    child.stdin.on('error', () => child.kill('SIGKILL'));
    child.stdin.end(JSON.stringify(payload));
    child.stdout.on('error', () => child.kill('SIGKILL'));
    res.on('close', () => child.kill('SIGKILL'));
    child.stdout.pipe(res);
    child.once('error', (error) => { res.destroy(); reject(error); });
    child.once('close', (code) => {
      if (code !== 0 && !res.writableEnded) res.destroy();
      resolve();
    });
  }));
}
