import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFromInfo, validateSettings } from '../backend/access.mjs';
import { mergeVerifiedGroups } from '../backend/auth.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const editor = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reader = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const role = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const settings = validateSettings({
  clientId: 'test-client', clientSecret: 'test-secret', auditOwnerUuid: owner,
  readerGroupName: 'Kollegium', editorUuids: [editor], editorAccounts: ['vw.leitung'], editorRoleUuids: [role],
});
const info = (uuid, extra = {}) => ({ 'iserv:uuid': uuid, 'iserv:groups': [{ id: '17', act: 'kollegium', name: 'Kollegium' }], ...extra });

test('Kollegiumsgruppe berechtigt Leser; explizit eingetragene Admin-UUIDs bleiben zugelassen', () => {
  assert.equal(identityFromInfo({ ...info(owner), 'iserv:groups': [] }, settings).auditOwner, true);
  assert.equal(identityFromInfo({ ...info(editor), 'iserv:groups': [{ name: 'Fremde Gruppe' }] }, settings).editor, true);
  assert.equal(identityFromInfo(info(reader), settings).editor, false);
  assert.equal(identityFromInfo({ ...info(reader), 'iserv:groups': [] }, settings), null);
  assert.equal(identityFromInfo({ ...info(reader, { preferred_username: 'vw.leitung' }), 'iserv:groups': [] }, settings), null);
});

test('Marc allein erhält die Sonderberechtigung zur Auswertung', () => {
  assert.deepEqual([identityFromInfo(info(owner), settings).editor, identityFromInfo(info(owner), settings).auditOwner], [true, true]);
  assert.deepEqual([identityFromInfo(info(editor), settings).editor, identityFromInfo(info(editor), settings).auditOwner], [true, false]);
  assert.deepEqual([identityFromInfo(info(reader, { preferred_username: 'vw.leitung' }), settings).editor, identityFromInfo(info(reader, { 'iserv:roles': [{ uuid: role }] }), settings).editor], [true, true]);
});

test('IServ-Anzeigename wird für die namentliche Auswertung übernommen', () => {
  assert.equal(identityFromInfo(info(owner, { name: ' Marc Schulz ' }), settings).name, 'Marc Schulz');
  assert.equal(identityFromInfo(info(reader, { given_name: 'Melanie', family_name: 'Bierwirth' }), settings).name, 'Melanie Bierwirth');
});

test('fehlende oder widersprüchliche IServ-UUID wird verworfen', () => {
  assert.equal(identityFromInfo({ 'iserv:groups': [{ name: 'Kollegium' }] }, settings), null);
  assert.equal(identityFromInfo(info(reader, { uuid: owner }), settings), null);
  assert.equal(identityFromInfo(info('not-a-uuid'), settings), null);
});

test('verifizierte ID-Token-Gruppen ergänzen fehlende UserInfo-Gruppen; vorhandene UserInfo-Gruppen bleiben maßgeblich', () => {
  const userInfo = { 'iserv:uuid': reader, name: 'Leserin' };
  const idToken = { 'iserv:groups': [{ name: 'Kollegium' }] };
  assert.equal(identityFromInfo(mergeVerifiedGroups(userInfo, idToken), settings).name, 'Leserin');
  assert.equal(identityFromInfo(mergeVerifiedGroups({ ...userInfo, 'iserv:groups': [] }, idToken), settings), null);
  assert.equal(identityFromInfo(mergeVerifiedGroups(userInfo, {}), settings), null);
  assert.equal(identityFromInfo(mergeVerifiedGroups({ ...userInfo, 'iserv:groups': null }, { 'iserv:groups': { first: { name: 'Kollegium' } } }), settings).name, 'Leserin');
  assert.equal(identityFromInfo(mergeVerifiedGroups({ ...userInfo, 'iserv:groups': { first: { name: 'Andere Gruppe' } } }, idToken), settings), null);
});

test('ungültige Rechtekonfiguration startet nicht', () => {
  assert.throws(() => validateSettings({ ...settings, auditOwnerUuid: 'marc' }));
  assert.throws(() => validateSettings({ ...settings, editorAccounts: ['<script>'] }));
});
