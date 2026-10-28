import { statfs } from 'node:fs/promises';
import { auditGapCategories } from './audit-gap-marker.mjs';

const checkedPaths = Object.freeze(['/var/lib/bbsinfo', '/var/lib/mysql']);
export const auditFreeWarningBytes = 10n * 1024n ** 3n;

// A fixed marker records the first warning; no filesystem path or error detail is persisted.
export async function checkAuditCapacity(marker, statfsFn = statfs) {
  if (typeof marker?.mark !== 'function') return 'marker_failed';

  let low;
  try {
    const freeBytes = await Promise.all(checkedPaths.map(async (path) => {
      const { bavail, bsize } = await statfsFn(path, { bigint: true });
      if (typeof bavail !== 'bigint' || bavail < 0n || typeof bsize !== 'bigint' || bsize <= 0n) {
        throw new Error('Ungültige Speicherplatzmessung.');
      }
      return bavail * bsize;
    }));
    low = freeBytes.some((bytes) => bytes < auditFreeWarningBytes);
  } catch {
    return 'unknown';
  }

  if (!low) return 'ok';
  try {
    await marker.mark(auditGapCategories.capacityWarning);
    return 'warning';
  } catch {
    return 'marker_failed';
  }
}
