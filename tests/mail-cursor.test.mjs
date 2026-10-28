import assert from 'node:assert/strict';
import test from 'node:test';
import { createCmsStore } from '../backend/cms-store.mjs';

const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('Offene Abonnentenmails können nach der letzten Benutzer-UUID weitergelesen werden', async () => {
  const queries = [];
  const store = createCmsStore({ async query(sql, params) { queries.push({ sql, params }); return []; } });
  await store.pendingUpdateMail('instant', 50, null, user);
  assert.match(queries[0].sql, /s\.user_uuid > \?/);
  assert.deepEqual(queries[0].params, ['instant', user]);
  await store.pendingUpdateMail('daily', 50, '2026-10-28 17:00:00', user);
  assert.deepEqual(queries[1].params, ['daily', user, '2026-10-28 17:00:00', '2026-10-28 17:00:00']);
  await assert.rejects(() => store.pendingUpdateMail('instant', 50, null, '../invalid'), /UUID/);
});

test('Eine noch nicht versendete Mailreservierung wird parametrisiert und vollständig freigegeben', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async query(sql, params) { calls.push({ sql, params }); return { affectedRows: 2 }; },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
  };
  const store = createCmsStore({ async getConnection() { return connection; } });
  await store.releaseUpdateMail(user, [3, 4]);
  assert.deepEqual(calls, [
    'begin',
    { sql: "DELETE FROM update_mail_delivery WHERE user_uuid = ? AND status = 'sending' AND update_id IN (?,?)", params: [user, 3, 4] },
    'commit', 'release',
  ]);
  await assert.rejects(() => store.releaseUpdateMail(user, [3, 3]), /Doppelte/);
  assert.equal(calls.length, 4);
});
