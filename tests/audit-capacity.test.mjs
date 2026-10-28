import assert from 'node:assert/strict';
import test from 'node:test';
import { auditFreeWarningBytes, checkAuditCapacity } from '../backend/audit-capacity.mjs';
import { auditGapCategories } from '../backend/audit-gap-marker.mjs';

function fixture(freeByPath, markerFailure = false) {
  const checked = [], marked = [];
  const statfsFn = async (path, options) => {
    checked.push([path, options]);
    const free = freeByPath[path];
    if (free instanceof Error) throw free;
    return { bavail: free, bsize: 1n };
  };
  const marker = { async mark(category) {
    marked.push(category);
    if (markerFailure) throw new Error('private marker path and details');
  } };
  return { checked, marked, statfsFn, marker };
}

test('beide festgelegten Verzeichnisse werden gelesen; genau 10 GiB sind noch kein Alarm', async () => {
  const setup = fixture({ '/var/lib/bbsinfo': auditFreeWarningBytes, '/var/lib/mysql': auditFreeWarningBytes + 1n });
  assert.equal(await checkAuditCapacity(setup.marker, setup.statfsFn), 'ok');
  assert.deepEqual(setup.checked, [
    ['/var/lib/bbsinfo', { bigint: true }],
    ['/var/lib/mysql', { bigint: true }],
  ]);
  assert.deepEqual(setup.marked, []);
});

test('unter 10 GiB freier DB-Speicher wird einmal der private Warnmarker gesetzt', async () => {
  const setup = fixture({ '/var/lib/bbsinfo': auditFreeWarningBytes + 1n, '/var/lib/mysql': auditFreeWarningBytes - 1n });
  assert.equal(await checkAuditCapacity(setup.marker, setup.statfsFn), 'warning');
  assert.deepEqual(setup.marked, [auditGapCategories.capacityWarning]);
});

test('Fehler oder ungültige Messwerte geben keine Pfad- oder Fehlerdetails weiter', async () => {
  const failure = fixture({ '/var/lib/bbsinfo': new Error('private path and details'), '/var/lib/mysql': auditFreeWarningBytes });
  assert.equal(await checkAuditCapacity(failure.marker, failure.statfsFn), 'unknown');
  assert.deepEqual(failure.marked, []);

  const invalid = fixture({ '/var/lib/bbsinfo': -1n, '/var/lib/mysql': auditFreeWarningBytes });
  assert.equal(await checkAuditCapacity(invalid.marker, invalid.statfsFn), 'unknown');
  assert.deepEqual(invalid.marked, []);
});

test('Marker-Schreibfehler wird als Status zurückgegeben und enthält keine privaten Details', async () => {
  const setup = fixture({ '/var/lib/bbsinfo': auditFreeWarningBytes - 1n, '/var/lib/mysql': auditFreeWarningBytes }, true);
  assert.equal(await checkAuditCapacity(setup.marker, setup.statfsFn), 'marker_failed');
  assert.deepEqual(setup.marked, [auditGapCategories.capacityWarning]);
  assert.equal(await checkAuditCapacity(null, setup.statfsFn), 'marker_failed');
});
