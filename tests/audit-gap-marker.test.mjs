import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditGapCategories, createAuditGapMarker } from '../backend/audit-gap-marker.mjs';

function withPrivateRoot(run) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'bbsinfo-audit-gap-'));
  return Promise.resolve().then(() => run(dataRoot)).finally(() => rmSync(dataRoot, { recursive: true, force: true }));
}

test('erster Audit-Ausfall bleibt als privater, minimaler Marker erhalten', () => withPrivateRoot(async (dataRoot) => {
  const marker = createAuditGapMarker({ dataRoot });
  const path = join(dataRoot, 'audit-capture-gap.json');
  assert.equal(await marker.read(), null);
  const first = await marker.mark(auditGapCategories.writeFailed);
  assert.match(first.occurredAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(Object.keys(first), ['occurredAt', 'category']);
  assert.equal(first.category, 'audit.write_failed');
  assert.deepEqual(await marker.mark(auditGapCategories.capacityWarning), first);
  assert.deepEqual(await marker.read(), first);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['category', 'occurredAt']);
  assert.deepEqual(readdirSync(dataRoot), ['audit-capture-gap.json']);
}));

test('gleichzeitige Schreibversuche erzeugen einen vollständigen Marker ohne Überschreiben', () => withPrivateRoot(async (dataRoot) => {
  const marker = createAuditGapMarker({ dataRoot });
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    marker.mark(index % 2 ? auditGapCategories.capacityWarning : auditGapCategories.writeFailed)));
  const stored = await marker.read();
  assert.equal(stored.category, auditGapCategories.writeFailed);
  for (const result of results) assert.ok(Object.values(auditGapCategories).includes(result.category));
  assert.ok(readdirSync(dataRoot).every((name) =>
    ['audit-capture-gap.json', 'audit-capture-gap.write-failed.json'].includes(name)));
  for (const name of readdirSync(dataRoot)) assert.equal(statSync(join(dataRoot, name)).mode & 0o777, 0o600);
}));

test('späterer Audit-Ausfall überstimmt eine Warnung, ohne deren Zeitpunkt zu verlieren', () => withPrivateRoot(async (dataRoot) => {
  const marker = createAuditGapMarker({ dataRoot });
  const warningPath = join(dataRoot, 'audit-capture-gap.json');
  const failurePath = join(dataRoot, 'audit-capture-gap.write-failed.json');
  const warning = await marker.mark(auditGapCategories.capacityWarning);
  const originalBytes = readFileSync(warningPath, 'utf8');
  const failure = await marker.mark(auditGapCategories.writeFailed);
  assert.equal(failure.category, auditGapCategories.writeFailed);
  assert.deepEqual(await marker.read(), failure);
  assert.equal(readFileSync(warningPath, 'utf8'), originalBytes);
  assert.deepEqual(JSON.parse(originalBytes), warning);
  assert.equal(JSON.parse(readFileSync(failurePath, 'utf8')).category, auditGapCategories.writeFailed);
  assert.equal(statSync(failurePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dataRoot).sort(), ['audit-capture-gap.json', 'audit-capture-gap.write-failed.json']);
}));

test('nur feste Kategorien und direkte absolute Pfade im privaten Verzeichnis sind erlaubt', () => withPrivateRoot(async (dataRoot) => {
  assert.throws(() => createAuditGapMarker({ dataRoot, filePath: join(dataRoot, '..', 'outside.json') }), /Pfad/);
  assert.throws(() => createAuditGapMarker({ dataRoot, filePath: 'audit-capture-gap.json' }), /Pfad/);
  assert.throws(() => createAuditGapMarker({ dataRoot, filePath: join(dataRoot, 'nested', 'gap.json') }), /Pfad/);
  const marker = createAuditGapMarker({ dataRoot });
  await assert.rejects(() => marker.mark('audit.failure with token=secret'), /Kategorie/);
  assert.equal(await marker.read(), null);
}));

test('unsichere Verzeichnisse und Marker-Dateien werden nicht gelesen oder überschrieben', () => withPrivateRoot(async (dataRoot) => {
  const marker = createAuditGapMarker({ dataRoot });
  const path = join(dataRoot, 'audit-capture-gap.json');
  chmodSync(dataRoot, 0o755);
  await assert.rejects(() => marker.mark(auditGapCategories.writeFailed), /privat/);
  chmodSync(dataRoot, 0o700);

  writeFileSync(path, '{"occurredAt":"2026-10-28T00:00:00.000Z","category":"audit.write_failed"}', { mode: 0o600 });
  chmodSync(path, 0o644);
  await assert.rejects(() => marker.read(), /privat/);
  await assert.rejects(() => marker.mark(auditGapCategories.writeFailed), /privat/);
  rmSync(path);
  writeFileSync(join(dataRoot, 'outside'), 'private', { mode: 0o600 });
  symlinkSync(join(dataRoot, 'outside'), path);
  await assert.rejects(() => marker.read());
  await assert.rejects(() => marker.mark(auditGapCategories.writeFailed));
  assert.equal(readFileSync(join(dataRoot, 'outside'), 'utf8'), 'private');
}));

test('beschädigte oder um zusätzliche Felder erweiterte Marker bleiben zur Prüfung bestehen', () => withPrivateRoot(async (dataRoot) => {
  const marker = createAuditGapMarker({ dataRoot });
  const path = join(dataRoot, 'audit-capture-gap.json');
  writeFileSync(path, '{broken', { mode: 0o600 });
  await assert.rejects(() => marker.read(), /ungültig/);
  await assert.rejects(() => marker.mark(auditGapCategories.writeFailed), /ungültig/);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  writeFileSync(path, JSON.stringify({ occurredAt: '2026-10-28T00:00:00.000Z', category: 'audit.write_failed', token: 'never' }));
  await assert.rejects(() => marker.read(), /ungültig/);
}));
