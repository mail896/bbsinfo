import { readFileSync, statSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_URL = 'https://school.example/iserv/auth/public/token';
const GROUP_URL = 'https://idm.school.example/iserv/idm/api/v1/users/';
const READ_SCOPE = 'iserv:idm:api-read';
const SCHOOL_EMAIL = /^[a-z0-9._%+-]+@school\.example$/i;

function validCredentials(value) {
  if (!value || typeof value !== 'object' || !['clientId', 'clientSecret'].every((key) =>
    typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 512)) {
    throw new Error('Ungültiger IDM-Dienstzugang.');
  }
  return { clientId: value.clientId, clientSecret: value.clientSecret };
}

export function readIdmCredentials(path) {
  if (typeof path !== 'string' || !path) throw new Error('IDM-Dienstzugang fehlt.');
  const file = statSync(path);
  if (!file.isFile()) throw new Error('IDM-Dienstzugang muss eine Datei sein.');
  const mode = file.mode & 0o777;
  const systemdCredential = process.env.CREDENTIALS_DIRECTORY && path === `${process.env.CREDENTIALS_DIRECTORY}/idm-credentials` && path.startsWith('/run/credentials/');
  if (mode & (systemdCredential ? 0o007 : 0o077)) throw new Error('IDM-Dienstzugang muss privat sein.');
  return validCredentials(JSON.parse(readFileSync(path, 'utf8')));
}

async function boundedJson(response, maximum) {
  if (!response.ok) throw new Error('IDM unavailable or unauthorized');
  if (Number(response.headers.get('content-length') || 0) > maximum) throw new Error('IDM response too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('IDM response missing');
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new Error('IDM response too large');
    }
    parts.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

// No membership cache: every delivery checks the current IServ directory state.
export function createIdmGroupVerifier(credentials, groupName, fetchImplementation = fetch, now = Date.now) {
  const { clientId, clientSecret } = validCredentials(credentials);
  if (typeof groupName !== 'string' || !groupName.trim() || groupName.length > 100) throw new Error('IDM-Gruppe fehlt.');
  const wanted = groupName.trim().normalize('NFC').toLocaleLowerCase('de');
  let cached = null;
  let pending = null;
  async function token() {
    if (cached && cached.until > now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImplementation(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: READ_SCOPE }),
      });
      const data = await boundedJson(response, 65536);
      const ttl = Number(data?.expires_in);
      if (
        typeof data?.access_token !== 'string' || !data.access_token || data.access_token.length > 4096 ||
        !Number.isFinite(ttl) || ttl <= 60 || ttl > 86400 ||
        (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))
      ) throw new Error('Invalid IDM token response');
      if (data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.trim() !== READ_SCOPE)) throw new Error('Unexpected IDM token scope');
      cached = { value: data.access_token, until: now() + (ttl - 60) * 1000 };
      return cached.value;
    })();
    try { return await pending; }
    finally { pending = null; }
  }
  return async (userUuid, recipient = undefined) => {
    if (typeof userUuid !== 'string' || !UUID.test(userUuid)) throw new Error('Ungültige IDM-Benutzer-UUID.');
    // The one-argument form keeps the established group-only API. Production mail
    // always supplies recipient and requires both live membership and live address.
    if (recipient !== undefined && (typeof recipient !== 'string' || recipient.length > 254 || !SCHOOL_EMAIL.test(recipient))) throw new Error('Ungültige IDM-Empfängeradresse.');
    const url = new URL(`${GROUP_URL}${encodeURIComponent(userUuid.toLowerCase())}/groups`);
    url.searchParams.set('_attributes', 'hexUuid,group,name,deleted');
    const accessToken = await token();
    const response = await fetchImplementation(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) return false;
    const rows = await boundedJson(response, 2000000);
    if (!Array.isArray(rows) || rows.length > 2000) throw new Error('Unexpected IDM collection');
    let member = false;
    for (const row of rows) {
      if (
        !row || typeof row !== 'object' ||
        !['hexUuid', 'group', 'name'].every((key) => typeof row[key] === 'string' && row[key].length > 0) ||
        !UUID.test(row.hexUuid) || !Object.hasOwn(row, 'deleted') || ![null, true, false].includes(row.deleted)
      ) throw new Error('Invalid IDM group');
      if (row.deleted !== true && [row.group, row.name].some((value) => value.normalize('NFC').toLocaleLowerCase('de') === wanted)) member = true;
    }
    if (!member || recipient === undefined) return member;

    const userUrl = new URL(`${GROUP_URL}${encodeURIComponent(userUuid.toLowerCase())}`);
    userUrl.searchParams.set('_attributes', 'hexUuid,user,emailAddress,deleted,locked');
    const userResponse = await fetchImplementation(userUrl, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    if (userResponse.status === 404) return false;
    const user = await boundedJson(userResponse, 65536);
    if (
      !user || typeof user !== 'object' || Array.isArray(user) ||
      !['hexUuid', 'user', 'emailAddress', 'deleted', 'locked'].every((key) => Object.hasOwn(user, key)) ||
      typeof user.hexUuid !== 'string' || !UUID.test(user.hexUuid) ||
      typeof user.user !== 'string' || !user.user || user.user.length > 200 ||
      ![null, true, false].includes(user.deleted) || typeof user.locked !== 'boolean' ||
      (user.emailAddress !== null && (typeof user.emailAddress !== 'string' || user.emailAddress.length > 254))
    ) throw new Error('Invalid IDM user');
    return user.hexUuid.toLowerCase() === userUuid.toLowerCase() &&
      user.deleted !== true && user.locked === false &&
      typeof user.emailAddress === 'string' && SCHOOL_EMAIL.test(user.emailAddress) &&
      user.emailAddress.toLowerCase() === recipient.toLowerCase();
  };
}
