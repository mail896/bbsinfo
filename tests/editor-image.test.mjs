import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('zu großer Bild-Upload endet mit einem kontrollierten Fehler', () => {
  const moduleUrl = new URL('../backend/editor-image.mjs', import.meta.url).href;
  const script = `import { optimizeEditorUpload } from ${JSON.stringify(moduleUrl)};
try {
  await optimizeEditorUpload(Buffer.alloc(10 * 1024 * 1024));
  process.exitCode = 2;
} catch {
  process.stdout.write('rejected');
}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
});
