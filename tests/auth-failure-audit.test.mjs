import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCmsStore } from '../backend/cms-store.mjs';

const actor = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

function auditedPool(failUsage = false) {
  const statements = [];
  const events = [];
  const conn = {
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
    async query(sql, params) {
      statements.push({ sql, params });
      if (failUsage && sql.startsWith('INSERT INTO daily_usage')) throw new Error('usage unavailable');
      return { affectedRows: 1 };
    },
  };
  return { pool: { async getConnection() { return conn; } }, statements, events };
}

test('abgewiesene IServ-Anmeldung wird ohne Details und mit optionaler geprüfter UUID atomar erfasst', async () => {
  const { pool, statements, events } = auditedPool();
  const store = createCmsStore(pool);
  await store.recordAuthFailure('auth.access_denied');
  await store.recordAuthFailure('auth.identity_denied', actor);

  assert.deepEqual(events, ['begin', 'commit', 'release', 'begin', 'commit', 'release']);
  assert.deepEqual(statements.filter(({ sql }) => sql.startsWith('INSERT INTO audit_events')).map(({ params }) => params), [
    [null, 'auth.access_denied', 'auth', null, null],
    [actor.toLowerCase(), 'auth.identity_denied', 'auth', null, null],
  ]);
  assert.deepEqual(statements.filter(({ sql }) => sql.startsWith('INSERT INTO daily_usage')).map(({ params }) => params), [
    ['auth.access_denied', 'auth', ''],
    ['auth.identity_denied', 'auth', ''],
  ]);
});

test('nur feste Anmeldefehlerarten und gültige IServ-UUIDs sind erlaubt', async () => {
  const { pool, statements } = auditedPool();
  const store = createCmsStore(pool);
  for (const category of ['auth.access_denied', 'auth.oidc_error', 'auth.identity_denied', 'auth.session_unavailable', 'auth.login_start_failed', 'auth.finalize_failed']) {
    await store.recordAuthFailure(category);
  }
  const count = statements.length;
  await assert.rejects(store.recordAuthFailure('auth.access_denied?code=secret'));
  await assert.rejects(store.recordAuthFailure('auth.access_denied', 'not-a-uuid'));
  await assert.rejects(store.recordAudit(null, 'auth.access_denied', 'auth'));
  assert.equal(statements.length, count);
});

test('Anmeldefehler-Audit rollt zurück, wenn der Nutzungszähler fehlschlägt', async () => {
  const { pool, events } = auditedPool(true);
  await assert.rejects(createCmsStore(pool).recordAuthFailure('auth.oidc_error'), /usage unavailable/);
  assert.deepEqual(events, ['begin', 'rollback', 'release']);
});

test('Readiness verlangt die Migration für anonyme Audit-Ereignisse', async () => {
  function readinessPool(nullable) {
    return {
      async query(sql) {
        if (sql.includes('information_schema.tables')) return [{ n: 20 }];
        if (sql.includes('information_schema.columns')) {
          assert.match(sql, /audit_events' AND column_name = 'actor_uuid' AND is_nullable = 'YES'/);
          return [{ n: nullable ? 7 : 6 }];
        }
        return [];
      },
    };
  }
  await assert.rejects(createCmsStore(readinessPool(false)).ready(), /Datenbankspalten fehlen/);
  await createCmsStore(readinessPool(true)).ready();

  const migration = await readFile(new URL('../db/migrations/2026-10-28-anonymous-auth-audit.sql', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE audit_events MODIFY COLUMN actor_uuid CHAR\(36\) CHARACTER SET ascii COLLATE ascii_bin NULL;/);
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS audit_events \([\s\S]*?actor_uuid CHAR\(36\) CHARACTER SET ascii COLLATE ascii_bin NULL,/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS search_events \([\s\S]*?actor_uuid CHAR\(36\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,/);
});
