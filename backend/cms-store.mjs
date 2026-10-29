import mariadb from 'mariadb';
import { cleanRichText } from './rich-text.mjs';
import { defaultAppSettings, validateAppSettings } from './app-settings.mjs';
import { auditGapCategories } from './audit-gap-marker.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHOOL_EMAIL = /^[a-z0-9._%+-]+@school[.]example$/i;
const ISSUE_SOURCE_PAGE_SIZE = 30;
const AUTH_FAILURE_ACTIONS = new Set([
  'auth.access_denied',
  'auth.oidc_error',
  'auth.identity_denied',
  'auth.session_unavailable',
  'auth.login_start_failed',
  'auth.finalize_failed',
]);
const auditTransactionStates = new WeakMap();
const berlinOffsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' });

function auditDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Ungültiger Audit-Zeitraum.');
  const year = Number(value.slice(0, 4));
  const date = new Date(`${value}T00:00:00Z`);
  if (year < 1000 || year > 9998 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Ungültiger Audit-Zeitraum.');
  return date;
}

function berlinDayStartUtc(date) {
  const zone = berlinOffsetFormatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
  const offset = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone || '');
  if (!offset) throw new Error('Berliner Zeitzone nicht verfügbar.');
  const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1);
  return new Date(date.getTime() - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

export function normalizeAuditFilters(filters = {}) {
  const value = (key) => filters[key] === undefined ? '' : typeof filters[key] === 'string' ? filters[key] : null;
  const actor = value('actor')?.trim() ?? null;
  const action = value('action');
  const object = value('object')?.trim() ?? null;
  const from = value('from');
  const to = value('to');
  if (actor === null || actor.length > 100 || /[\u0000-\u001f\u007f]/u.test(actor) || action === null || action.length > 48 || (action && !/^[a-z_]+(?:\.[a-z_]+)+$/.test(action)) || object === null || object.length > 100 || /[\u0000-\u001f\u007f]/u.test(object) || from === null || to === null) throw new Error('Ungültiger Audit-Filter.');
  const fromDate = from ? auditDate(from) : null;
  const toDate = to ? auditDate(to) : null;
  if (from && to && from > to) throw new Error('Ungültiger Audit-Zeitraum.');
  return { actor, action, object, from, to, fromUtc: fromDate ? berlinDayStartUtc(fromDate) : null, toUtc: toDate ? berlinDayStartUtc(new Date(toDate.getTime() + 86400000)) : null };
}

function auditFilterConditions(filters) {
  const { actor, action, object, fromUtc, toUtc } = normalizeAuditFilters(filters);
  const clauses = [], params = [];
  if (actor) {
    if (UUID.test(actor)) { clauses.push('e.actor_uuid = ?'); params.push(actor.toLowerCase()); }
    else {
      clauses.push("(LOCATE(LOWER(?), LOWER(p.display_name)) > 0 OR (e.action IN ('update.mail_start', 'update.mail_sent', 'update.mail_uncertain') AND LOCATE(LOWER(?), 'bbs info') > 0))");
      params.push(actor, actor);
    }
  }
  if (action) { clauses.push('e.action = ?'); params.push(action); }
  if (object) {
    clauses.push("(LOCATE(LOWER(?), LOWER(COALESCE(e.object_title, u.title, draft_issue.title, published_issue.title, ''))) > 0 OR LOCATE(LOWER(?), LOWER(COALESCE(e.object_id, ''))) > 0 OR LOCATE(LOWER(?), LOWER(COALESCE(e.object_type, ''))) > 0 OR (e.object_type = 'issue' AND e.action NOT IN ('issue.create', 'issue.draft_delete', 'issue.draft_restore', 'issue.draft_purge') AND LOCATE(LOWER(?), LOWER(CONCAT('BBS Info ', e.object_id, ': ', COALESCE(e.object_title, published_issue.title, '')))) > 0))");
    params.push(object, object, object, object);
  }
  if (fromUtc) { clauses.push('e.occurred_at >= ?'); params.push(fromUtc); }
  if (toUtc) { clauses.push('e.occurred_at < ?'); params.push(toUtc); }
  return { clauses, params, countJoin: object ? `${auditUpdateJoin}${auditIssueJoin}` : '' };
}

const auditUpdateJoin = " LEFT JOIN updates u ON e.object_type = 'update' AND u.id = e.object_id";
const auditIssueJoin = " LEFT JOIN issues draft_issue ON e.object_type = 'issue' AND e.action IN ('issue.create', 'issue.draft_delete', 'issue.draft_restore', 'issue.draft_purge') AND draft_issue.id = e.object_id LEFT JOIN issues published_issue ON e.object_type = 'issue' AND e.action NOT IN ('issue.create', 'issue.draft_delete', 'issue.draft_restore', 'issue.draft_purge') AND published_issue.number = e.object_id";

const issueSourceQueries = {
  updates: {
    select: "SELECT u.id, u.title, DATE_FORMAT(u.published_at, '%Y-%m-%d %H:%i:%s') AS publishedAtUtc, (SELECT GROUP_CONCAT(i.number ORDER BY i.number SEPARATOR ',') FROM issue_updates iu JOIN issues i ON i.id = iu.issue_id WHERE iu.update_id = u.id AND i.status = 'published' AND i.deleted_at IS NULL) AS usedInIssues FROM updates u",
    available: "u.status = 'published'",
    used: "EXISTS (SELECT 1 FROM issue_updates iu JOIN issues i ON i.id = iu.issue_id WHERE iu.update_id = u.id AND i.status = 'published' AND i.deleted_at IS NULL)",
    search: ['u.title'],
    order: 'u.published_at DESC, u.id DESC',
  },
  contributions: {
    select: "SELECT c.id, c.title, p.display_name AS author, (SELECT GROUP_CONCAT(i.number ORDER BY i.number SEPARATOR ',') FROM issue_contributions ic JOIN issues i ON i.id = ic.issue_id WHERE ic.contribution_id = c.id AND i.status = 'published' AND i.deleted_at IS NULL) AS usedInIssues FROM contributions c JOIN iserv_identities p ON p.user_uuid = c.owner_uuid",
    available: "c.status = 'submitted'",
    includeUsed: true,
    used: "EXISTS (SELECT 1 FROM issue_contributions ic JOIN issues i ON i.id = ic.issue_id WHERE ic.contribution_id = c.id AND i.status = 'published' AND i.deleted_at IS NULL)",
    search: ['c.title', 'p.display_name'],
    order: 'c.created_at DESC, c.id DESC',
  },
  submissions: {
    select: "SELECT s.id, s.title, p.display_name AS ownerName, (EXISTS(SELECT 1 FROM update_submissions us WHERE us.submission_id = s.id) OR EXISTS(SELECT 1 FROM issue_submissions isu WHERE isu.submission_id = s.id)) AS linked, (SELECT GROUP_CONCAT(i.number ORDER BY i.number SEPARATOR ',') FROM issue_submissions isu JOIN issues i ON i.id = isu.issue_id WHERE isu.submission_id = s.id AND i.status = 'published' AND i.deleted_at IS NULL) AS usedInIssues FROM submissions s LEFT JOIN iserv_identities p ON p.user_uuid = s.owner_uuid",
    available: "s.status = 'taken_over'",
    used: "EXISTS (SELECT 1 FROM issue_submissions isu JOIN issues i ON i.id = isu.issue_id WHERE isu.submission_id = s.id AND i.status = 'published' AND i.deleted_at IS NULL)",
    search: ['s.title', 'p.display_name'],
    order: 's.id DESC',
  },
};

async function issueSourcePage(pool, kind, options = {}) {
  const source = issueSourceQueries[kind];
  const { query = '', used = false, page = 1 } = options;
  if (!source || typeof query !== 'string' || query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query) || typeof used !== 'boolean' || !Number.isSafeInteger(page) || page < 1 || page > 2000) throw new Error('Ungültige Ausgabenquelle.');
  const term = query.trim();
  const alias = { updates: 'u', contributions: 'c', submissions: 's' }[kind];
  const conditions = [`${alias}.deleted_at IS NULL`, source.includeUsed ? `(${source.available} OR ${source.used})` : source.available, used ? source.used : `NOT (${source.used})`];
  const params = [];
  if (term) {
    conditions.push(`(${source.search.map((column) => `LOCATE(LOWER(?), LOWER(${column})) > 0`).join(' OR ')})`);
    params.push(...source.search.map(() => term));
  }
  const sql = `${source.select} WHERE ${conditions.join(' AND ')} ORDER BY ${source.order} LIMIT ? OFFSET ?`;
  const rows = await pool.query(sql, [...params, ISSUE_SOURCE_PAGE_SIZE + 1, (page - 1) * ISSUE_SOURCE_PAGE_SIZE]);
  return { items: rows.slice(0, ISSUE_SOURCE_PAGE_SIZE), hasMore: rows.length > ISSUE_SOURCE_PAGE_SIZE, page };
}

function validEditorEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !SCHOOL_EMAIL.test(email)) throw new Error('Ungültige IServ-E-Mail-Adresse.');
  return email;
}

function validActor(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Ungültige IServ-UUID.');
  return value.toLowerCase();
}

function validUpdateId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > 4294967295) throw new Error('Ungültige Update-ID.');
  return id;
}

function validText(title, body, bodyHtml = null) {
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('Titel und Text fehlen.');
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (!cleanTitle || cleanTitle.length > 200 || !cleanBody || cleanBody.length > 20000) throw new Error('Titel oder Text außerhalb der erlaubten Länge.');
  const rich = bodyHtml === null ? null : cleanRichText(bodyHtml, 20000);
  if (rich && rich.plain !== cleanBody) throw new Error('Formatierter Text stimmt nicht mit Suchtext überein.');
  return { title: cleanTitle, body: cleanBody, bodyHtml: rich?.html || null };
}

function validIssue(title, body, schoolYear, period, updateIds, bodyHtml = null, submissionIds = [], contributionIds = []) {
  if (![title, body, schoolYear, period].every((value) => typeof value === 'string')) throw new Error('Ungültige Ausgabendaten.');
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  const cleanYear = schoolYear.trim();
  const cleanPeriod = period.trim();
  if (!cleanTitle || cleanTitle.length > 200 || cleanBody.length > 40000 || cleanYear.length > 30 || cleanPeriod.length > 100) throw new Error('Ungültige Ausgabendaten.');
  if (!Array.isArray(updateIds) || updateIds.length > 50) throw new Error('Zu viele Updates.');
  const ids = updateIds.map(validUpdateId);
  if (!Array.isArray(submissionIds) || submissionIds.length > 50) throw new Error('Zu viele Steckbriefe.');
  const files = submissionIds.map(validUpdateId);
  if (!Array.isArray(contributionIds) || contributionIds.length > 50) throw new Error('Zu viele Kollegenbeiträge.');
  const articles = contributionIds.map(validUpdateId);
  if (new Set(ids).size !== ids.length || new Set(files).size !== files.length || new Set(articles).size !== articles.length) throw new Error('Doppelte Auswahl in der Ausgabe.');
  const rich = bodyHtml === null ? null : cleanRichText(bodyHtml, 40000);
  if (rich && rich.plain !== cleanBody) throw new Error('Formatierter Text stimmt nicht mit Suchtext überein.');
  return { title: cleanTitle, body: cleanBody, bodyHtml: rich?.html || null, schoolYear: cleanYear, period: cleanPeriod, ids, files, articles };
}

async function snapshotContributions(conn, issueId, ids, actor, previouslyIncluded = new Set()) {
  if (!ids.length) return;
  const rows = await conn.query(`SELECT c.id, c.title, c.body, c.body_html AS bodyHtml, c.status, p.display_name AS author, EXISTS(SELECT 1 FROM issue_contributions ic JOIN issues i ON i.id = ic.issue_id WHERE ic.contribution_id = c.id AND i.status = 'published' AND i.deleted_at IS NULL) AS usedBefore FROM contributions c JOIN iserv_identities p ON p.user_uuid = c.owner_uuid WHERE c.deleted_at IS NULL AND c.id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, ids);
  if (rows.length !== ids.length || rows.some((row) => row.status !== 'submitted' && !(row.status === 'taken_over' && (Number(row.usedBefore) === 1 || previouslyIncluded.has(Number(row.id)))))) throw new Error('Ein gewählter Kollegenbeitrag ist nicht verfügbar.');
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  for (const [position, id] of ids.entries()) {
    const row = byId.get(id);
    await conn.query('INSERT INTO issue_contributions (issue_id, contribution_id, position, snapshot_title, snapshot_body, snapshot_body_html, snapshot_author) VALUES (?, ?, ?, ?, ?, ?, ?)', [issueId, id, position + 1, row.title, row.body, row.bodyHtml, row.author]);
    await conn.query("UPDATE contributions SET status = 'taken_over' WHERE id = ?", [id]);
    if (row.status === 'submitted') await audit(conn, actor, 'contribution.take_over', 'contribution', id, row.title);
  }
}

async function releaseRemovedContributions(conn, ids) {
  for (const id of ids) await conn.query("UPDATE contributions SET status = 'submitted' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM issue_contributions WHERE contribution_id = ?)", [id, id]);
}

async function checkedSubmissions(conn, ids) {
  if (!ids.length) return;
  const found = await conn.query(`SELECT id FROM submissions WHERE status = 'taken_over' AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, ids);
  if (found.length !== ids.length) throw new Error('Ein gewählter Steckbrief ist nicht übernommen.');
}

async function issueSubmissionIds(conn, updateIds, directIds) {
  const ids = [...directIds];
  if (updateIds.length) {
    const attachments = await conn.query(`SELECT us.update_id AS updateId, us.submission_id AS submissionId, us.position FROM update_submissions us WHERE us.update_id IN (${updateIds.map(() => '?').join(',')})`, updateIds);
    const order = new Map(updateIds.map((id, index) => [id, index]));
    attachments.sort((a, b) => order.get(a.updateId) - order.get(b.updateId) || a.position - b.position);
    ids.push(...attachments.map((item) => item.submissionId));
  }
  return [...new Set(ids)];
}

function validSubmission(title, note, storedName, mediaType, byteSize) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200 || typeof note !== 'string' || note.length > 1000 || typeof storedName !== 'string' || !UUID.test(storedName) || !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mediaType) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 10 * 1024 * 1024) throw new Error('Ungültige Einreichung.');
  return { title: title.trim(), note: note.trim(), storedName: storedName.toLowerCase(), mediaType, byteSize };
}

async function writeAudit(conn, actorUuid, action, type, id, title) {
  const state = auditTransactionStates.get(conn);
  if (state) state.attempted = true;
  try {
    await conn.query('INSERT INTO audit_events (actor_uuid, action, object_type, object_id, object_title) VALUES (?, ?, ?, ?, ?)', [actorUuid, action, type, id === null ? null : String(id), title]);
    await conn.query('INSERT INTO daily_usage (day, action, object_type, object_id, event_count) VALUES (UTC_DATE(), ?, ?, ?, 1) ON DUPLICATE KEY UPDATE event_count = event_count + 1', [action, type || '', id === null ? '' : String(id)]);
  } catch (error) {
    if (state) state.writeFailed = true;
    throw error;
  }
}

async function audit(conn, actor, action, type = null, id = null, title = null) {
  await writeAudit(conn, validActor(actor), action, type, id, title);
}

async function markAuditWriteFailure(auditGapMarker) {
  if (!auditGapMarker) return;
  try { await auditGapMarker.mark(auditGapCategories.writeFailed); }
  catch { process.stderr.write('BBS Info: Audit-Lücke konnte nicht dauerhaft markiert werden.\n'); }
}

async function transaction(pool, work, auditGapMarker = null, auditRequired = false) {
  let conn;
  try { conn = await pool.getConnection(); }
  catch (error) {
    if (auditRequired) await markAuditWriteFailure(auditGapMarker);
    throw error;
  }
  const auditState = { attempted: false, writeFailed: false, commitStarted: false };
  auditTransactionStates.set(conn, auditState);
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    auditState.commitStarted = true;
    await conn.commit();
    return result;
  } catch (error) {
    try { await conn.rollback(); } catch { /* preserve original error */ }
    if (auditState.writeFailed || (auditState.attempted && auditState.commitStarted) || (auditRequired && !auditState.attempted)) await markAuditWriteFailure(auditGapMarker);
    throw error;
  } finally {
    auditTransactionStates.delete(conn);
    conn.release();
  }
}

async function reserveIssueNumber(conn) {
  const seq = await conn.query('SELECT next_number AS nextNumber FROM issue_sequence WHERE id = 1 FOR UPDATE');
  const nextNumber = Number(seq[0]?.nextNumber);
  if (!Number.isSafeInteger(nextNumber) || nextNumber < 93 || nextNumber > 65535) throw new Error('Ausgabennummerierung nicht verfügbar.');
  // The sequence can be stale after an older deletion. The locked row still serializes
  // allocations, while scanning from 93 reuses the first genuinely free number.
  let number = 93;
  const occupied = await conn.query('SELECT number FROM issues WHERE number >= ? ORDER BY number', [number]);
  for (const row of occupied) {
    if (Number(row.number) !== number) break;
    number++;
  }
  if (number >= 65535) throw new Error('Ausgabennummerierung nicht verfügbar.');
  await conn.query('UPDATE issue_sequence SET next_number = ? WHERE id = 1', [number + 1]);
  return number;
}

export function createCmsStore(pool, { auditGapMarker = null } = {}) {
  const transact = (work, auditRequired = false) => transaction(pool, work, auditGapMarker, auditRequired);
  return {
    async ready() {
      const rows = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('updates', 'update_subscriptions', 'audit_events', 'iserv_identities', 'editor_grants', 'issue_sequence', 'issues', 'issue_updates', 'submissions', 'update_submissions', 'issue_submissions', 'daily_usage', 'issue_mail_delivery', 'content_templates', 'editor_images', 'app_settings', 'contributions', 'issue_contributions', 'search_events', 'update_mail_delivery')");
      if (Number(rows[0]?.n) !== 20) throw new Error('BBS-Info-Datenbankschema fehlt.');
      const fields = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = 'updates' AND column_name IN ('body_html', 'deleted_at', 'deleted_by', 'mail_suppressed')) OR (table_name = 'contributions' AND column_name IN ('deleted_at', 'deleted_by')) OR (table_name = 'submissions' AND column_name IN ('deleted_at', 'deleted_by')) OR (table_name = 'issues' AND column_name IN ('body_html', 'deleted_at', 'deleted_by')) OR (table_name = 'issue_updates' AND column_name = 'snapshot_body_html') OR (table_name = 'audit_events' AND column_name = 'object_title') OR (table_name = 'audit_events' AND column_name = 'actor_uuid' AND is_nullable = 'YES') OR (table_name = 'iserv_identities' AND column_name = 'email') OR (table_name = 'update_subscriptions' AND column_name = 'mode'))");
      if (Number(fields[0]?.n) !== 16) throw new Error('BBS-Info-Datenbankspalten fehlen.');
      await pool.query('DELETE FROM search_events WHERE searched_at < UTC_TIMESTAMP(6) - INTERVAL 90 DAY');
    },
    async rememberIdentity(identity) {
      const uuid = validActor(identity?.uuid);
      const name = typeof identity.name === 'string' ? identity.name.trim() : '';
      if (!name || name.length > 200) throw new Error('Ungültiger IServ-Name.');
      const email = typeof identity.email === 'string' && /^[a-z0-9._%+-]+@school\.example$/i.test(identity.email) && identity.email.length <= 254 ? identity.email.toLowerCase() : null;
      await pool.query('INSERT INTO iserv_identities (user_uuid, display_name, email) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), email = VALUES(email), last_seen_at = UTC_TIMESTAMP(6)', [uuid, name, email]);
    },
    async listEditorGrants() {
      return pool.query('SELECT g.email, g.user_uuid AS userUuid, p.display_name AS name FROM editor_grants g LEFT JOIN iserv_identities p ON p.user_uuid = g.user_uuid ORDER BY g.email');
    },
    async addEditorGrant(actor, input) {
      const uuid = validActor(actor);
      const email = validEditorEmail(input);
      return transact(async (conn) => {
        const existing = await conn.query('SELECT email FROM editor_grants WHERE email = ? FOR UPDATE', [email]);
        if (existing.length) return false;
        const count = await conn.query('SELECT COUNT(*) AS n FROM editor_grants');
        if (Number(count[0]?.n) >= 50) throw new Error('Zu viele Redaktionskonten.');
        const known = await conn.query('SELECT user_uuid AS userUuid FROM iserv_identities WHERE email = ? ORDER BY last_seen_at DESC LIMIT 2', [email]);
        if (known.length > 1) throw new Error('IServ-Adresse ist nicht eindeutig.');
        await conn.query('INSERT INTO editor_grants (email, user_uuid, created_by) VALUES (?, ?, ?)', [email, null, uuid]);
        await audit(conn, uuid, 'editor.grant', 'editor', null, email);
        return true;
      });
    },
    async removeEditorGrant(actor, input) {
      const uuid = validActor(actor);
      const email = validEditorEmail(input);
      return transact(async (conn) => {
        const result = await conn.query('DELETE FROM editor_grants WHERE email = ?', [email]);
        if (!result.affectedRows) return false;
        await audit(conn, uuid, 'editor.revoke', 'editor', null, email);
        return true;
      });
    },
    async hasEditorGrant(identity, verifyPending = null) {
      const uuid = validActor(identity?.uuid);
      const email = identity.email ? validEditorEmail(identity.email) : null;
      const rows = await pool.query('SELECT email, user_uuid AS userUuid FROM editor_grants WHERE user_uuid = ? OR email = ? LIMIT 2', [uuid, email || '']);
      if (rows.some((row) => row.userUuid === uuid)) return true;
      if (!email || !rows.some((row) => row.email === email && row.userUuid === null)) return false;
      if (typeof verifyPending !== 'function') return false;
      const marker = await pool.query("SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS createdAt FROM editor_grants WHERE email = ? AND user_uuid IS NULL", [email]);
      if (marker.length !== 1 || typeof marker[0].createdAt !== 'string') return false;
      if (await verifyPending(uuid, email) !== true) return false;
      // Keep the pre-IDM creation marker so a revoked and recreated grant cannot be bound by an older login.
      return transact(async (conn) => {
        const locked = await conn.query("SELECT user_uuid AS userUuid, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS createdAt FROM editor_grants WHERE email = ? FOR UPDATE", [email]);
        if (locked.length !== 1 || locked[0].userUuid !== null || locked[0].createdAt !== marker[0].createdAt) return false;
        const result = await conn.query('UPDATE editor_grants SET user_uuid = ? WHERE email = ? AND user_uuid IS NULL AND created_at = ?', [uuid, email, marker[0].createdAt]);
        if (result.affectedRows !== 1) return false;
        await audit(conn, uuid, 'editor.bind', 'editor', null, email);
        return true;
      });
    },
    async getAppSettings() {
      const rows = await pool.query('SELECT setting_key AS settingKey, setting_value AS settingValue FROM app_settings');
      const values = { ...defaultAppSettings };
      for (const row of rows) if (Object.hasOwn(values, row.settingKey)) values[row.settingKey] = row.settingValue;
      return validateAppSettings(values);
    },
    async saveAppSettings(actor, input) {
      const uuid = validActor(actor);
      const values = validateAppSettings(input);
      await transact(async (conn) => {
        for (const [key, value] of Object.entries(values)) await conn.query('INSERT INTO app_settings (setting_key, setting_value, changed_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), changed_by = VALUES(changed_by), changed_at = UTC_TIMESTAMP(6)', [key, value, uuid]);
        await audit(conn, uuid, 'settings.edit', 'settings');
      });
    },
    async recordAudit(actor, action, type = null, id = null) {
      const actorUuid = validActor(actor);
      await transact((conn) => writeAudit(conn, actorUuid, action, type, id, null), true);
    },
    async recordAuthFailure(category, actor = null) {
      if (!AUTH_FAILURE_ACTIONS.has(category)) throw new Error('Ungültige Anmeldefehlerart.');
      const actorUuid = actor === null ? null : validActor(actor);
      await transact((conn) => writeAudit(conn, actorUuid, category, 'auth', null, null), true);
    },
    async listIssueUpdates(options = {}) {
      return issueSourcePage(pool, 'updates', options);
    },
    async listDigestTestUpdates() {
      return pool.query("SELECT id, title, body, body_html AS bodyHtml FROM updates WHERE status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC, id DESC LIMIT 50");
    },
    async listContentPage(kind, page, size = 15) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 2000 || !Number.isSafeInteger(size) || size < 1 || size > 50) throw new Error('Ungültige Inhaltsseite.');
      const queries = {
        updates: "SELECT id, title, body, body_html AS bodyHtml, DATE_FORMAT(published_at, '%Y-%m-%d %H:%i:%s') AS publishedAtUtc FROM updates WHERE status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC, id DESC",
        updateDrafts: "SELECT id, title, body, body_html AS bodyHtml, DATE_FORMAT(updated_at, '%d.%m.%Y %H:%i') AS updatedAt FROM updates WHERE status = 'draft' AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC",
        issues: "SELECT number, title, school_year AS schoolYear, period, DATE_FORMAT(published_at, '%d.%m.%Y') AS publishedAt FROM issues WHERE status = 'published' AND deleted_at IS NULL ORDER BY number DESC",
        issueDrafts: "SELECT id, title, body, body_html AS bodyHtml, school_year AS schoolYear, period FROM issues WHERE status = 'draft' AND deleted_at IS NULL ORDER BY id DESC",
      };
      if (!Object.hasOwn(queries, kind)) throw new Error('Ungültige Inhaltsliste.');
      const countTables = { updates: ['updates', 'published'], updateDrafts: ['updates', 'draft'], issues: ['issues', 'published'], issueDrafts: ['issues', 'draft'] };
      const [table, status] = countTables[kind];
      const counts = await pool.query(`SELECT COUNT(*) AS count FROM ${table} WHERE status = ? AND deleted_at IS NULL`, [status]);
      const pageCount = Math.max(1, Math.min(2000, Math.ceil(Number(counts[0]?.count || 0) / size)));
      const rows = await pool.query(`${queries[kind]} LIMIT ${size + 1} OFFSET ${(page - 1) * size}`);
      const items = rows.slice(0, size);
      if (kind === 'updates' && items.length) {
        const attachments = await pool.query(`SELECT us.update_id AS updateId, s.id, s.title FROM update_submissions us JOIN submissions s ON s.id = us.submission_id WHERE us.update_id IN (${items.map(() => '?').join(',')}) ORDER BY us.update_id, us.position`, items.map((row) => row.id));
        const byUpdate = new Map(items.map((row) => [row.id, []]));
        for (const item of attachments) byUpdate.get(item.updateId)?.push({ id: item.id, title: item.title });
        return { items: items.map((row) => ({ ...row, attachments: byUpdate.get(row.id) })), page, pageCount, hasNext: rows.length > size };
      }
      return { items, page, pageCount, hasNext: rows.length > size };
    },
    async getPublishedUpdate(id) {
      const updateId = validUpdateId(id);
      const rows = await pool.query("SELECT id, title, body, body_html AS bodyHtml, DATE_FORMAT(published_at, '%Y-%m-%d %H:%i:%s') AS publishedAtUtc FROM updates WHERE status = 'published' AND deleted_at IS NULL AND id = ?", [updateId]);
      if (!rows.length) return null;
      const attachments = await pool.query('SELECT s.id, s.title FROM update_submissions us JOIN submissions s ON s.id = us.submission_id WHERE us.update_id = ? ORDER BY us.position', [updateId]);
      return { ...rows[0], attachments };
    },
    async homeHighlights() {
      const [updates, issues] = await Promise.all([
        pool.query("SELECT id, title, body AS excerpt, DATE_FORMAT(published_at, '%Y-%m-%d %H:%i:%s') AS publishedAtUtc FROM updates WHERE status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC, id DESC LIMIT 5"),
        pool.query("SELECT number, title, DATE_FORMAT(published_at, '%d.%m.%Y') AS publishedAt FROM issues WHERE status = 'published' AND deleted_at IS NULL ORDER BY number DESC LIMIT 3"),
      ]);
      return { updates, issues };
    },
    async hasUpdateDrafts() {
      const rows = await pool.query("SELECT 1 AS present FROM updates WHERE status = 'draft' AND deleted_at IS NULL LIMIT 1");
      return rows.length > 0;
    },
    async listTemplates(activeOnly = false) {
      return pool.query(`SELECT id, name, body, body_html AS bodyHtml, enabled, DATE_FORMAT(updated_at, '%d.%m.%Y %H:%i') AS updatedAt FROM content_templates ${activeOnly ? 'WHERE enabled = 1' : ''} ORDER BY id LIMIT 100`);
    },
    async saveTemplate(actor, id, name, bodyHtml, enabled) {
      const uuid = validActor(actor);
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (!cleanName || cleanName.length > 100 || typeof enabled !== 'boolean') throw new Error('Ungültiger Baustein.');
      const content = cleanRichText(bodyHtml, 10000);
      if (id === null) {
        return transact(async (conn) => {
          const count = await conn.query('SELECT COUNT(*) AS n FROM content_templates');
          if (Number(count[0]?.n) >= 100) throw new Error('Zu viele Bausteine.');
          const result = await conn.query('INSERT INTO content_templates (name, body, body_html, enabled, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [cleanName, content.plain, content.html, enabled, uuid, uuid]);
          const newId = Number(result.insertId);
          await audit(conn, uuid, 'template.create', 'template', newId);
          return newId;
        });
      }
      const templateId = validUpdateId(id);
      return transact(async (conn) => {
        const result = await conn.query('UPDATE content_templates SET name = ?, body = ?, body_html = ?, enabled = ?, updated_by = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?', [cleanName, content.plain, content.html, enabled, uuid, templateId]);
        if (Number(result.affectedRows) === 0) return null;
        await audit(conn, uuid, 'template.edit', 'template', templateId);
        return templateId;
      });
    },
    async createDraft(actor, title, body, submissionIds = [], bodyHtml = null) {
      const uuid = validActor(actor);
      const content = validText(title, body, bodyHtml);
      if (!Array.isArray(submissionIds) || submissionIds.length > 20) throw new Error('Zu viele Steckbriefe.');
      const fileIds = submissionIds.map(validUpdateId);
      if (new Set(fileIds).size !== fileIds.length) throw new Error('Doppelter Steckbrief.');
      return transact(async (conn) => {
        if (fileIds.length) {
          const found = await conn.query(`SELECT id FROM submissions WHERE status = 'taken_over' AND deleted_at IS NULL AND id IN (${fileIds.map(() => '?').join(',')}) FOR UPDATE`, fileIds);
          if (found.length !== fileIds.length) throw new Error('Steckbrief noch nicht übernommen.');
        }
        const result = await conn.query('INSERT INTO updates (title, body, body_html, created_by, updated_by) VALUES (?, ?, ?, ?, ?)', [content.title, content.body, content.bodyHtml, uuid, uuid]);
        const id = Number(result.insertId);
        for (const [index, fileId] of fileIds.entries()) await conn.query('INSERT INTO update_submissions (update_id, submission_id, position) VALUES (?, ?, ?)', [id, fileId, index + 1]);
        await audit(conn, uuid, 'update.create', 'update', id, content.title);
        return id;
      });
    },
    async editUpdate(actor, updateId, title, body, mode, bodyHtml = null) {
      const uuid = validActor(actor);
      const id = validUpdateId(updateId);
      const content = validText(title, body, bodyHtml);
      if (!['draft_edit', 'published_edit'].includes(mode)) throw new Error('Ungültige Änderung.');
      return transact(async (conn) => {
        const rows = await conn.query('SELECT title, body, body_html AS bodyHtml, status FROM updates WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (rows.length !== 1 || rows[0].status !== (mode === 'draft_edit' ? 'draft' : 'published')) return false;
        if (rows[0].title === content.title && rows[0].body === content.body && rows[0].bodyHtml === content.bodyHtml) return true;
        await conn.query('UPDATE updates SET title = ?, body = ?, body_html = ?, updated_by = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?', [content.title, content.body, content.bodyHtml, uuid, id]);
        await audit(conn, uuid, mode === 'draft_edit' ? 'update.edit' : 'update.published_edit', 'update', id, content.title);
        return true;
      });
    },
    async publishUpdate(actor, updateId) {
      const uuid = validActor(actor);
      const id = validUpdateId(updateId);
      return transact(async (conn) => {
        const rows = await conn.query('SELECT status, title FROM updates WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (rows.length !== 1 || rows[0].status !== 'draft') return false;
        await conn.query("UPDATE updates SET status = 'published', published_at = UTC_TIMESTAMP(6), published_by = ?, updated_by = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?", [uuid, uuid, id]);
        await audit(conn, uuid, 'update.publish', 'update', id, rows[0].title);
        return true;
      });
    },
    async deleteUpdate(actor, updateId) {
      const uuid = validActor(actor);
      const id = validUpdateId(updateId);
      return transact(async (conn) => {
        const rows = await conn.query('SELECT id, title, status FROM updates WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (rows.length !== 1) return false;
        await conn.query("UPDATE updates SET deleted_at = UTC_TIMESTAMP(6), deleted_by = ?, mail_suppressed = IF(status = 'published', TRUE, mail_suppressed) WHERE id = ?", [uuid, id]);
        await audit(conn, uuid, 'update.delete', 'update', id, rows[0].title);
        return true;
      });
    },
    async listOwnContributions(actor) {
      return pool.query("SELECT id, title, body, body_html AS bodyHtml, status, DATE_FORMAT(updated_at, '%d.%m.%Y %H:%i') AS updatedAt FROM contributions WHERE owner_uuid = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 100", [validActor(actor)]);
    },
    async listSubmittedContributions() {
      return pool.query("SELECT c.id, c.title, c.body, c.body_html AS bodyHtml, c.status, p.display_name AS author FROM contributions c JOIN iserv_identities p ON p.user_uuid = c.owner_uuid WHERE c.status = 'submitted' AND c.deleted_at IS NULL ORDER BY c.created_at DESC, c.id DESC LIMIT 100");
    },
    async listIssueContributions(options = {}) {
      return issueSourcePage(pool, 'contributions', options);
    },
    async saveContribution(actor, id, title, body, bodyHtml = null) {
      const uuid = validActor(actor);
      const content = validText(title, body, bodyHtml);
      return transact(async (conn) => {
        if (id === null) {
          const result = await conn.query('INSERT INTO contributions (owner_uuid, title, body, body_html) VALUES (?, ?, ?, ?)', [uuid, content.title, content.body, content.bodyHtml]);
          await audit(conn, uuid, 'contribution.submit', 'contribution', result.insertId, content.title);
          return Number(result.insertId);
        }
        const key = validUpdateId(id);
        const row = await conn.query("SELECT id FROM contributions WHERE id = ? AND owner_uuid = ? AND status = 'submitted' AND deleted_at IS NULL FOR UPDATE", [key, uuid]);
        if (!row.length) return null;
        await conn.query('UPDATE contributions SET title = ?, body = ?, body_html = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?', [content.title, content.body, content.bodyHtml, key]);
        await audit(conn, uuid, 'contribution.edit', 'contribution', key, content.title);
        return key;
      });
    },
    async deleteContribution(actor, id, editor = false) {
      const uuid = validActor(actor);
      const key = validUpdateId(id);
      if (typeof editor !== 'boolean') throw new Error('Ungültige Redaktionsrolle.');
      return transact(async (conn) => {
        const row = await conn.query(`SELECT title FROM contributions WHERE id = ?${editor ? '' : ' AND owner_uuid = ?'} AND status = 'submitted' AND deleted_at IS NULL FOR UPDATE`, editor ? [key] : [key, uuid]);
        if (!row.length) return false;
        await conn.query('UPDATE contributions SET deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?', [uuid, key]);
        await audit(conn, uuid, 'contribution.delete', 'contribution', key, row[0].title);
        return true;
      });
    },
    async subscriptionMode(actor) {
      const rows = await pool.query('SELECT mode FROM update_subscriptions WHERE user_uuid = ?', [validActor(actor)]);
      return rows[0]?.mode || 'off';
    },
    async setSubscription(actor, mode) {
      const uuid = validActor(actor);
      if (!['off', 'instant', 'daily', 'weekly'].includes(mode)) throw new Error('Ungültiger Abo-Status.');
      return transact(async (conn) => {
        const current = await conn.query('SELECT mode FROM update_subscriptions WHERE user_uuid = ? FOR UPDATE', [uuid]);
        if (current[0]?.mode === mode) return;
        await conn.query('INSERT INTO update_subscriptions (user_uuid, enabled, mode) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), mode = VALUES(mode), changed_at = UTC_TIMESTAMP(6)', [uuid, mode !== 'off', mode]);
        await audit(conn, uuid, mode === 'off' ? 'subscription.disable' : 'subscription.enable', 'subscription', uuid);
      });
    },
    async pendingUpdateMail(mode, limit = 50, cutoffUtc = null, afterUserUuid = null) {
      if (!['instant', 'daily', 'weekly'].includes(mode) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Ungültige Mailauswahl.');
      if (mode === 'daily' && !/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(cutoffUtc || '')) throw new Error('Ungültiges tägliches Versandfenster.');
      const cursor = afterUserUuid === null ? null : validActor(afterUserUuid);
      const cursorFilter = cursor ? ' AND s.user_uuid > ?' : '';
      const dailyFilter = mode === 'daily' ? ' AND u.published_at < ? AND NOT EXISTS (SELECT 1 FROM update_mail_delivery recent WHERE recent.user_uuid = s.user_uuid AND recent.requested_at >= ?)' : '';
      return pool.query(`SELECT s.user_uuid AS userUuid, p.display_name AS name, p.email, u.id, u.title, u.body, u.body_html AS bodyHtml FROM update_subscriptions s JOIN iserv_identities p ON p.user_uuid = s.user_uuid JOIN updates u ON u.status = 'published' AND u.deleted_at IS NULL AND u.mail_suppressed = FALSE AND u.published_at >= s.changed_at LEFT JOIN update_mail_delivery d ON d.user_uuid = s.user_uuid AND d.update_id = u.id WHERE s.mode = ? AND p.email IS NOT NULL AND LOWER(p.email) <> 'staff@school.example' AND d.update_id IS NULL${cursorFilter}${dailyFilter} ORDER BY s.user_uuid, u.published_at, u.id LIMIT ${limit}`, [mode, ...(cursor ? [cursor] : []), ...(mode === 'daily' ? [cutoffUtc, cutoffUtc] : [])]);
    },
    async claimUpdateMail(actor, updateIds, mode, cutoffUtc = null) {
      const uuid = validActor(actor);
      if (!['instant', 'daily', 'weekly'].includes(mode) || !Array.isArray(updateIds) || !updateIds.length || updateIds.length > 50) throw new Error('Ungültige Mailauswahl.');
      if (mode === 'daily' && !/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(cutoffUtc || '')) throw new Error('Ungültiges tägliches Versandfenster.');
      const ids = updateIds.map(validUpdateId);
      if (new Set(ids).size !== ids.length) throw new Error('Doppelte Mailauswahl.');
      return transact(async (conn) => {
        const dailyFilter = mode === 'daily' ? ' AND u.published_at < ? AND NOT EXISTS (SELECT 1 FROM update_mail_delivery recent WHERE recent.user_uuid = s.user_uuid AND recent.requested_at >= ?)' : '';
        const selected = await conn.query(`SELECT u.id, p.display_name AS recipientName FROM updates u JOIN update_subscriptions s ON s.user_uuid = ? AND s.mode = ? AND u.published_at >= s.changed_at JOIN iserv_identities p ON p.user_uuid = s.user_uuid LEFT JOIN update_mail_delivery d ON d.user_uuid = ? AND d.update_id = u.id WHERE u.status = 'published' AND u.deleted_at IS NULL AND u.mail_suppressed = FALSE AND d.update_id IS NULL AND u.id IN (${ids.map(() => '?').join(',')})${dailyFilter} FOR UPDATE`, [uuid, mode, uuid, ...ids, ...(mode === 'daily' ? [cutoffUtc, cutoffUtc] : [])]);
        if (selected.length !== ids.length) return false;
        for (const id of ids) await conn.query("INSERT INTO update_mail_delivery (user_uuid, update_id, status) VALUES (?, ?, 'sending')", [uuid, id]);
        await writeAudit(conn, null, 'update.mail_start', 'subscription', uuid, selected[0].recipientName || null);
        return true;
      });
    },
    async releaseUpdateMail(actor, updateIds) {
      const uuid = validActor(actor);
      if (!Array.isArray(updateIds) || !updateIds.length || updateIds.length > 50) throw new Error('Ungültige Mailauswahl.');
      const ids = updateIds.map(validUpdateId);
      if (new Set(ids).size !== ids.length) throw new Error('Doppelte Mailauswahl.');
      return transact(async (conn) => {
        const result = await conn.query(`DELETE FROM update_mail_delivery WHERE user_uuid = ? AND status = 'sending' AND update_id IN (${ids.map(() => '?').join(',')})`, [uuid, ...ids]);
        if (Number(result.affectedRows) !== ids.length) throw new Error('Mailreservierung konnte nicht freigegeben werden.');
      });
    },
    async finishUpdateMail(actor, updateIds, sent) {
      const uuid = validActor(actor);
      if (typeof sent !== 'boolean' || !Array.isArray(updateIds) || !updateIds.length || updateIds.length > 50) throw new Error('Ungültiger Mailstatus.');
      await transact(async (conn) => {
        for (const id of updateIds.map(validUpdateId)) {
          const result = await conn.query("UPDATE update_mail_delivery SET status = ?, finished_at = UTC_TIMESTAMP(6) WHERE user_uuid = ? AND update_id = ? AND status = 'sending'", [sent ? 'sent' : 'uncertain', uuid, id]);
          if (Number(result.affectedRows) !== 1) throw new Error('Mailstatus konnte nicht abgeschlossen werden.');
        }
        const recipient = await conn.query('SELECT display_name AS name FROM iserv_identities WHERE user_uuid = ?', [uuid]);
        await writeAudit(conn, null, sent ? 'update.mail_sent' : 'update.mail_uncertain', 'subscription', uuid, recipient[0]?.name || null);
      }, true);
    },
    async recordSearch(actor, term, source) {
      const uuid = validActor(actor);
      const clean = typeof term === 'string' ? term.replace(/\s+/g, ' ').trim() : '';
      if (clean.length < 2 || clean.length > 200 || !['all', 'archive'].includes(source)) throw new Error('Ungültige Suche.');
      await pool.query('INSERT INTO search_events (actor_uuid, term, source) VALUES (?, ?, ?)', [uuid, clean, source]);
      await pool.query('DELETE FROM search_events WHERE searched_at < UTC_TIMESTAMP(6) - INTERVAL 90 DAY');
    },
    async pruneSearchEvents() {
      await pool.query('DELETE FROM search_events WHERE searched_at < UTC_TIMESTAMP(6) - INTERVAL 90 DAY');
    },
    async listAudit(before = null, limit = 200, filters = {}) {
      if (before !== null && (typeof before !== 'string' || !/^[1-9][0-9]{0,19}$/.test(before))) throw new Error('Ungültiger Audit-Cursor.');
      if (![200, 1000].includes(limit)) throw new Error('Ungültige Audit-Seitengröße.');
      const { clauses, params } = auditFilterConditions(filters);
      if (before) { clauses.push('e.id < ?'); params.push(before); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return pool.query(`SELECT e.id, DATE_FORMAT(e.occurred_at, '%Y-%m-%d %H:%i:%s') AS occurredAt, e.actor_uuid AS actorUuid, p.display_name AS actorName, e.action, e.object_type AS objectType, e.object_id AS objectId, COALESCE(e.object_title, u.title, draft_issue.title, published_issue.title) AS objectTitle, im.stored_name AS imageName FROM audit_events e LEFT JOIN iserv_identities p ON p.user_uuid = e.actor_uuid${auditUpdateJoin}${auditIssueJoin} LEFT JOIN editor_images im ON e.object_type = 'image' AND im.id = e.object_id ${where} ORDER BY e.id DESC LIMIT ?`, [...params, limit]);
    },
    async listAuditPage(page = 1, filters = {}, through = null) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 2000) throw new Error('Ungültige Audit-Seite.');
      if (through !== null && (typeof through !== 'string' || !/^[1-9][0-9]{0,19}$/.test(through))) throw new Error('Ungültiger Audit-Snapshot.');
      const { clauses, params, countJoin } = auditFilterConditions(filters);
      const conditions = [...(through ? ['e.id <= ?'] : []), ...clauses];
      const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const counts = await pool.query(`SELECT COUNT(*) AS count, MAX(e.id) AS newestId FROM audit_events e LEFT JOIN iserv_identities p ON p.user_uuid = e.actor_uuid${countJoin} ${countWhere}`, through ? [through, ...params] : params);
      const snapshot = through || String(counts[0]?.newestId || '');
      const pageCount = Math.max(1, Math.min(2000, Math.ceil(Number(counts[0]?.count || 0) / 50)));
      if (!snapshot) return { events: [], hasMore: false, page, pageCount, through: '' };
      const rows = await pool.query(`SELECT e.id, DATE_FORMAT(e.occurred_at, '%Y-%m-%d %H:%i:%s') AS occurredAt, e.actor_uuid AS actorUuid, p.display_name AS actorName, e.action, e.object_type AS objectType, e.object_id AS objectId, COALESCE(e.object_title, u.title, draft_issue.title, published_issue.title) AS objectTitle, im.stored_name AS imageName FROM audit_events e LEFT JOIN iserv_identities p ON p.user_uuid = e.actor_uuid${auditUpdateJoin}${auditIssueJoin} LEFT JOIN editor_images im ON e.object_type = 'image' AND im.id = e.object_id WHERE e.id <= ?${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT ? OFFSET ?`, [snapshot, ...params, 51, (page - 1) * 50]);
      return { events: rows.slice(0, 50), hasMore: rows.length > 50, page, pageCount, through: snapshot };
    },
    async listUsageStats(days = 30) {
      if (![7, 30, 90].includes(days)) throw new Error('Ungültiger Zeitraum.');
      await pool.query('DELETE FROM search_events WHERE searched_at < UTC_TIMESTAMP(6) - INTERVAL 90 DAY');
      const range = `day >= UTC_DATE() - INTERVAL ${days - 1} DAY`;
      const [daily, topContent, activeUsers, subscriptions, searchTerms, searchPeople] = await Promise.all([
        pool.query(`SELECT DATE_FORMAT(day, '%d.%m.%Y') AS day, action, SUM(event_count) AS eventCount FROM daily_usage WHERE ${range} GROUP BY day, action ORDER BY day DESC, action LIMIT 3000`),
        pool.query(`SELECT action, object_type AS objectType, object_id AS objectId, SUM(event_count) AS eventCount FROM daily_usage WHERE ${range} AND action IN ('archive.pdf','issue.view','issue.pdf','update.view','submission.published_file') GROUP BY action, object_type, object_id ORDER BY eventCount DESC LIMIT 10`),
        pool.query(`SELECT COUNT(DISTINCT actor_uuid) AS count FROM audit_events WHERE occurred_at >= UTC_TIMESTAMP() - INTERVAL ${days} DAY`),
        pool.query('SELECT COUNT(*) AS count FROM update_subscriptions WHERE enabled = 1'),
        pool.query(`SELECT term, COUNT(*) AS eventCount FROM search_events WHERE searched_at >= UTC_TIMESTAMP(6) - INTERVAL ${days} DAY GROUP BY term ORDER BY eventCount DESC, term LIMIT 20`),
        pool.query(`SELECT se.term, COALESCE(p.display_name, 'Unbekanntes Konto') AS person, COUNT(*) AS eventCount, DATE_FORMAT(MAX(se.searched_at), '%Y-%m-%d %H:%i:%s') AS lastAtUtc FROM search_events se LEFT JOIN iserv_identities p ON p.user_uuid = se.actor_uuid WHERE se.searched_at >= UTC_TIMESTAMP(6) - INTERVAL ${days} DAY GROUP BY se.term, se.actor_uuid, p.display_name ORDER BY eventCount DESC, lastAtUtc DESC LIMIT 50`),
      ]);
      return { days, daily, topContent, searchTerms, searchPeople, activeUsers: Number(activeUsers[0]?.count || 0), subscriptions: Number(subscriptions[0]?.count || 0) };
    },
    async searchPublished(query) {
      if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 100) throw new Error('Ungültige Suche.');
      const term = query.trim();
      const [updates, issues] = await Promise.all([
        pool.query("SELECT id, title, LEFT(body, 240) AS excerpt FROM updates WHERE status = 'published' AND deleted_at IS NULL AND (LOCATE(?, title) > 0 OR LOCATE(?, body) > 0) ORDER BY published_at DESC, id DESC LIMIT 30", [term, term]),
        pool.query("SELECT i.number, i.title, LEFT(i.body, 240) AS excerpt FROM issues i WHERE i.status = 'published' AND i.deleted_at IS NULL AND (LOCATE(?, i.title) > 0 OR LOCATE(?, i.body) > 0 OR EXISTS(SELECT 1 FROM issue_updates iu WHERE iu.issue_id = i.id AND (LOCATE(?, iu.snapshot_title) > 0 OR LOCATE(?, iu.snapshot_body) > 0)) OR EXISTS(SELECT 1 FROM issue_contributions ic WHERE ic.issue_id = i.id AND (LOCATE(?, ic.snapshot_title) > 0 OR LOCATE(?, ic.snapshot_body) > 0 OR LOCATE(?, ic.snapshot_author) > 0))) ORDER BY i.number DESC LIMIT 30", [term, term, term, term, term, term, term]),
      ]);
      return { updates, issues };
    },
    async hasIssueDrafts() {
      const rows = await pool.query("SELECT 1 AS present FROM issues WHERE status = 'draft' AND deleted_at IS NULL LIMIT 1");
      return rows.length > 0;
    },
    async getPublishedIssue(number) {
      const n = validUpdateId(number);
      const conn = await pool.getConnection();
      try {
        await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await conn.query('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');
        const rows = await conn.query("SELECT number, title, body, body_html AS bodyHtml, school_year AS schoolYear, period, DATE_FORMAT(published_at, '%d.%m.%Y') AS publishedAt FROM issues WHERE status = 'published' AND deleted_at IS NULL AND number = ?", [n]);
        if (rows.length !== 1) {
          await conn.commit();
          return null;
        }
        const updates = await conn.query('SELECT iu.id AS snapshotId, iu.update_id AS updateId, iu.snapshot_title AS title, iu.snapshot_body AS body, iu.snapshot_body_html AS bodyHtml FROM issue_updates iu JOIN issues i ON i.id = iu.issue_id WHERE i.number = ? AND i.status = ? AND i.deleted_at IS NULL ORDER BY iu.position', [n, 'published']);
        const contributions = await conn.query("SELECT ic.contribution_id AS contributionId, ic.snapshot_title AS title, ic.snapshot_body AS body, ic.snapshot_body_html AS bodyHtml, ic.snapshot_author AS author FROM issue_contributions ic JOIN issues i ON i.id = ic.issue_id WHERE i.number = ? AND i.status = 'published' AND i.deleted_at IS NULL ORDER BY ic.position", [n]);
        const attachments = await conn.query("SELECT s.id, s.title, s.media_type AS mediaType, s.stored_name AS storedName, p.display_name AS ownerName FROM issue_submissions isu JOIN submissions s ON s.id = isu.submission_id LEFT JOIN iserv_identities p ON p.user_uuid = s.owner_uuid JOIN issues i ON i.id = isu.issue_id WHERE i.number = ? AND i.status = 'published' AND i.deleted_at IS NULL ORDER BY isu.position", [n]);
        await conn.commit();
        return { ...rows[0], updates, contributions, attachments };
      } catch (error) {
        try { await conn.rollback(); } catch { /* preserve original error */ }
        throw error;
      } finally {
        await conn.release();
      }
    },
    async issueMailStatus(number) {
      const rows = await pool.query("SELECT im.status FROM issue_mail_delivery im JOIN issues i ON i.id = im.issue_id WHERE i.number = ? AND i.status = 'published' AND i.deleted_at IS NULL", [validUpdateId(number)]);
      return rows[0]?.status || null;
    },
    async startIssueMail(actor, number) {
      const uuid = validActor(actor);
      const n = validUpdateId(number);
      return transact(async (conn) => {
        const rows = await conn.query("SELECT id FROM issues WHERE number = ? AND status = 'published' AND deleted_at IS NULL FOR UPDATE", [n]);
        if (rows.length !== 1) return false;
        const existing = await conn.query('SELECT status FROM issue_mail_delivery WHERE issue_id = ?', [rows[0].id]);
        if (existing.length) return false;
        await conn.query("INSERT INTO issue_mail_delivery (issue_id, status, requested_by) VALUES (?, 'sending', ?)", [rows[0].id, uuid]);
        await audit(conn, uuid, 'issue.mail_start', 'issue', n);
        return true;
      });
    },
    async finishIssueMail(actor, number, sent) {
      const uuid = validActor(actor);
      const n = validUpdateId(number);
      return transact(async (conn) => {
        const result = await conn.query("UPDATE issue_mail_delivery im JOIN issues i ON i.id = im.issue_id SET im.status = ?, im.finished_at = UTC_TIMESTAMP(6) WHERE i.number = ? AND im.status = 'sending'", [sent ? 'sent' : 'uncertain', n]);
        if (Number(result.affectedRows) !== 1) throw new Error('Mailstatus konnte nicht abgeschlossen werden.');
        await audit(conn, uuid, sent ? 'issue.mail_sent' : 'issue.mail_uncertain', 'issue', n);
      });
    },
    async markIssueUpdatesMailed(number) {
      const n = validUpdateId(number);
      await pool.query("INSERT IGNORE INTO update_mail_delivery (user_uuid, update_id, status, requested_at, finished_at) SELECT s.user_uuid, iu.update_id, 'sent', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) FROM issues i JOIN issue_updates iu ON iu.issue_id = i.id JOIN updates u ON u.id = iu.update_id JOIN update_subscriptions s ON s.mode IN ('instant', 'daily', 'weekly') AND u.published_at >= s.changed_at WHERE i.number = ? AND i.status = 'published' AND i.deleted_at IS NULL AND u.deleted_at IS NULL AND iu.update_id IS NOT NULL", [n]);
    },
    async createIssueDraft(actor, title, body, schoolYear, period, updateIds, bodyHtml = null) {
      const uuid = validActor(actor);
      const content = validIssue(title, body, schoolYear, period, updateIds, bodyHtml);
      if (!content.body && !content.ids.length) throw new Error('Ausgabe ohne Inhalt.');
      return transact(async (conn) => {
        if (content.ids.length) {
          const found = await conn.query(`SELECT id FROM updates WHERE status = 'published' AND deleted_at IS NULL AND id IN (${content.ids.map(() => '?').join(',')})`, content.ids);
          if (found.length !== content.ids.length) throw new Error('Ein gewähltes Update ist nicht veröffentlicht.');
        }
        const result = await conn.query('INSERT INTO issues (title, body, body_html, school_year, period, created_by) VALUES (?, ?, ?, ?, ?, ?)', [content.title, content.body, content.bodyHtml, content.schoolYear, content.period, uuid]);
        const issueId = Number(result.insertId);
        for (const [index, updateId] of content.ids.entries()) await conn.query('INSERT INTO issue_updates (issue_id, update_id, position) VALUES (?, ?, ?)', [issueId, updateId, index + 1]);
        await audit(conn, uuid, 'issue.create', 'issue', issueId, content.title);
        return issueId;
      });
    },
    async publishIssue(actor, issueId) {
      const uuid = validActor(actor);
      const id = validUpdateId(issueId);
      return transact(async (conn) => {
        const issues = await conn.query('SELECT status, title FROM issues WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (issues.length !== 1 || issues[0].status !== 'draft') return null;
        const number = await reserveIssueNumber(conn);
        const links = await conn.query('SELECT iu.update_id AS updateId, u.title, u.body, u.body_html AS bodyHtml, u.status, u.deleted_at AS deletedAt FROM issue_updates iu LEFT JOIN updates u ON u.id = iu.update_id WHERE iu.issue_id = ? ORDER BY iu.position FOR UPDATE', [id]);
        if (links.some((row) => row.status !== 'published' || row.deletedAt !== null)) throw new Error('Ein gewähltes Update ist nicht mehr veröffentlicht.');
        for (const item of links) await conn.query('UPDATE issue_updates SET snapshot_title = ?, snapshot_body = ?, snapshot_body_html = ? WHERE issue_id = ? AND update_id = ?', [item.title, item.body, item.bodyHtml, id, item.updateId]);
        const attachments = await conn.query('SELECT us.submission_id AS submissionId FROM issue_updates iu JOIN update_submissions us ON us.update_id = iu.update_id WHERE iu.issue_id = ? ORDER BY iu.position, us.position', [id]);
        const seen = new Set();
        for (const item of attachments) {
          if (seen.has(item.submissionId)) continue;
          seen.add(item.submissionId);
          await conn.query('INSERT INTO issue_submissions (issue_id, submission_id, position) VALUES (?, ?, ?)', [id, item.submissionId, seen.size]);
        }
        await conn.query("UPDATE issues SET number = ?, status = 'published', published_at = UTC_TIMESTAMP(6), published_by = ? WHERE id = ?", [number, uuid, id]);
        await audit(conn, uuid, 'issue.publish', 'issue', number, issues[0].title);
        return number;
      });
    },
    async createAndPublishIssue(actor, title, body, schoolYear, period, updateIds, bodyHtml = null, submissionIds = [], contributionIds = []) {
      const uuid = validActor(actor);
      const content = validIssue(title, body, schoolYear, period, updateIds, bodyHtml, submissionIds, contributionIds);
      if (!content.body && !content.ids.length && !content.files.length && !content.articles.length) throw new Error('Ausgabe ohne Inhalt.');
      return transact(async (conn) => {
        const number = await reserveIssueNumber(conn);
        const links = content.ids.length ? await conn.query(`SELECT id, title, body, body_html AS bodyHtml, status FROM updates WHERE deleted_at IS NULL AND id IN (${content.ids.map(() => '?').join(',')}) FOR UPDATE`, content.ids) : [];
        if (links.length !== content.ids.length || links.some((row) => row.status !== 'published')) throw new Error('Ein gewähltes Update ist nicht veröffentlicht.');
        await checkedSubmissions(conn, content.files);
        const byId = new Map(links.map((row) => [row.id, row]));
        const result = await conn.query("INSERT INTO issues (number, title, body, body_html, school_year, period, status, created_by, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(6))", [number, content.title, content.body, content.bodyHtml, content.schoolYear, content.period, uuid, uuid]);
        const issueId = Number(result.insertId);
        for (const [index, updateId] of content.ids.entries()) {
          const item = byId.get(updateId);
          await conn.query('INSERT INTO issue_updates (issue_id, update_id, position, snapshot_title, snapshot_body, snapshot_body_html) VALUES (?, ?, ?, ?, ?, ?)', [issueId, updateId, index + 1, item.title, item.body, item.bodyHtml]);
        }
        await snapshotContributions(conn, issueId, content.articles, uuid);
        const files = await issueSubmissionIds(conn, content.ids, content.files);
        for (const [index, fileId] of files.entries()) await conn.query('INSERT INTO issue_submissions (issue_id, submission_id, position) VALUES (?, ?, ?)', [issueId, fileId, index + 1]);
        await audit(conn, uuid, 'issue.publish', 'issue', number, content.title);
        return number;
      });
    },
    async editPublishedIssue(actor, number, title, body, period, updateIds, submissionIds, keepSnapshotIds = [], bodyHtml = null, contributionIds = []) {
      const uuid = validActor(actor);
      const n = validUpdateId(number);
      const content = validIssue(title, body, '', period, updateIds, bodyHtml, submissionIds, contributionIds);
      if (!Array.isArray(keepSnapshotIds) || keepSnapshotIds.length > 50) throw new Error('Ungültige gespeicherte Beiträge.');
      const retained = keepSnapshotIds.map(validUpdateId);
      if (new Set(retained).size !== retained.length || (!content.body && !content.ids.length && !content.files.length && !retained.length && !content.articles.length)) throw new Error('Ausgabe ohne Inhalt oder doppelte Auswahl.');
      return transact(async (conn) => {
        const rows = await conn.query("SELECT id FROM issues WHERE number = ? AND status = 'published' AND deleted_at IS NULL FOR UPDATE", [n]);
        if (rows.length !== 1) return false;
        const issueId = rows[0].id;
        const oldLinks = await conn.query('SELECT id, update_id AS updateId, snapshot_title AS title, snapshot_body AS body, snapshot_body_html AS bodyHtml FROM issue_updates WHERE issue_id = ? ORDER BY position FOR UPDATE', [issueId]);
        const orphaned = new Map(oldLinks.filter((row) => row.updateId === null).map((row) => [Number(row.id), row]));
        if (retained.some((id) => !orphaned.has(id))) throw new Error('Ungültige gespeicherte Beiträge.');
        const live = content.ids.length ? await conn.query(`SELECT id, title, body, body_html AS bodyHtml FROM updates WHERE status = 'published' AND deleted_at IS NULL AND id IN (${content.ids.map(() => '?').join(',')}) FOR UPDATE`, content.ids) : [];
        if (live.length !== content.ids.length) throw new Error('Ein gewähltes Update ist nicht veröffentlicht.');
        await checkedSubmissions(conn, content.files);
        const byId = new Map(live.map((row) => [Number(row.id), row]));
        await conn.query('DELETE FROM issue_updates WHERE issue_id = ?', [issueId]);
        let position = 0;
        for (const updateId of content.ids) {
          const item = byId.get(updateId);
          await conn.query('INSERT INTO issue_updates (issue_id, update_id, position, snapshot_title, snapshot_body, snapshot_body_html) VALUES (?, ?, ?, ?, ?, ?)', [issueId, updateId, ++position, item.title, item.body, item.bodyHtml]);
        }
        for (const snapshotId of retained) {
          const item = orphaned.get(snapshotId);
          await conn.query('INSERT INTO issue_updates (issue_id, update_id, position, snapshot_title, snapshot_body, snapshot_body_html) VALUES (?, NULL, ?, ?, ?, ?)', [issueId, ++position, item.title, item.body, item.bodyHtml]);
        }
        const oldContributions = await conn.query('SELECT contribution_id AS id FROM issue_contributions WHERE issue_id = ? FOR UPDATE', [issueId]);
        const oldIds = oldContributions.map((row) => Number(row.id)).filter(Boolean);
        await conn.query('DELETE FROM issue_contributions WHERE issue_id = ?', [issueId]);
        await snapshotContributions(conn, issueId, content.articles, uuid, new Set(oldIds));
        await releaseRemovedContributions(conn, oldIds.filter((id) => !content.articles.includes(id)));
        await conn.query('DELETE FROM issue_submissions WHERE issue_id = ?', [issueId]);
        for (const [index, fileId] of content.files.entries()) await conn.query('INSERT INTO issue_submissions (issue_id, submission_id, position) VALUES (?, ?, ?)', [issueId, fileId, index + 1]);
        await conn.query('UPDATE issues SET title = ?, body = ?, body_html = ?, period = ? WHERE id = ?', [content.title, content.body, content.bodyHtml, content.period, issueId]);
        await audit(conn, uuid, 'issue.edit', 'issue', n, content.title);
        return true;
      });
    },
    async deleteIssue(actor, number) {
      const uuid = validActor(actor);
      const n = validUpdateId(number);
      return transact(async (conn) => {
        await conn.query('SELECT next_number FROM issue_sequence WHERE id = 1 FOR UPDATE');
        const rows = await conn.query('SELECT id, title FROM issues WHERE number = ? AND deleted_at IS NULL FOR UPDATE', [n]);
        if (rows.length !== 1) return false;
        const id = rows[0].id;
        const delivery = await conn.query('SELECT status FROM issue_mail_delivery WHERE issue_id = ?', [id]);
        if (delivery.length) throw new Error('Eine Ausgabe mit begonnenem Mailversand kann nicht gelöscht werden.');
        await conn.query('UPDATE issues SET deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?', [uuid, id]);
        await audit(conn, uuid, 'issue.delete', 'issue', n, rows[0].title);
        return true;
      });
    },
    async deleteIssueDraft(actor, issueId) {
      const uuid = validActor(actor);
      const id = validUpdateId(issueId);
      return transact(async (conn) => {
        const rows = await conn.query('SELECT title, status FROM issues WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (rows.length !== 1 || rows[0].status !== 'draft') return false;
        await conn.query('UPDATE issues SET deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?', [uuid, id]);
        await audit(conn, uuid, 'issue.draft_delete', 'issue', id, rows[0].title);
        return true;
      });
    },
    async createEditorImage(actor, storedName, mediaType, byteSize) {
      const uuid = validActor(actor);
      if (!UUID.test(storedName) || !['image/jpeg', 'image/png', 'image/webp'].includes(mediaType) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 3 * 1024 * 1024) throw new Error('Ungültiges Redaktionsbild.');
      return transact(async (conn) => {
        const result = await conn.query('INSERT INTO editor_images (stored_name, media_type, byte_size, uploaded_by) VALUES (?, ?, ?, ?)', [storedName.toLowerCase(), mediaType, byteSize, uuid]);
        await audit(conn, uuid, 'image.upload', 'image', result.insertId);
      });
    },
    async getEditorImage(storedName) {
      if (typeof storedName !== 'string' || !UUID.test(storedName)) return null;
      const rows = await pool.query('SELECT id, stored_name AS storedName, media_type AS mediaType, uploaded_by AS uploadedBy FROM editor_images WHERE stored_name = ?', [storedName.toLowerCase()]);
      return rows[0] || null;
    },
    async isEditorImagePublished(storedName) {
      if (typeof storedName !== 'string' || !UUID.test(storedName)) return false;
      const marker = `src="/bbsinfo/editor-images/${storedName.toLowerCase()}"`;
      const rows = await pool.query("SELECT (EXISTS(SELECT 1 FROM updates WHERE status = 'published' AND deleted_at IS NULL AND LOCATE(?, body_html) > 0) OR EXISTS(SELECT 1 FROM issues WHERE status = 'published' AND deleted_at IS NULL AND LOCATE(?, body_html) > 0) OR EXISTS(SELECT 1 FROM issue_updates iu JOIN issues i ON i.id = iu.issue_id WHERE i.status = 'published' AND i.deleted_at IS NULL AND LOCATE(?, iu.snapshot_body_html) > 0) OR EXISTS(SELECT 1 FROM issue_contributions ic JOIN issues i ON i.id = ic.issue_id WHERE i.status = 'published' AND i.deleted_at IS NULL AND LOCATE(?, ic.snapshot_body_html) > 0)) AS allowed", [marker, marker, marker, marker]);
      return !!rows[0]?.allowed;
    },
    async createSubmission(actor, title, note, storedName, mediaType, byteSize) {
      const uuid = validActor(actor);
      const submission = validSubmission(title, note, storedName, mediaType, byteSize);
      return transact(async (conn) => {
        const result = await conn.query('INSERT INTO submissions (owner_uuid, title, note, stored_name, media_type, byte_size) VALUES (?, ?, ?, ?, ?, ?)', [uuid, submission.title, submission.note, submission.storedName, submission.mediaType, submission.byteSize]);
        const id = Number(result.insertId);
        await audit(conn, uuid, 'submission.create', 'submission', id);
        return id;
      });
    },
    async listOwnSubmissions(actor) {
      return pool.query("SELECT id, title, note, media_type AS mediaType, byte_size AS byteSize, status, DATE_FORMAT(created_at, '%d.%m.%Y %H:%i') AS createdAt FROM submissions WHERE owner_uuid = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 100", [validActor(actor)]);
    },
    async listAllSubmissions() {
      return pool.query("SELECT s.id, s.owner_uuid AS ownerUuid, p.display_name AS ownerName, s.title, s.note, s.media_type AS mediaType, s.byte_size AS byteSize, s.status, DATE_FORMAT(s.created_at, '%d.%m.%Y %H:%i') AS createdAt FROM submissions s LEFT JOIN iserv_identities p ON p.user_uuid = s.owner_uuid WHERE s.deleted_at IS NULL ORDER BY s.id DESC LIMIT 100");
    },
    async listTakenOverSubmissions() {
      return pool.query("SELECT s.id, s.title, s.owner_uuid AS ownerUuid, p.display_name AS ownerName, (EXISTS(SELECT 1 FROM update_submissions us WHERE us.submission_id = s.id) OR EXISTS(SELECT 1 FROM issue_submissions isu WHERE isu.submission_id = s.id)) AS linked FROM submissions s LEFT JOIN iserv_identities p ON p.user_uuid = s.owner_uuid WHERE s.status = 'taken_over' AND s.deleted_at IS NULL ORDER BY s.id DESC LIMIT 100");
    },
    async listIssueSubmissions(options = {}) {
      return issueSourcePage(pool, 'submissions', options);
    },
    async getSubmission(submissionId, trashed = false) {
      if (typeof trashed !== 'boolean') throw new Error('Ungültige Dateiansicht.');
      const rows = await pool.query(`SELECT id, owner_uuid AS ownerUuid, title, note, stored_name AS storedName, media_type AS mediaType, byte_size AS byteSize, status FROM submissions WHERE id = ? AND ${trashed ? "status IN ('submitted', 'taken_over') AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY" : 'deleted_at IS NULL'}`, [validUpdateId(submissionId)]);
      return rows.length === 1 ? rows[0] : null;
    },
    async isPublishedSubmission(submissionId) {
      const id = validUpdateId(submissionId);
      const rows = await pool.query("SELECT (EXISTS(SELECT 1 FROM update_submissions us JOIN updates u ON u.id = us.update_id WHERE us.submission_id = ? AND u.status = 'published' AND u.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM issue_submissions isu JOIN issues i ON i.id = isu.issue_id WHERE isu.submission_id = ? AND i.status = 'published' AND i.deleted_at IS NULL)) AS allowed", [id, id]);
      return !!rows[0]?.allowed;
    },
    async takeOverSubmission(actor, submissionId) {
      const uuid = validActor(actor);
      const id = validUpdateId(submissionId);
      return transact(async (conn) => {
        const rows = await conn.query('SELECT status FROM submissions WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (rows.length !== 1 || rows[0].status !== 'submitted') return false;
        await conn.query("UPDATE submissions SET status = 'taken_over', taken_at = UTC_TIMESTAMP(6), taken_by = ? WHERE id = ?", [uuid, id]);
        await audit(conn, uuid, 'submission.take_over', 'submission', id);
        return true;
      });
    },
    async replaceSubmission(actor, submissionId, title, note, storedName, mediaType, byteSize) {
      const uuid = validActor(actor);
      const id = validUpdateId(submissionId);
      const submission = validSubmission(title, note, storedName, mediaType, byteSize);
      return transact(async (conn) => {
        const rows = await conn.query('SELECT owner_uuid AS ownerUuid, status, stored_name AS storedName FROM submissions WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (rows.length !== 1 || rows[0].ownerUuid !== uuid || rows[0].status !== 'submitted') return null;
        await conn.query('UPDATE submissions SET title = ?, note = ?, stored_name = ?, media_type = ?, byte_size = ? WHERE id = ?', [submission.title, submission.note, submission.storedName, submission.mediaType, submission.byteSize, id]);
        await audit(conn, uuid, 'submission.replace', 'submission', id);
        return rows[0].storedName;
      });
    },
    async deleteSubmission(actor, submissionId, editor = false) {
      const uuid = validActor(actor);
      const id = validUpdateId(submissionId);
      if (typeof editor !== 'boolean') throw new Error('Ungültige Redaktionsrolle.');
      return transact(async (conn) => {
        const rows = await conn.query('SELECT owner_uuid AS ownerUuid, status, title, stored_name AS storedName FROM submissions WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
        if (rows.length !== 1 || (!editor && rows[0].ownerUuid !== uuid) || !['submitted', 'taken_over'].includes(rows[0].status) || (!editor && rows[0].status !== 'submitted')) return null;
        const linked = await conn.query('SELECT (EXISTS(SELECT 1 FROM update_submissions WHERE submission_id = ?) OR EXISTS(SELECT 1 FROM issue_submissions WHERE submission_id = ?)) AS used', [id, id]);
        if (Number(linked[0]?.used || 0) !== 0) return null;
        await conn.query('UPDATE submissions SET deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?', [uuid, id]);
        await audit(conn, uuid, 'submission.delete', 'submission', id, rows[0].title);
        return rows[0].storedName;
      });
    },
    async listTrash(actor, editor = false, page = 1) {
      const uuid = validActor(actor);
      if (typeof editor !== 'boolean' || !Number.isSafeInteger(page) || page < 1 || page > 2000) throw new Error('Ungültige Papierkorbansicht.');
      const limit = 51;
      const offset = (page - 1) * 50;
      const [updates, issues, contributions, submissions] = await Promise.all([
        editor ? pool.query("SELECT id, title, status, DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s') AS deletedAtUtc FROM updates WHERE deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY ORDER BY deleted_at DESC, id DESC LIMIT ? OFFSET ?", [limit, offset]) : Promise.resolve([]),
        editor ? pool.query("SELECT id, number, title, status, DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s') AS deletedAtUtc FROM issues WHERE deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY ORDER BY deleted_at DESC, id DESC LIMIT ? OFFSET ?", [limit, offset]) : Promise.resolve([]),
        pool.query(`SELECT c.id, c.title, c.body, c.body_html AS bodyHtml, p.display_name AS ownerName, DATE_FORMAT(c.deleted_at, '%Y-%m-%d %H:%i:%s') AS deletedAtUtc FROM contributions c LEFT JOIN iserv_identities p ON p.user_uuid = c.owner_uuid WHERE ${editor ? '' : 'c.owner_uuid = ? AND '}c.status = 'submitted' AND c.deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY ORDER BY c.deleted_at DESC, c.id DESC LIMIT ? OFFSET ?`, editor ? [limit, offset] : [uuid, limit, offset]),
        pool.query(`SELECT s.id, s.title, s.status, p.display_name AS ownerName, DATE_FORMAT(s.deleted_at, '%Y-%m-%d %H:%i:%s') AS deletedAtUtc FROM submissions s LEFT JOIN iserv_identities p ON p.user_uuid = s.owner_uuid WHERE ${editor ? '' : 's.owner_uuid = ? AND '}s.status ${editor ? "IN ('submitted', 'taken_over')" : "= 'submitted'"} AND s.deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY ORDER BY s.deleted_at DESC, s.id DESC LIMIT ? OFFSET ?`, editor ? [limit, offset] : [uuid, limit, offset]),
      ]);
      return { updates: updates.slice(0, 50), issues: issues.slice(0, 50), contributions: contributions.slice(0, 50), submissions: submissions.slice(0, 50), page, hasNext: [updates, issues, contributions, submissions].some((rows) => rows.length > 50) };
    },
    async restoreTrash(actor, kind, itemId, editor = false) {
      const uuid = validActor(actor);
      const id = validUpdateId(itemId);
      const sources = { update: 'updates', issue: 'issues', contribution: 'contributions', submission: 'submissions' };
      if (!Object.hasOwn(sources, kind) || typeof editor !== 'boolean' || (['update', 'issue'].includes(kind) && !editor)) throw new Error('Ungültiger Papierkorbeintrag.');
      const table = sources[kind];
      return transact(async (conn) => {
        const privateSubmission = ['contribution', 'submission'].includes(kind);
        const owner = privateSubmission && !editor ? ' AND owner_uuid = ?' : '';
        const status = kind === 'contribution' ? " AND status = 'submitted'" : kind === 'submission' ? editor ? " AND status IN ('submitted', 'taken_over')" : " AND status = 'submitted'" : '';
        const rows = await conn.query(`SELECT title${kind === 'issue' ? ', number, status' : ''} FROM ${table} WHERE id = ?${owner}${status} AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 30 DAY FOR UPDATE`, owner ? [id, uuid] : [id]);
        if (rows.length !== 1) return false;
        await conn.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`, [id]);
        const action = kind === 'issue' && rows[0].status === 'draft' ? 'issue.draft_restore' : `${kind}.restore`;
        await audit(conn, uuid, action, kind, kind === 'issue' ? rows[0].number || id : id, rows[0].title);
        return true;
      });
    },
    async pruneTrash(removeFile) {
      if (typeof removeFile !== 'function') throw new Error('Dateibereinigung fehlt.');
      const sources = [
        { kind: 'issue', table: 'issues' },
        { kind: 'update', table: 'updates' },
        { kind: 'contribution', table: 'contributions' },
        { kind: 'submission', table: 'submissions' },
      ];
      for (const { kind, table } of sources) {
        const expired = await pool.query(`SELECT id, title${kind === 'submission' ? ', stored_name AS storedName' : ''} FROM ${table} WHERE deleted_at <= UTC_TIMESTAMP(6) - INTERVAL 30 DAY ORDER BY deleted_at, id LIMIT 100`);
        for (const item of expired) {
          if (kind === 'submission') await removeFile(item.storedName);
          await transact(async (conn) => {
            if (kind === 'issue') await conn.query('SELECT next_number FROM issue_sequence WHERE id = 1 FOR UPDATE');
            const rows = await conn.query(`SELECT title${kind === 'issue' ? ', number, status' : ''} FROM ${table} WHERE id = ? AND deleted_at <= UTC_TIMESTAMP(6) - INTERVAL 30 DAY FOR UPDATE`, [item.id]);
            if (rows.length !== 1) return;
            if (kind === 'issue') {
              const delivery = await conn.query('SELECT status FROM issue_mail_delivery WHERE issue_id = ?', [item.id]);
              if (delivery.length) throw new Error('Eine angekündigte Ausgabe darf nicht entfernt werden.');
              await conn.query('DELETE FROM issue_submissions WHERE issue_id = ?', [item.id]);
              await conn.query('DELETE FROM issue_updates WHERE issue_id = ?', [item.id]);
              const oldContributions = await conn.query('SELECT contribution_id AS id FROM issue_contributions WHERE issue_id = ? FOR UPDATE', [item.id]);
              await conn.query('DELETE FROM issue_contributions WHERE issue_id = ?', [item.id]);
              await releaseRemovedContributions(conn, oldContributions.map((row) => Number(row.id)).filter(Boolean));
            }
            if (kind === 'update') await conn.query('DELETE FROM update_submissions WHERE update_id = ?', [item.id]);
            await conn.query(`DELETE FROM ${table} WHERE id = ?`, [item.id]);
            if (kind === 'issue' && rows[0].number) await conn.query('UPDATE issue_sequence SET next_number = LEAST(next_number, ?) WHERE id = 1', [rows[0].number]);
            const action = kind === 'issue' && rows[0].status === 'draft' ? 'issue.draft_purge' : `${kind}.purge`;
            await writeAudit(conn, null, action, kind, kind === 'issue' ? rows[0].number || item.id : item.id, rows[0].title);
          }, true);
        }
      }
    },
    async close() { await pool.end(); },
  };
}

export function openCmsStore(config, { auditGapMarker = null } = {}) {
  if (!config || !/^\/[^\0]+$/.test(config.socketPath) || !/^[a-z][a-z0-9_]{0,63}$/.test(config.user) || !/^[a-z][a-z0-9_]{0,63}$/.test(config.database) || (config.password !== undefined && (typeof config.password !== 'string' || !config.password))) throw new Error('Ungültige MariaDB-Konfiguration.');
  const pool = mariadb.createPool({ socketPath: config.socketPath, user: config.user, ...(config.password ? { password: config.password } : {}), database: config.database, connectionLimit: 4, acquireTimeout: 5000, idleTimeout: 30, connectTimeout: 5000, queryTimeout: 3000, socketTimeout: 8000, multipleStatements: false, bigIntAsNumber: true });
  return createCmsStore(pool, { auditGapMarker });
}
