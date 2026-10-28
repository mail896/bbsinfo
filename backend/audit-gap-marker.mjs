import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const defaultRoot = '/var/lib/bbsinfo';
const filename = 'audit-capture-gap.json';
const maxMarkerBytes = 256;

export const auditGapCategories = Object.freeze({
  writeFailed: 'audit.write_failed',
  capacityWarning: 'audit.capacity_warning',
});

const allowedCategories = new Set(Object.values(auditGapCategories));

function validatePath(filePath, dataRoot) {
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot ||
      typeof filePath !== 'string' || !isAbsolute(filePath) || resolve(filePath) !== filePath ||
      dirname(filePath) !== dataRoot || filePath === dataRoot) {
    throw new Error('Ungültiger Audit-Marker-Pfad.');
  }
}

async function validateRoot(dataRoot) {
  const stat = await lstat(dataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw new Error('Audit-Marker-Verzeichnis ist nicht privat.');
  }
}

function parseMarker(bytes) {
  let marker;
  try { marker = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Audit-Marker ist ungültig.'); }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
      Object.keys(marker).length !== 2 || !Object.hasOwn(marker, 'occurredAt') || !Object.hasOwn(marker, 'category') ||
      typeof marker.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(marker.occurredAt) ||
      !Number.isFinite(Date.parse(marker.occurredAt)) || new Date(marker.occurredAt).toISOString() !== marker.occurredAt ||
      !allowedCategories.has(marker.category)) {
    throw new Error('Audit-Marker ist ungültig.');
  }
  return Object.freeze({ occurredAt: marker.occurredAt, category: marker.category });
}

export function createAuditGapMarker({ dataRoot = defaultRoot, filePath = join(dataRoot, filename) } = {}) {
  validatePath(filePath, dataRoot);
  const writeFailedPath = filePath.endsWith('.json')
    ? `${filePath.slice(0, -5)}.write-failed.json`
    : `${filePath}.write-failed.json`;
  validatePath(writeFailedPath, dataRoot);

  async function readAt(path, requiredCategory = null) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o177 || stat.uid !== process.getuid() || stat.size < 1 || stat.size > maxMarkerBytes) {
        throw new Error('Audit-Marker-Datei ist nicht privat oder ungültig.');
      }
      const bytes = Buffer.alloc(maxMarkerBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error('Audit-Marker-Datei hat sich geändert.');
      const marker = parseMarker(bytes.subarray(0, bytesRead));
      if (requiredCategory && marker.category !== requiredCategory) throw new Error('Audit-Marker ist ungültig.');
      return marker;
    } finally { await handle.close(); }
  }

  async function read() {
    await validateRoot(dataRoot);
    const [first, writeFailed] = await Promise.all([
      readAt(filePath), readAt(writeFailedPath, auditGapCategories.writeFailed),
    ]);
    return writeFailed || first;
  }

  async function createAt(path, category) {
    await validateRoot(dataRoot);
    const bytes = Buffer.from(JSON.stringify({ occurredAt: new Date().toISOString(), category }) + '\n');
    const tempPath = join(dataRoot, `.audit-capture-gap-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_CLOEXEC, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      try { await link(tempPath, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const rootHandle = await open(dataRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
      try { await rootHandle.sync(); } finally { await rootHandle.close(); }
    } finally {
      if (handle) await handle.close();
      await unlink(tempPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function mark(category) {
    if (!allowedCategories.has(category)) throw new Error('Ungültige Audit-Marker-Kategorie.');
    const existing = await read();
    if (existing?.category === auditGapCategories.writeFailed || (existing && category === auditGapCategories.capacityWarning)) return existing;
    if (!existing) await createAt(filePath, category);
    const current = await read();
    if (category === auditGapCategories.writeFailed && current?.category !== auditGapCategories.writeFailed) {
      // Die erste Warnung bleibt erhalten; ein eigener Marker macht den späteren Ausfall sichtbar.
      await createAt(writeFailedPath, category);
    }
    return read();
  }

  return Object.freeze({ read, mark });
}
