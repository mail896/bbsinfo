#!/usr/bin/env node
// Operational recovery within seven days; run as root with a verified editor UUID.
import { readSettings } from '../backend/server.mjs';
import { openCmsStore } from '../backend/cms-store.mjs';

const [kind, rawId, editorUuid] = process.argv.slice(2);
if (!['photo', 'album'].includes(kind) || !/^[1-9][0-9]*$/.test(rawId || '') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editorUuid || '')) {
  process.stderr.write('Aufruf: node tools/restore-photo.mjs photo|album ID REDAKTIONS_UUID\n');
  process.exit(2);
}
const config = readSettings(process.env.BBSINFO_CONFIG || '/etc/bbsinfo/config.json');
const store = openCmsStore(config.database);
try {
  await store.ready();
  const restored = kind === 'photo' ? await store.restoreDeletedPhoto(editorUuid, rawId) : await store.restoreDeletedPhotoAlbum(editorUuid, rawId);
  if (!restored) { process.stderr.write('Eintrag nicht vorhanden oder Frist abgelaufen.\n'); process.exitCode = 1; }
  else process.stdout.write('Wiederhergestellt und auditiert.\n');
} finally { await store.close(); }
