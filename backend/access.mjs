const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

const groupEntry = (value) => value && typeof value === 'object' && !Array.isArray(value) && [value.name, value.act, value.id].some((part) => typeof part === 'string');

export function groupEntries(claim) {
  if (Array.isArray(claim)) return claim;
  if (!claim || typeof claim !== 'object') return [];
  if (groupEntry(claim)) return [claim];
  for (const key of ['groups', 'items', 'data']) if (Array.isArray(claim[key])) return claim[key];
  const values = Object.values(claim);
  return values.length && values.every(groupEntry) ? values : [];
}

export function validateSettings(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Konfiguration fehlt.');
  const { clientId, clientSecret, auditOwnerUuid, readerGroupName = 'Kollegium' } = raw;
  if (typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim()) throw new Error('IServ-Client fehlt.');
  if (!UUID.test(auditOwnerUuid)) throw new Error('Audit-Eigentümer benötigt eine IServ-UUID.');
  if (typeof readerGroupName !== 'string' || !readerGroupName.trim() || readerGroupName.length > 100) throw new Error('Kollegiumsgruppe fehlt.');
  const uuids = (name) => {
    const values = raw[name] ?? [];
    if (!Array.isArray(values) || values.length > 50 || !values.every((v) => UUID.test(v))) throw new Error(`Ungültige ${name}.`);
    return [...new Set(values.map((v) => v.toLowerCase()))];
  };
  const accounts = raw.editorAccounts ?? [];
  if (!Array.isArray(accounts) || accounts.length > 50 || !accounts.every((v) => typeof v === 'string' && ACCOUNT.test(v))) throw new Error('Ungültige editorAccounts.');
  return {
    clientId: clientId.trim(), clientSecret,
    auditOwnerUuid: auditOwnerUuid.toLowerCase(),
    readerGroupName: readerGroupName.trim(),
    editorUuids: uuids('editorUuids'),
    editorRoleUuids: uuids('editorRoleUuids'),
    editorAccounts: [...new Set(accounts.map((v) => v.toLowerCase()))],
    database: raw.database ?? null,
  };
}

export function identityFromInfo(info, settings) {
  if (!info || typeof info !== 'object') return null;
  const uuid = verifiedUuidFromInfo(info);
  if (!uuid) return null;
  const groups = groupEntries(info['iserv:groups']);
  const reader = groups.some((group) => group && typeof group === 'object' && [group.name, group.act, group.id].some((v) => typeof v === 'string' && v.toLocaleLowerCase('de') === settings.readerGroupName.toLocaleLowerCase('de')));
  const account = typeof info.preferred_username === 'string' && ACCOUNT.test(info.preferred_username) ? info.preferred_username.toLowerCase() : null;
  const roles = Array.isArray(info['iserv:roles']) ? info['iserv:roles'] : [];
  const auditOwner = uuid === settings.auditOwnerUuid;
  const editorByUuid = settings.editorUuids.includes(uuid);
  if (!reader && !auditOwner && !editorByUuid) return null;
  const editor = auditOwner || editorByUuid || (account && settings.editorAccounts.includes(account)) || roles.some((role) => role && typeof role.uuid === 'string' && settings.editorRoleUuids.includes(role.uuid.toLowerCase()));
  const fullName = typeof info.name === 'string' && info.name.trim().length <= 200 ? info.name.trim() : '';
  const parts = [info.given_name, info.family_name].filter((part) => typeof part === 'string' && part.trim()).map((part) => part.trim());
  const name = fullName || (parts.join(' ').length <= 200 ? parts.join(' ') : '') || account || 'Kollegiumsmitglied';
  return {
    uuid, account,
    name,
    email: info.email_verified !== false && typeof info.email === 'string' && /^[a-z0-9._%+-]+@school\.example$/i.test(info.email) ? info.email.toLowerCase() : null,
    editor: !!editor,
    auditOwner,
  };
}

export function verifiedUuidFromInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const candidates = [info['iserv:uuid'], info.uuid].filter((v) => v !== undefined);
  if (!candidates.length || !candidates.every((v) => typeof v === 'string' && UUID.test(v) && v.toLowerCase() === candidates[0].toLowerCase())) return null;
  return candidates[0].toLowerCase();
}
