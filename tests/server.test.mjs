import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, currentSchoolYear, readSettings } from '../backend/server.mjs';
import { issueNotice, digestNotice, readMailConfig, sendIssueNotice, sendDigestTest, TEST_RECIPIENT } from '../backend/mail.mjs';
import { renderIssuePdf } from '../backend/issue-pdf.mjs';
import { defaultAppSettings } from '../backend/app-settings.mjs';
import { auditPage, home, issuesPage, statsPage } from '../backend/web-pages.mjs';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const settings = { clientId: 'test', clientSecret: 'test', auditOwnerUuid: uuid, readerGroupName: 'Kollegium' };
const validInfo = { 'iserv:uuid': uuid, 'iserv:groups': [{ name: 'Kollegium' }], name: '<Marc>' };

test('Fehler beim Schließen der Datenbank bleibt behandelt', () => {
  const moduleUrl = new URL('../backend/server.mjs', import.meta.url).href;
  const script = `const { createApp } = await import(${JSON.stringify(moduleUrl)});
const app = createApp({ settings: ${JSON.stringify(settings)}, getProvider: async () => ({}), cmsStore: { close: async () => { throw new Error('simulierter Fehler'); } } });
app.emit('close');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
});

test('Startseite kennzeichnet gekürzte Updates und führt zum vollständigen Beitrag', () => {
  const html = home({ name: 'Leserin', editor: false, auditOwner: false }, 'csrf', false, true, false, {
    updates: [
      { id: 7, title: 'Reisekosten', excerpt: 'Das Formular ist neu.\nBitte in IServ öffnen.\nListenpunkt eins\nListenpunkt zwei', publishedAtUtc: '2026-10-27 07:16:00' },
      { id: 6, title: 'Zweite Meldung', excerpt: 'Dieser Text gehört nicht auf die Startseite.', publishedAtUtc: '2026-10-27 07:15:00' },
    ],
    issues: [],
  });
  assert.match(html, /Das Formular ist neu\. Bitte in IServ öffnen\.\u2026/);
  assert.doesNotMatch(html, /Listenpunkt eins/);
  assert.match(html, /href="\/bbsinfo\/updates\/7">Weiterlesen/);
  assert.match(html, /href="\/bbsinfo\/updates\/6">Zweite Meldung/);
  assert.doesNotMatch(html, /Dieser Text gehört nicht auf die Startseite/);
  assert.equal([...html.matchAll(/Weiterlesen →/g)].length, 1);
});

test('Lange Seitenlisten zeigen Anfang, aktuelle Umgebung und Ende mit Auslassung', () => {
  const html = auditPage({ events: [], page: 39, pageCount: 78, through: '5000' }, { actor: 'Marc Schulz', action: 'page.view' });
  assert.match(html, /aria-label="Seite 1">1<\/a>/);
  assert.match(html, /aria-label="Seite 2">2<\/a>/);
  assert.match(html, /aria-label="Seite 38">38<\/a>/);
  assert.match(html, /aria-current="page">39<\/span>/);
  assert.match(html, /aria-label="Seite 78">78<\/a>/);
  assert.match(html, /pagination-gap[^>]*>…<\/span>/);
  assert.match(html, /actor=Marc\+Schulz&amp;action=page\.view&amp;page=78&amp;through=5000/);
  const issues = issuesPage([], { page: 1, pageCount: 78 });
  assert.match(issues, /aria-label="Seite 76">76<\/a>/);
  assert.match(issues, /aria-label="Seite 78">78<\/a>/);
});

test('Ausgaben-Testmail-Ereignisse verlinken im Audit auf die konkrete Ausgabe', () => {
  const events = ['issue.mail_test_start', 'issue.mail_test'].map((action, index) => ({
    id: index + 1, occurredAt: '2026-10-28 12:00:00', actorName: 'Marc Schulz', action,
    objectType: 'issue', objectId: '93',
  }));
  const html = auditPage({ events, page: 1, pageCount: 1, through: '2' });
  assert.equal([...html.matchAll(/href="\/bbsinfo\/issues\/93">BBS Info 93 ↗<\/a>/g)].length, 2);
});

test('Suchstatistik nennt Personen ohne UUID und escaped Suchtext', () => {
  const html = statsPage({ days: 90, daily: [], topContent: [], activeUsers: 1, subscriptions: 0, searchTerms: [{ term: '<Personalrat>', eventCount: 3 }], searchPeople: [{ term: '<Personalrat>', person: 'Lea <Test>', eventCount: 2, lastAtUtc: '2026-10-28 08:00:00' }] });
  assert.match(html, /&lt;Personalrat&gt;/);
  assert.match(html, /Lea &lt;Test&gt;/);
  assert.match(html, /90 Tagen gelöscht/);
  assert.doesNotMatch(html, /<Personalrat>|Lea <Test>/);
});

async function setup(archiveStore = null, cmsStore = null, accountInfo = validInfo, submissionRoot = null, mailConfig = null, sendIssue = undefined, refreshOverride = null, editorImageRoot = null, sendDigest = undefined) {
  let authorized = true;
  const calls = { begin: 0, complete: 0, refresh: 0 };
  const auth = {
    async begin() { calls.begin++; return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/oauth/authorize?state=s' }; },
    async complete() { calls.complete++; return { subject: 'subject', info: accountInfo, accessToken: 'token', expires: Date.now() + 300000 }; },
    async refresh() { calls.refresh++; return refreshOverride ? refreshOverride() : authorized ? accountInfo : { ...accountInfo, 'iserv:groups': [] }; },
  };
  const app = createApp({ settings, getProvider: async () => auth, archiveStore, cmsStore, submissionRoot, editorImageRoot, mailConfig, sendIssue, sendDigest });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { app, base, calls, revoke() { authorized = false; } };
}

async function login(fixture) {
  const start = await request(fixture.base, '/bbsinfo/oidc/login');
  const tx = start.headers.getSetCookie()[0].split(';')[0];
  const callback = await request(fixture.base, '/bbsinfo/oidc/callback?code=ok&state=s', { headers: { cookie: tx } });
  return callback.headers.getSetCookie().find((value) => value.startsWith('__Secure-bbsinfo-session=')).split(';')[0];
}

function fakeCmsStore() {
  const events = [];
  const identities = new Map();
  const subscriptions = new Map();
  const drafts = [];
  const published = [];
  const issueDrafts = [];
  const issues = [];
  const submissions = [];
  const templates = [];
  const editorGrants = new Map();
  const contributions = [];
  const trash = { updates: [], issues: [], contributions: [], submissions: [] };
  const issueMail = new Map();
  const editorImages = new Map();
  let appSettings = { ...defaultAppSettings };
  return {
    events,
    async listTrash(actor, editor = false) { return { updates: editor ? trash.updates : [], issues: editor ? trash.issues : [], contributions: trash.contributions.filter((row) => row.ownerUuid === actor), submissions: trash.submissions.filter((row) => row.ownerUuid === actor) }; },
    async restoreTrash(actor, kind, id, editor = false) {
      const mapping = { update: ['updates', published], issue: ['issues', issues], contribution: ['contributions', contributions], submission: ['submissions', submissions] }[kind];
      if (!mapping || (['update', 'issue'].includes(kind) && !editor)) return false;
      const [name, active] = mapping;
      const index = trash[name].findIndex((row) => row.id === Number(id) && (['update', 'issue'].includes(kind) || row.ownerUuid === actor));
      if (index < 0) return false;
      const row = trash[name].splice(index, 1)[0];
      (kind === 'update' && row.status === 'draft' ? drafts : kind === 'issue' && row.status === 'draft' ? issueDrafts : active).push(row);
      events.push({ actor, action: `${kind}.restore` });
      return true;
    },
    async getAppSettings() { return appSettings; },
    async saveAppSettings(actor, input) { appSettings = input; events.push({ actor, action: 'settings.edit' }); },
    async rememberIdentity(identity) { identities.set(identity.uuid, identity.name); },
    async listEditorGrants() { return [...editorGrants].map(([email, userUuid]) => ({ email, userUuid, name: userUuid ? identities.get(userUuid) : null })); },
    async addEditorGrant(actor, email) { editorGrants.set(String(email).toLowerCase(), null); events.push({ actor, action: 'editor.grant' }); },
    async removeEditorGrant(actor, email) { const deleted = editorGrants.delete(email); if (deleted) events.push({ actor, action: 'editor.revoke' }); return deleted; },
    async hasEditorGrant(identity) { const email = identity.email?.toLowerCase(); if (!email || !editorGrants.has(email)) return false; editorGrants.set(email, identity.uuid); return true; },
    async recordAudit(actor, action, type, id) { events.push({ actor, action, type, id }); },
    async listContentPage(kind, page, size = 15) {
      const rows = { updates: published, updateDrafts: drafts, issues, issueDrafts }[kind];
      if (!rows) throw new Error('Ungültige Inhaltsliste');
      const ordered = [...rows].reverse();
      return { items: ordered.slice((page - 1) * size, page * size), page, pageCount: Math.max(1, Math.ceil(ordered.length / size)), hasNext: ordered.length > page * size };
    },
    async listPublishedUpdates() { return published; },
    async listIssueUpdates() { return published.map((item) => ({ ...item, usedInIssues: issues.filter((issue) => issue.updates.some((update) => Number(update.updateId) === Number(item.id))).map((issue) => issue.number).join(',') || null })); },
    async listDigestTestUpdates() { return [...published].reverse().slice(0, 50); },
    async getPublishedUpdate(id) { return published.find((item) => item.id === Number(id)) || null; },
    async homeHighlights() { return { updates: published.slice(-5).reverse().map((row) => ({ id: row.id, title: row.title, excerpt: row.body, publishedAt: row.publishedAt })), issues: issues.slice(-3).reverse() }; },
    async listDrafts() { return drafts; },
    async hasUpdateDrafts() { return drafts.length > 0; },
    async listTemplates(activeOnly = false) { return activeOnly ? templates.filter((row) => row.enabled) : templates; },
    async saveTemplate(actor, id, name, bodyHtml, enabled) { const row = id === null ? { id: templates.length + 1 } : templates.find((item) => item.id === Number(id)); if (!row) return null; Object.assign(row, { name, bodyHtml, enabled }); if (id === null) templates.push(row); events.push({ actor, action: id === null ? 'template.create' : 'template.edit' }); return row.id; },
    async createDraft(actor, title, body, submissionIds = [], bodyHtml = null) { const id = drafts.length + published.length + 1; drafts.push({ id, title, body, bodyHtml, updatedAt: '26.10.2026 12:00', attachments: submissionIds.map((fileId) => submissions.find((item) => item.id === Number(fileId))) }); events.push({ actor, action: 'update.create', type: 'update', id }); return id; },
    async editUpdate(actor, id, title, body, mode, bodyHtml = null) { const row = (mode === 'draft_edit' ? drafts : published).find((item) => item.id === Number(id)); if (!row) return false; Object.assign(row, { title, body, bodyHtml }); events.push({ actor, action: mode === 'draft_edit' ? 'update.edit' : 'update.published_edit', type: 'update', id: Number(id) }); return true; },
    async publishUpdate(actor, id) { const index = drafts.findIndex((row) => row.id === Number(id)); if (index < 0) return false; published.push({ ...drafts.splice(index, 1)[0], publishedAt: '26.10.2026 12:00' }); events.push({ actor, action: 'update.publish' }); return true; },
    async subscriptionMode(actor) { return subscriptions.get(actor) || 'off'; },
    async setSubscription(actor, mode) { subscriptions.set(actor, mode); events.push({ actor, action: mode !== 'off' ? 'subscription.enable' : 'subscription.disable' }); },
    async recordSearch(actor, term, source) { events.push({ actor, action: 'search.term', term, source }); },
    async listOwnContributions(actor) { return contributions.filter((item) => item.ownerUuid === actor); },
    async listSubmittedContributions() { return contributions.filter((item) => item.status === 'submitted').map((item) => ({ ...item, author: identities.get(item.ownerUuid) })); },
    async listIssueContributions() { return contributions.filter((item) => item.status === 'submitted' || issues.some((issue) => issue.contributions?.some((entry) => Number(entry.contributionId) === Number(item.id)))).map((item) => ({ ...item, author: identities.get(item.ownerUuid), usedInIssues: issues.filter((issue) => issue.contributions?.some((entry) => Number(entry.contributionId) === Number(item.id))).map((issue) => issue.number).join(',') || null })); },
    async saveContribution(actor, id, title, body, bodyHtml) { const row = id === null ? { id: contributions.length + 1, ownerUuid: actor, status: 'submitted' } : contributions.find((item) => item.id === Number(id) && item.ownerUuid === actor && item.status === 'submitted'); if (!row) return null; Object.assign(row, { title, body, bodyHtml }); if (id === null) contributions.push(row); return row.id; },
    async deleteContribution(actor, id) { const index = contributions.findIndex((item) => item.id === Number(id) && item.ownerUuid === actor && item.status === 'submitted'); if (index < 0) return false; trash.contributions.push({ ...contributions.splice(index, 1)[0], deletedAtUtc: '2026-10-29 10:00:00' }); return true; },
    async listAudit(before, limit, filters = {}) { return events.map((event, id) => ({ id, occurredAt: '2026-10-26 12:00:00', actorUuid: event.actor, actorName: identities.get(event.actor), action: event.action, objectType: event.type, objectId: event.id, objectTitle: event.title || (event.type === 'update' ? [...drafts, ...published].find((row) => row.id === event.id)?.title : null) })).filter((event) => (!filters.actor || event.actorUuid === filters.actor || event.actorName?.toLowerCase().includes(filters.actor.toLowerCase())) && (!filters.action || event.action === filters.action)); },
    async listAuditPage(page = 1, filters = {}, through = null) { const rows = (await this.listAudit(null, 1000, filters)).filter((row) => through === null || row.id <= Number(through)).reverse(); return { events: rows.slice((page - 1) * 50, page * 50), hasMore: rows.length > page * 50, page, pageCount: Math.max(1, Math.ceil(rows.length / 50)), through: through || String(rows[0]?.id || '') }; },
    async listUsageStats(days = 30) { return { days, daily: [{ day: '26.10.2026', action: 'session.login', eventCount: events.filter((event) => event.action === 'session.login').length }], topContent: [], searchTerms: [], searchPeople: [], activeUsers: 1, subscriptions: [...subscriptions.values()].filter((mode) => mode !== 'off').length }; },
    async listPublishedIssues() { return issues; },
    async searchPublished(query) { const term = query.toLocaleLowerCase('de'); return { updates: published.filter((row) => `${row.title} ${row.body}`.toLocaleLowerCase('de').includes(term)).map((row) => ({ id: row.id, title: row.title, excerpt: row.body })), issues: issues.filter((row) => `${row.title} ${row.body} ${row.updates.map((item) => item.body).join(' ')}`.toLocaleLowerCase('de').includes(term)).map((row) => ({ number: row.number, title: row.title, excerpt: row.body })) }; },
    async listIssueDrafts() { return issueDrafts; },
    async hasIssueDrafts() { return issueDrafts.length > 0; },
    async getPublishedIssue(number) { return issues.find((issue) => issue.number === Number(number)) || null; },
    async issueMailStatus(number) { return issueMail.get(Number(number)) || null; },
    async startIssueMail(actor, number) { const n = Number(number); if (!issues.some((issue) => issue.number === n) || issueMail.has(n)) return false; issueMail.set(n, 'sending'); events.push({ actor, action: 'issue.mail_start' }); return true; },
    async finishIssueMail(actor, number, sent) { issueMail.set(Number(number), sent ? 'sent' : 'uncertain'); events.push({ actor, action: sent ? 'issue.mail_sent' : 'issue.mail_uncertain' }); },
    async createIssueDraft(actor, title, body, schoolYear, period, updateIds, bodyHtml = null) { const id = issueDrafts.length + issues.length + 1; issueDrafts.push({ id, title, body, bodyHtml, schoolYear, period, updateIds }); events.push({ actor, action: 'issue.create' }); return id; },
    async publishIssue(actor, id) { const index = issueDrafts.findIndex((issue) => issue.id === Number(id)); if (index < 0) return null; const draft = issueDrafts.splice(index, 1)[0]; const updates = draft.updateIds.map((updateId, position) => { const row = published.find((item) => item.id === Number(updateId)); return { snapshotId: position + 1, updateId: row.id, title: row.title, body: row.body, bodyHtml: row.bodyHtml, attachments: [...(row.attachments || [])] }; }); const number = 93 + issues.length; issues.push({ ...draft, number, publishedAt: '26.10.2026', updates, attachments: updates.flatMap((item) => item.attachments || []) }); events.push({ actor, action: 'issue.publish' }); return number; },
    async createAndPublishIssue(actor, title, body, schoolYear, period, updateIds, bodyHtml = null, submissionIds = [], contributionIds = []) { const id = await this.createIssueDraft(actor, title, body, schoolYear, period, updateIds, bodyHtml); const number = await this.publishIssue(actor, id); const issue = issues.find((item) => item.number === number); issue.attachments.push(...submissionIds.map((fileId) => submissions.find((item) => item.id === Number(fileId)))); issue.contributions = contributionIds.map((key) => { const row = contributions.find((item) => item.id === Number(key)); row.status = 'taken_over'; return { contributionId: row.id, title: row.title, body: row.body, bodyHtml: row.bodyHtml, author: identities.get(row.ownerUuid) }; }); return number; },
    async editPublishedIssue(actor, number, title, body, period, updateIds, submissionIds, keepSnapshotIds = [], bodyHtml = null, contributionIds = []) { const issue = issues.find((item) => item.number === Number(number)); if (!issue) return false; Object.assign(issue, { title, body, period, bodyHtml }); const orphans = issue.updates.filter((item) => !item.updateId && keepSnapshotIds.includes(String(item.snapshotId))); issue.updates = [...updateIds.map((id, position) => { const row = published.find((item) => item.id === Number(id)); return { snapshotId: position + 1, updateId: row.id, title: row.title, body: row.body, bodyHtml: row.bodyHtml }; }), ...orphans]; issue.attachments = submissionIds.map((id) => submissions.find((item) => item.id === Number(id))); issue.contributions = contributionIds.map((key) => { const row = contributions.find((item) => item.id === Number(key)); row.status = 'taken_over'; return { contributionId: row.id, title: row.title, body: row.body, bodyHtml: row.bodyHtml, author: identities.get(row.ownerUuid) }; }); events.push({ actor, action: 'issue.edit', type: 'issue', id: Number(number) }); return true; },
    async deleteUpdate(actor, id) { const rows = [...drafts, ...published]; if (!rows.some((row) => row.id === Number(id))) return false; for (const list of [drafts, published]) { const index = list.findIndex((row) => row.id === Number(id)); if (index >= 0) trash.updates.push({ ...list.splice(index, 1)[0], deletedAtUtc: '2026-10-29 10:00:00', status: list === published ? 'published' : 'draft' }); } events.push({ actor, action: 'update.delete', type: 'update', id: Number(id), title: rows.find((row) => row.id === Number(id)).title }); return true; },
    async deleteIssue(actor, number) { const index = issues.findIndex((row) => row.number === Number(number)); if (index < 0) return false; const [deleted] = issues.splice(index, 1); trash.issues.push({ ...deleted, status: 'published', deletedAtUtc: '2026-10-29 10:00:00' }); events.push({ actor, action: 'issue.delete', type: 'issue', id: Number(number), title: deleted.title }); return true; },
    async deleteIssueDraft(actor, id) { const index = issueDrafts.findIndex((row) => row.id === Number(id)); if (index < 0) return false; trash.issues.push({ ...issueDrafts.splice(index, 1)[0], status: 'draft', deletedAtUtc: '2026-10-29 10:00:00' }); events.push({ actor, action: 'issue.delete', type: 'issue', id: Number(id) }); return true; },
    async createEditorImage(actor, storedName, mediaType) { editorImages.set(storedName, { id: editorImages.size + 1, storedName, mediaType, uploadedBy: actor }); events.push({ actor, action: 'image.upload', type: 'image', id: editorImages.size }); },
    async getEditorImage(storedName) { return editorImages.get(storedName) || null; },
    async isEditorImagePublished(storedName) { return published.some((item) => item.bodyHtml?.includes(storedName)) || issues.some((item) => item.bodyHtml?.includes(storedName) || item.updates.some((update) => update.bodyHtml?.includes(storedName))); },
    async createSubmission(actor, title, note, storedName, mediaType, byteSize) { const id = submissions.length + 1; submissions.push({ id, ownerUuid: actor, title, note, storedName, mediaType, byteSize, status: 'submitted', createdAt: '26.10.2026 12:00' }); events.push({ actor, action: 'submission.create' }); return id; },
    async listOwnSubmissions(actor) { return submissions.filter((item) => item.ownerUuid === actor); },
    async listAllSubmissions() { return submissions.map((item) => ({ ...item, ownerName: identities.get(item.ownerUuid) })); },
    async listTakenOverSubmissions() { return submissions.filter((item) => item.status === 'taken_over').map((item) => ({ ...item, ownerName: identities.get(item.ownerUuid) })); },
    async listIssueSubmissions() { return submissions.filter((item) => item.status === 'taken_over').map((item) => ({ ...item, ownerName: identities.get(item.ownerUuid), usedInIssues: issues.filter((issue) => issue.attachments?.some((file) => Number(file.id) === Number(item.id))).map((issue) => issue.number).join(',') || null })); },
    async getSubmission(id) { return submissions.find((item) => item.id === Number(id)) || null; },
    async isPublishedSubmission(id) { return published.some((item) => item.attachments?.some((file) => file?.id === Number(id))) || issues.some((issue) => issue.attachments?.some((file) => file?.id === Number(id))); },
    async takeOverSubmission(actor, id) { const item = submissions.find((row) => row.id === Number(id) && row.status === 'submitted'); if (!item) return false; item.status = 'taken_over'; events.push({ actor, action: 'submission.take_over' }); return true; },
    async replaceSubmission(actor, id, title, note, storedName, mediaType, byteSize) { const item = submissions.find((row) => row.id === Number(id) && row.ownerUuid === actor && row.status === 'submitted'); if (!item) return null; const oldName = item.storedName; Object.assign(item, { title, note, storedName, mediaType, byteSize }); events.push({ actor, action: 'submission.replace' }); return oldName; },
    async deleteSubmission(actor, id) { const index = submissions.findIndex((row) => row.id === Number(id) && row.ownerUuid === actor && row.status === 'submitted'); if (index < 0) return null; const [item] = submissions.splice(index, 1); trash.submissions.push({ ...item, deletedAtUtc: '2026-10-29 10:00:00' }); events.push({ actor, action: 'submission.delete', type: 'submission', id: item.id, title: item.title }); return item.storedName; },
  };
}

test('Direkte Laufzeitkonfiguration erfordert private Dateirechte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbsinfo-config-'));
  const path = join(dir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify(settings), { mode: 0o640 });
    assert.throws(() => readSettings(path), /privat/);
    chmodSync(path, 0o600);
    assert.equal(readSettings(path).auditOwnerUuid, uuid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Private Steckbriefe: eigene Datei, Redaktionszugriff und fremder Zugriff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-submission-'));
  const cms = fakeCmsStore();
  const authorUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const authorInfo = { ...validInfo, 'iserv:uuid': authorUuid, name: 'Autorin' };
  const author = await setup(null, cms, authorInfo, root);
  try {
    const sid = await login(author);
    const page = await request(author.base, '/bbsinfo/submissions/', { headers: { cookie: sid } });
    const submissionHtml = await page.text();
    assert.match(submissionHtml, /href="\/bbsinfo\/submissions\/" aria-current="page">Meine Steckbriefe<\/a>/);
    assert.match(submissionHtml, /href="\/bbsinfo\/contributions\/">Meine Beiträge<\/a>/);
    const contributionHtml = await (await request(author.base, '/bbsinfo/contributions/', { headers: { cookie: sid } })).text();
    assert.match(contributionHtml, /href="\/bbsinfo\/contributions\/" aria-current="page">Meine Beiträge<\/a>/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(submissionHtml)[1];
    const form = new FormData();
    form.append('csrf', csrf);
    form.append('title', 'Mein Steckbrief');
    form.append('note', 'Entwurf');
    form.append('file', new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'profil.png');
    const uploaded = await request(author.base, '/bbsinfo/submissions/upload', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example' }, body: form });
    assert.equal(uploaded.status, 303);
    const ownFile = await request(author.base, '/bbsinfo/submissions/1/file', { headers: { cookie: sid } });
    assert.equal(ownFile.status, 200);
    assert.equal(ownFile.headers.get('content-disposition'), 'attachment; filename="Steckbrief-1.png"');
    assert.equal((await ownFile.arrayBuffer()).byteLength, 8);
    const replacement = new FormData();
    replacement.append('csrf', csrf);
    replacement.append('id', '1');
    replacement.append('title', 'Mein neuer Steckbrief');
    replacement.append('note', 'Überarbeitet');
    replacement.append('file', new Blob([Buffer.from([255, 216, 255])], { type: 'image/jpeg' }), 'profil.jpg');
    assert.equal((await request(author.base, '/bbsinfo/submissions/replace', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example' }, body: replacement })).status, 303);
    const newFile = await request(author.base, '/bbsinfo/submissions/1/file', { headers: { cookie: sid } });
    assert.equal(newFile.headers.get('content-disposition'), 'attachment; filename="Steckbrief-1.jpg"');
    assert.equal((await newFile.arrayBuffer()).byteLength, 3);
  } finally { await new Promise((resolve) => author.app.close(resolve)); }

  const stranger = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Fremd' }, root);
  try {
    const sid = await login(stranger);
    assert.equal((await request(stranger.base, '/bbsinfo/submissions/1/file', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(stranger.base, '/bbsinfo/media/1', { headers: { cookie: sid } })).status, 404);
    const listing = await request(stranger.base, '/bbsinfo/submissions/', { headers: { cookie: sid } });
    assert.doesNotMatch(await listing.text(), /Mein neuer Steckbrief/);
  } finally { await new Promise((resolve) => stranger.app.close(resolve)); }

  const editor = await setup(null, cms, validInfo, root);
  try {
    const sid = await login(editor);
    const listing = await request(editor.base, '/bbsinfo/submissions/', { headers: { cookie: sid } });
    const html = await listing.text();
    assert.match(html, /Mein neuer Steckbrief/);
    assert.equal((await request(editor.base, '/bbsinfo/submissions/1/file', { headers: { cookie: sid } })).status, 200);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const taken = await request(editor.base, '/bbsinfo/submissions/take-over', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, id: '1' }) });
    assert.equal(taken.status, 303);
    assert.equal((await cms.getSubmission(1)).status, 'taken_over');
    const draft = await request(editor.base, '/bbsinfo/editor/drafts', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, title: 'Neue Kollegin', body: 'Vorstellung', submissionId: '1' }) });
    assert.equal(draft.status, 303);
    const publish = await request(editor.base, '/bbsinfo/editor/publish', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, id: '1' }) });
    assert.equal(publish.status, 303);
    assert.equal((await request(editor.base, '/bbsinfo/media/1', { headers: { cookie: sid } })).status, 200);
  } finally {
    await new Promise((resolve) => editor.app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Eigene Steckbriefe wandern nur vor redaktioneller Übernahme mit Datei in den Papierkorb', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-delete-submission-'));
  const cms = fakeCmsStore();
  const ownerUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ownerInfo = { ...validInfo, 'iserv:uuid': ownerUuid, name: 'Autorin' };
  const post = (baseUrl, cookie, csrf, id, confirm = id) => request(baseUrl, '/bbsinfo/submissions/delete', {
    method: 'POST', headers: { cookie, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, id, confirm }),
  });
  const owner = await setup(null, cms, ownerInfo, root);
  try {
    const cookie = await login(owner);
    const initial = await (await request(owner.base, '/bbsinfo/submissions/', { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(initial)[1];
    for (const title of ['Löschbarer Steckbrief', 'Später übernommen']) {
      const upload = new FormData();
      upload.append('csrf', csrf);
      upload.append('title', title);
      upload.append('note', 'Test');
      upload.append('file', new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'profil.png');
      assert.equal((await request(owner.base, '/bbsinfo/submissions/upload', { method: 'POST', headers: { cookie, origin: 'https://apps.school.example' }, body: upload })).status, 303);
    }
    const ownPage = await (await request(owner.base, '/bbsinfo/submissions/', { headers: { cookie } })).text();
    assert.match(ownPage, /action="\/bbsinfo\/submissions\/delete"/);
    assert.match(ownPage, /Steckbrief Löschbarer Steckbrief in den Papierkorb verschieben/);
    assert.match(ownPage, /assets\/feedback\.js/);
    assert.match(ownPage, /data-confirm-delete="Löschbarer Steckbrief"/);
    assert.match(ownPage, /name="confirm" value=""/);
    const storedName = (await cms.getSubmission(1)).storedName;
    assert.equal(existsSync(join(root, storedName)), true);
    assert.equal((await post(owner.base, cookie, csrf, '1', '2')).status, 400);
    assert.equal(existsSync(join(root, storedName)), true);
    assert.equal((await post(owner.base, cookie, csrf, '1')).status, 303);
    assert.equal(await cms.getSubmission(1), null);
    assert.equal(existsSync(join(root, storedName)), true);
    assert.equal(cms.events.some((event) => event.action === 'submission.delete' && event.title === 'Löschbarer Steckbrief'), true);
  } finally { await new Promise((resolve) => owner.app.close(resolve)); }

  const stranger = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Fremd' }, root);
  try {
    const cookie = await login(stranger);
    const html = await (await request(stranger.base, '/bbsinfo/submissions/', { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    assert.equal((await post(stranger.base, cookie, csrf, '2')).status, 409);
    assert.ok(await cms.getSubmission(2));
  } finally { await new Promise((resolve) => stranger.app.close(resolve)); }

  const editor = await setup(null, cms, validInfo, root);
  try {
    const cookie = await login(editor);
    const html = await (await request(editor.base, '/bbsinfo/submissions/', { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const taken = await request(editor.base, '/bbsinfo/submissions/take-over', { method: 'POST', headers: { cookie, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, id: '2' }) });
    assert.equal(taken.status, 303);
  } finally { await new Promise((resolve) => editor.app.close(resolve)); }

  const afterTakeover = await setup(null, cms, ownerInfo, root);
  try {
    const cookie = await login(afterTakeover);
    const html = await (await request(afterTakeover.base, '/bbsinfo/submissions/', { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    assert.doesNotMatch(html, /action="\/bbsinfo\/submissions\/delete"/);
    const storedName = (await cms.getSubmission(2)).storedName;
    assert.equal((await post(afterTakeover.base, cookie, csrf, '2')).status, 409);
    assert.equal(existsSync(join(root, storedName)), true);
  } finally {
    await new Promise((resolve) => afterTakeover.app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Papierkorb schützt fremde Einreichungen und stellt Ausgaben mit derselben Nummer wieder her', async () => {
  const cms = fakeCmsStore();
  const ownerUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const owner = await setup(null, cms, { ...validInfo, 'iserv:uuid': ownerUuid, name: 'Autorin' });
  let csrf;
  try {
    const cookie = await login(owner);
    const html = await (await request(owner.base, '/bbsinfo/contributions/', { headers: { cookie } })).text();
    csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(owner.base, '/bbsinfo/contributions/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Privater Bericht', bodyHtml: '<p>Text.</p>' }) })).status, 303);
    assert.equal((await request(owner.base, '/bbsinfo/contributions/delete', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1', confirm: '1' }) })).status, 303);
    const trash = await (await request(owner.base, '/bbsinfo/trash/', { headers: { cookie } })).text();
    assert.match(trash, /Privater Bericht/);
    assert.doesNotMatch(trash, /name="kind" value="issue"/);
    assert.equal((await request(owner.base, '/bbsinfo/editor/settings/?tab=trash', { headers: { cookie } })).status, 403);
    assert.equal((await request(owner.base, '/bbsinfo/trash/restore', { method: 'POST', headers, body: new URLSearchParams({ csrf, kind: 'issue', id: '1' }) })).status, 403);
  } finally { await new Promise((resolve) => owner.app.close(resolve)); }

  const stranger = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Fremd' });
  try {
    const cookie = await login(stranger);
    const html = await (await request(stranger.base, '/bbsinfo/trash/', { headers: { cookie } })).text();
    const otherCsrf = /name="csrf" value="([a-f0-9]{64})"/.exec(await (await request(stranger.base, '/bbsinfo/contributions/', { headers: { cookie } })).text())[1];
    assert.doesNotMatch(html, /Privater Bericht/);
    const attempt = await request(stranger.base, '/bbsinfo/trash/restore', { method: 'POST', headers: { cookie, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: otherCsrf, kind: 'contribution', id: '1' }) });
    assert.equal(attempt.status, 404);
  } finally { await new Promise((resolve) => stranger.app.close(resolve)); }

  const editor = await setup(null, cms);
  try {
    const cookie = await login(editor);
    const html = await (await request(editor.base, '/bbsinfo/editor/issues/', { headers: { cookie } })).text();
    const editorCsrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    await cms.createAndPublishIssue(uuid, 'Testausgabe', 'Text', '2026/27', '', []);
    assert.equal((await request(editor.base, '/bbsinfo/editor/issues/delete', { method: 'POST', headers, body: new URLSearchParams({ csrf: editorCsrf, number: '93', confirm: '93' }) })).status, 303);
    assert.equal((await request(editor.base, '/bbsinfo/issues/93', { headers: { cookie } })).status, 404);
    const trash = await (await request(editor.base, '/bbsinfo/editor/settings/?tab=trash', { headers: { cookie } })).text();
    assert.match(trash, /BBS Info 93/);
    assert.equal((await request(editor.base, '/bbsinfo/trash/restore', { method: 'POST', headers, body: new URLSearchParams({ csrf: editorCsrf, kind: 'issue', id: '1' }) })).status, 303);
    assert.equal((await request(editor.base, '/bbsinfo/issues/93', { headers: { cookie } })).status, 200);
  } finally { await new Promise((resolve) => editor.app.close(resolve)); }
});

test('Updates: Redaktion veröffentlicht, Kollegium liest und verwaltet eigenes Abo', async () => {
  const cms = fakeCmsStore();
  const editor = await setup(null, cms);
  try {
    const sid = await login(editor);
    const editorPage = await request(editor.base, '/bbsinfo/editor/', { headers: { cookie: sid } });
    assert.equal(editorPage.status, 200);
    const editorHtml = await editorPage.text();
    assert.doesNotMatch(editorHtml, /Versionshistorie|Versionen ansehen/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(editorHtml)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(editor.base, '/bbsinfo/editor/drafts', { method: 'POST', headers, body: 'csrf=wrong&title=Titel&body=Text' })).status, 403);
    const draft = await request(editor.base, '/bbsinfo/editor/drafts', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: '<Wichtig>', body: 'Neuer Text' }) });
    assert.equal(draft.status, 303);
    const publish = await request(editor.base, '/bbsinfo/editor/publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1' }) });
    assert.equal(publish.status, 303);
    const issuePublish = await request(editor.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Herbst', body: 'Vorwort', period: 'Oktober', updateId: '1' }) });
    assert.equal(issuePublish.status, 303);
    assert.equal(issuePublish.headers.get('location'), '/bbsinfo/?mailTest=unavailable');
    const publishedEditor = await request(editor.base, '/bbsinfo/editor/', { headers: { cookie: sid } });
    const publishedEditorHtml = await publishedEditor.text();
    assert.match(publishedEditorHtml, /Veröffentlichte Updates bearbeiten/);
    assert.match(publishedEditorHtml, /name="mode" value="published_edit"/);
    assert.doesNotMatch(publishedEditorHtml, /Tippfehler korrigieren|Versionen ansehen/);
    const edit = await request(editor.base, '/bbsinfo/editor/update', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1', mode: 'published_edit', title: '<Wichtig>', body: 'Bearbeiteter Text' }) });
    assert.equal(edit.status, 303);
    assert.equal((await request(editor.base, '/bbsinfo/editor/updates/1/history', { headers: { cookie: sid } })).status, 404);
    const audit = await request(editor.base, '/bbsinfo/audit/?action=update.published_edit', { headers: { cookie: sid } });
    assert.equal(audit.status, 200);
    const auditHtml = await audit.text();
    assert.match(auditHtml, /Update bearbeitet/);
    assert.match(auditHtml, /href="\/bbsinfo\/updates\/1">Update: &lt;Wichtig&gt;/);
    assert.match(auditHtml, /&lt;Marc&gt;/);
    assert.match(auditHtml, /Person/);
    assert.equal((await request(editor.base, '/bbsinfo/audit/?actor=Marc', { headers: { cookie: sid } })).status, 200);
    assert.equal((await request(editor.base, '/bbsinfo/audit/?actor=' + 'x'.repeat(101), { headers: { cookie: sid } })).status, 400);
    const csv = await request(editor.base, '/bbsinfo/audit/export.csv', { headers: { cookie: sid } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    const csvText = await csv.text();
    assert.match(csvText, /update\.published_edit/);
    assert.match(csvText, /iserv_name/);
    assert.match(csvText, /object_title/);
    const stats = await request(editor.base, '/bbsinfo/stats/?days=7', { headers: { cookie: sid } });
    assert.equal(stats.status, 200);
    assert.match(await stats.text(), /aktive IServ-Konten/);
  } finally { await new Promise((resolve) => editor.app.close(resolve)); }

  const readerUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const reader = await setup(null, cms, { ...validInfo, 'iserv:uuid': readerUuid, name: 'Leserin', email: 'leserin@school.example', email_verified: true });
  try {
    const sid = await login(reader);
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    const start = await request(reader.base, '/bbsinfo/', { headers: { cookie: sid } });
    const startHtml = await start.text();
    assert.equal(start.status, 200);
    assert.match(startHtml, /Gut informiert\.<br>Gemeinsam <span>im Blick\.<\/span>/);
    assert.match(startHtml, /<div class="hero-account">[\s\S]*?<form method="post" action="\/bbsinfo\/logout">/);
    assert.match(startHtml, /href="\/bbsinfo\/updates\/1"/);
    assert.match(startHtml, /href="\/bbsinfo\/issues\/93"/);
    const searchResult = await request(reader.base, '/bbsinfo/search/?q=Wichtig', { headers: { cookie: sid } });
    assert.match(await searchResult.text(), /href="\/bbsinfo\/updates\/1"/);
    assert.doesNotMatch(startHtml, /Nutzungsstatistik/);
    assert.equal((await request(reader.base, '/bbsinfo/editor/', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(reader.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(reader.base, '/bbsinfo/editor/updates/1/history', { headers: { cookie: sid } })).status, 404);
    assert.equal((await request(reader.base, '/bbsinfo/audit/', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(reader.base, '/bbsinfo/audit/export.csv', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(reader.base, '/bbsinfo/stats/', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(reader.base, '/bbsinfo/editor/drafts', { method: 'POST', headers, body: 'title=Fremd&body=Text' })).status, 403);
    const updates = await request(reader.base, '/bbsinfo/updates/', { headers: { cookie: sid } });
    const html = await updates.text();
    assert.equal(updates.status, 200);
    assert.match(html, /&lt;Wichtig&gt;/);
    assert.match(html, /Bearbeiteter Text/);
    assert.match(html, /id="update-1"/);
    assert.doesNotMatch(html, /<Wichtig>/);
    const issue = await request(reader.base, '/bbsinfo/issues/93', { headers: { cookie: sid } });
    assert.equal(issue.status, 200);
    const issueHtml = await issue.text();
    assert.match(issueHtml, /BBS Info 93/);
    assert.match(issueHtml, /&lt;Wichtig&gt;/);
    assert.match(issueHtml, /Neuer Text/);
    assert.doesNotMatch(issueHtml, /Bearbeiteter Text/);
    const search = await request(reader.base, '/bbsinfo/search/?q=Bearbeiteter', { headers: { cookie: sid } });
    assert.equal(search.status, 200);
    assert.match(await search.text(), /Bearbeiteter Text/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    assert.equal((await request(reader.base, '/bbsinfo/subscribe', { method: 'POST', headers, body: new URLSearchParams({ csrf, mode: 'weekly' }) })).status, 303);
    assert.equal(await cms.subscriptionMode(readerUuid), 'weekly');
    assert.equal(cms.events.some((event) => event.actor === readerUuid && event.action === 'page.view'), true);
  } finally { await new Promise((resolve) => reader.app.close(resolve)); }
});

async function request(base, path, options = {}) {
  return fetch(base + path, { redirect: 'manual', ...options });
}

test('Gespeicherte Aboauswahl zeigt einmalige Bestätigung und persönlichen Versandstatus', async () => {
  const cms = fakeCmsStore();
  const mail = { password: 'test', testRecipient: TEST_RECIPIENT, issueRecipient: 'staff@school.example' };
  const account = { 'iserv:uuid': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'iserv:groups': [{ name: 'Kollegium' }], name: 'Testlehrer', email: 'l.test@school.example' };
  const fixture = await setup(null, cms, account, null, mail);
  try {
    const sid = await login(fixture);
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    const initial = await (await request(fixture.base, '/bbsinfo/updates/', { headers: { cookie: sid } })).text();
    assert.doesNotMatch(initial, /noch nicht freigegeben/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(initial)[1];
    const saved = await request(fixture.base, '/bbsinfo/subscribe', { method: 'POST', headers, body: new URLSearchParams({ csrf, mode: 'instant' }) });
    assert.equal(saved.status, 303);
    assert.equal(await cms.subscriptionMode(account['iserv:uuid']), 'instant');
    const first = await (await request(fixture.base, '/bbsinfo/updates/', { headers: { cookie: sid } })).text();
    assert.match(first, /Sofortige Update-Mails eingeschaltet/);
    assert.match(first, /data-feedback/);
    const second = await (await request(fixture.base, '/bbsinfo/updates/', { headers: { cookie: sid } })).text();
    assert.doesNotMatch(second, /Sofortige Update-Mails eingeschaltet/);
    assert.match(second, /Täglich um 18:00 Uhr/);
    assert.equal((await request(fixture.base, '/bbsinfo/subscribe', { method: 'POST', headers, body: new URLSearchParams({ csrf, mode: 'daily' }) })).status, 303);
    const daily = await (await request(fixture.base, '/bbsinfo/updates/', { headers: { cookie: sid } })).text();
    assert.match(daily, /Tägliche Update-Mails eingeschaltet/);
    assert.match(daily, /value="daily" selected/);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Anmeldefluss setzt geschützte Cookies und prüft Gruppe erneut', async () => {
  const fixture = await setup(null, null, { ...validInfo, 'iserv:uuid': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  try {
    const start = await request(fixture.base, '/bbsinfo/');
    assert.equal(start.status, 200);
    const landing = await start.text();
    assert.match(landing, /Mit IServ anmelden/);
    assert.match(landing, /assets\/landing-steckbriefe\.webp/);
    assert.match(landing, /assets\/logo-mappe\.png/);
    assert.match(landing, /assets\/landing-steckbriefe-back\.webp/);
    assert.match(landing, /assets\/app\.css/);
    assert.match(landing, /landing-flip/);
    assert.match(landing, /landing-title/);
    assert.match(landing, /Info Mappe/);
    assert.match(landing, /<footer><span>BBS Einbeck · BBS Info/);
    assert.match(landing, /<nav class="footer-links" aria-label="Projektlinks"><a href="https:\/\/github\.com\/mail896\/bbsinfo" target="_blank" rel="noopener noreferrer"><svg[^>]+>.*?<\/svg><span>GitHub ↗<\/span><\/a><a href="https:\/\/mail896\.github\.io\/bbsinfo\/" target="_blank" rel="noopener noreferrer"><svg[^>]+>.*?<\/svg><span>Pages ↗<\/span><\/a><\/nav>/);
    assert.match(landing, /Animation der Mappe erneut abspielen/);
    assert.doesNotMatch(landing, /landing-replay/);
    assert.match(landing, /assets\/landing\.js/);
    assert.match(start.headers.get('content-security-policy'), /img-src 'self'/);
    assert.match(start.headers.get('content-security-policy'), /style-src 'self'/);
    assert.match(start.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    const stylesheet = await request(fixture.base, '/bbsinfo/assets/app.css');
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
    assert.match(await stylesheet.text(), /prefers-reduced-motion/);
    const animation = await request(fixture.base, '/bbsinfo/assets/landing.js');
    assert.equal(animation.status, 200);
    assert.match(animation.headers.get('content-type'), /^text\/javascript/);
    const picture = await request(fixture.base, '/bbsinfo/assets/landing-steckbriefe.webp');
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get('content-type'), 'image/webp');
    const pictureBytes = Buffer.from(await picture.arrayBuffer());
    assert.equal(pictureBytes.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.ok(pictureBytes.length < 120000);
    const back = await request(fixture.base, '/bbsinfo/assets/landing-steckbriefe-back.webp');
    assert.equal(back.status, 200);
    assert.equal(back.headers.get('content-type'), 'image/webp');
    assert.ok((await back.arrayBuffer()).byteLength < 120000);
    const icon = await request(fixture.base, '/bbsinfo/assets/logo-mappe.png', { method: 'HEAD' });
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.equal(icon.headers.get('cache-control'), 'no-cache');
    assert.ok(Number(icon.headers.get('content-length')) < 50000);
    const login = await request(fixture.base, '/bbsinfo/oidc/login');
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), 'https://school.example/oauth/authorize?state=s');
    const tx = login.headers.getSetCookie()[0];
    assert.match(tx, /Secure; HttpOnly; SameSite=Lax/);
    const callback = await request(fixture.base, '/bbsinfo/oidc/callback?code=ok&state=s', { headers: { cookie: tx.split(';')[0] } });
    assert.equal(callback.status, 303);
    const sid = callback.headers.getSetCookie().find((value) => value.startsWith('__Secure-bbsinfo-session=')).split(';')[0];
    const home = await request(fixture.base, '/bbsinfo/', { headers: { cookie: sid } });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /&lt;Marc&gt;/);
    fixture.revoke();
    const rejected = await request(fixture.base, '/bbsinfo/', { headers: { cookie: sid } });
    assert.equal(rejected.status, 403);
    assert.match(rejected.headers.getSetCookie().join(' '), /Max-Age=0/);
    assert.deepEqual(fixture.calls, { begin: 1, complete: 1, refresh: 2 });
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Gleichzeitige Aufrufe einer Sitzung teilen die IServ-Prüfung; spätere Aufrufe prüfen erneut', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = await setup(null, null, validInfo, null, null, undefined, () => gate);
  try {
    const sid = await login(fixture);
    const requests = Array.from({ length: 16 }, () => request(fixture.base, '/bbsinfo/', { headers: { cookie: sid } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.calls.refresh, 1);
    release(validInfo);
    const responses = await Promise.all(requests);
    assert.ok(responses.every((response) => response.status === 200));
    await Promise.all(responses.map((response) => response.text()));
    assert.equal(fixture.calls.refresh, 1);
    assert.equal((await request(fixture.base, '/bbsinfo/', { headers: { cookie: sid } })).status, 200);
    assert.equal(fixture.calls.refresh, 2);
  } finally {
    release(validInfo);
    await new Promise((resolve) => fixture.app.close(resolve));
  }
});

test('Gleichzeitige IServ-Prüfungen mehrerer Sitzungen werden begrenzt und danach fortgesetzt', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = await setup(null, null, validInfo, null, null, undefined, () => gate);
  try {
    const sessions = [];
    for (let i = 0; i < 12; i++) sessions.push(await login(fixture));
    const requests = sessions.map((sid) => request(fixture.base, '/bbsinfo/', { headers: { cookie: sid } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.calls.refresh, 8);
    release(validInfo);
    const responses = await Promise.all(requests);
    assert.ok(responses.every((response) => response.status === 200));
    await Promise.all(responses.map((response) => response.text()));
    assert.equal(fixture.calls.refresh, 12);
  } finally {
    release(validInfo);
    await new Promise((resolve) => fixture.app.close(resolve));
  }
});

test('Audit und Statistik verlinken Inhalte ohne UUID in der Oberfläche', async () => {
  const cms = fakeCmsStore();
  cms.listUsageStats = async (days) => ({ days, daily: [], topContent: [
    { action: 'archive.pdf', objectType: 'archive', objectId: '92', eventCount: 2 },
    { action: 'issue.view', objectType: 'issue', objectId: '93', eventCount: 1 },
    { action: 'submission.published_file', objectType: 'submission', objectId: '7', eventCount: 1 },
  ], activeUsers: 1, subscriptions: 0 });
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    await cms.recordAudit(uuid, 'archive.pdf', 'archive', '92');
    await cms.recordAudit(uuid, 'issue.view', 'issue', '93');
    await cms.recordAudit(uuid, 'update.publish', 'update', '8');
    await cms.recordAudit(uuid, 'submission.published_file', 'submission', '7');
    const audit = await request(fixture.base, '/bbsinfo/audit/', { headers: { cookie: sid } });
    const auditHtml = await audit.text();
    assert.match(auditHtml, /href="\/bbsinfo\/archive\/92\.pdf"/);
    assert.match(auditHtml, /href="\/bbsinfo\/issues\/93"/);
    assert.match(auditHtml, /href="\/bbsinfo\/updates\/8"/);
    assert.match(auditHtml, /href="\/bbsinfo\/media\/7"/);
    assert.doesNotMatch(auditHtml, /IServ-ID|IServ-UUID|aaaaaaaa-aaaa/);
    const stats = await request(fixture.base, '/bbsinfo/stats/', { headers: { cookie: sid } });
    const statsHtml = await stats.text();
    assert.match(statsHtml, /href="\/bbsinfo\/archive\/92\.pdf"/);
    assert.match(statsHtml, /href="\/bbsinfo\/issues\/93"/);
    assert.match(statsHtml, /href="\/bbsinfo\/media\/7"/);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Callback ohne Transaktion und fremde POST-Anfragen werden abgewiesen', async () => {
  const fixture = await setup();
  try {
    assert.equal((await request(fixture.base, '/bbsinfo/oidc/callback?code=x')).status, 400);
    assert.equal((await request(fixture.base, '/bbsinfo/logout', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=x' })).status, 403);
    assert.equal(fixture.calls.complete, 0);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Ungültiger Anmelde-Callback beendet keine bestehende Sitzung', async () => {
  const fixture = await setup(null, fakeCmsStore());
  try {
    const sid = await login(fixture);
    const callback = await request(fixture.base, '/bbsinfo/oidc/callback?code=x&state=ungueltig', { headers: { cookie: sid } });
    assert.equal(callback.status, 400);
    assert.equal(callback.headers.getSetCookie().some((value) => value.startsWith('__Secure-bbsinfo-session=')), false);
    assert.equal((await request(fixture.base, '/bbsinfo/updates/', { headers: { cookie: sid } })).status, 200);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('IServ-Ablehnung nennt die fehlende Kollegiumsfreigabe statt eines technischen Ausfalls', async () => {
  const denial = new Error('IServ-Anmeldung fehlgeschlagen.', { cause: Object.assign(new Error(), { name: 'AuthorizationResponseError', error: 'access_denied' }) });
  denial.step = 'token';
  const auth = {
    async begin() { return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/oauth/authorize?state=s' }; },
    async complete() { throw denial; },
  };
  const app = createApp({ settings, getProvider: async () => auth });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${app.address().port}`;
  try {
    const start = await request(endpoint, '/bbsinfo/oidc/login');
    const tx = start.headers.getSetCookie()[0].split(';')[0];
    const callback = await request(endpoint, '/bbsinfo/oidc/callback?error=access_denied&state=s', { headers: { cookie: tx } });
    assert.equal(callback.status, 403);
    const body = await callback.text();
    assert.match(body, /Mitgliedschaft in „Kollegium“ prüfen/);
    assert.doesNotMatch(body, /Anmeldung gerade nicht möglich/);
  } finally { await new Promise((resolve) => app.close(resolve)); }
});

test('Archivliste, Suche und Original-PDF sind nur für angemeldetes Kollegium erreichbar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbsinfo-server-archive-'));
  const path = join(dir, 'BBS-Info-01.pdf');
  writeFileSync(path, '%PDF-1.4\n');
  const thumbPath = join(dir, '1.webp');
  writeFileSync(thumbPath, 'RIFFxxxxWEBP');
  const archiveStore = {
    list: () => [{ number: 1, pageCount: 1, schoolYear: '2026/27', period: '', lowTextPages: [1] }],
    search: () => [{ archiveId: 1, number: 1, page: 1, excerpt: '<script>fiktiv</script>' }],
    pdf: () => ({ path, filename: 'BBS-Info-01.pdf', size: 9 }),
    thumbnail: () => ({ path: thumbPath, size: 12 }),
  };
  const fixture = await setup(archiveStore, null, { ...validInfo, 'iserv:uuid': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  try {
    assert.equal((await request(fixture.base, '/bbsinfo/archive/')).status, 401);
    assert.equal((await request(fixture.base, '/bbsinfo/archive/1.pdf')).status, 401);
    assert.equal((await request(fixture.base, '/bbsinfo/archive/1/thumbnail.webp')).status, 401);
    const login = await request(fixture.base, '/bbsinfo/oidc/login');
    const tx = login.headers.getSetCookie()[0].split(';')[0];
    const callback = await request(fixture.base, '/bbsinfo/oidc/callback?code=ok&state=s', { headers: { cookie: tx } });
    const sid = callback.headers.getSetCookie().find((value) => value.startsWith('__Secure-bbsinfo-session=')).split(';')[0];
    const archive = await request(fixture.base, '/bbsinfo/archive/?q=fiktiv', { headers: { cookie: sid } });
    assert.equal(archive.status, 200);
    const html = await archive.text();
    assert.match(html, /BBS Info 1/);
    assert.match(html, /2026\/27/);
    assert.match(html, /archive\/1\/thumbnail.webp/);
    assert.doesNotMatch(html, /eingeschränkt durchsuchbar/);
    assert.match(html, /&lt;script&gt;fiktiv&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>fiktiv<\/script>/);
    const longSearch = '/bbsinfo/archive/?q=eins+zwei+drei+vier+fuenf+sechs+sieben';
    assert.equal((await request(fixture.base, longSearch, { headers: { cookie: sid } })).status, 400);
    const pdf = await request(fixture.base, '/bbsinfo/archive/1.pdf', { headers: { cookie: sid } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(await pdf.text(), '%PDF-1.4\n');
    const thumbnail = await request(fixture.base, '/bbsinfo/archive/1/thumbnail.webp', { headers: { cookie: sid } });
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
    assert.equal(await thumbnail.text(), 'RIFFxxxxWEBP');
    fixture.revoke();
    assert.equal((await request(fixture.base, '/bbsinfo/archive/1.pdf', { headers: { cookie: sid } })).status, 403);
  } finally {
    await new Promise((resolve) => fixture.app.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gemeinsame Suche zeigt Treffer aus dem historischen PDF-Index', async () => {
  const archiveStore = {
    list: () => [],
    search: (query) => query === 'Dietzek' ? [{ archiveId: 92, number: 92, page: 1, excerpt: 'Name im Archiv' }] : [],
    pdf: () => null,
    thumbnail: () => null,
  };
  const fixture = await setup(archiveStore, fakeCmsStore());
  try {
    const sid = await login(fixture);
    const search = await request(fixture.base, '/bbsinfo/search/?q=Dietzek', { headers: { cookie: sid } });
    assert.equal(search.status, 200);
    const body = await search.text();
    assert.match(body, /Historische PDFs/);
    assert.match(body, /archive\/92\.pdf/);
    assert.match(body, /Name im Archiv/);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Ausgaben-Mail zeigt nur den Testempfänger und sperrt den Kollegiumsversand', async () => {
  const cms = fakeCmsStore();
  await cms.createIssueDraft(uuid, '<Titel>\nzweite Zeile', 'Inhalt', '', '', []);
  await cms.publishIssue(uuid, 1);
  let sends = 0;
  const mailConfig = { password: 'nur-im-Test', issueRecipient: 'staff@school.example', testRecipient: TEST_RECIPIENT };
  const fixture = await setup(null, cms, validInfo, null, mailConfig, async () => { sends++; });
  try {
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/93/mail')).status, 401);
    const sid = await login(fixture);
    const preview = await request(fixture.base, '/bbsinfo/editor/issues/93/mail', { headers: { cookie: sid } });
    assert.equal(preview.status, 200);
    const html = await preview.text();
    assert.match(html, /admin@school\.example/);
    assert.doesNotMatch(html, /kollegium@school\.example/);
    assert.match(html, /BBS Info 93: &lt;Titel&gt; zweite Zeile/);
    assert.equal(sends, 0);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/93/mail', { method: 'POST', headers, body: new URLSearchParams({ csrf, confirm: '93' }) })).status, 403);
    assert.equal(sends, 0);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/93/mail-test', { method: 'POST', headers, body: new URLSearchParams({ csrf }) })).status, 400);
    assert.equal(sends, 0);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/93/mail-test', { method: 'POST', headers, body: new URLSearchParams({ csrf, confirm: '93' }) })).status, 303);
    assert.equal(sends, 1);
    assert.equal(await cms.issueMailStatus(93), null);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/93/mail-test', { method: 'POST', headers, body: new URLSearchParams({ csrf, confirm: '93' }) })).status, 303);
    assert.equal(sends, 2);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Ausgaben-Testmail erzwingt Marc als Empfänger', async () => {
  const config = { password: 'nur-im-Test', issueRecipient: 'staff@school.example', testRecipient: TEST_RECIPIENT };
  const recipients = [];
  await sendIssueNotice(config, { number: 93, title: 'Test', publishedAt: '26.10.2026' }, defaultAppSettings, async (_config, recipient) => recipients.push(recipient));
  assert.deepEqual(recipients, [TEST_RECIPIENT]);
  await assert.rejects(sendIssueNotice({ ...config, testRecipient: undefined }, { number: 93, title: 'Test', publishedAt: '26.10.2026' }, defaultAppSettings, async () => {}));
  const dir = mkdtempSync(join(tmpdir(), 'bbsinfo-mail-'));
  try {
    const path = join(dir, 'mail.json');
    writeFileSync(path, JSON.stringify({ host: 'school.example', port: 465, encryption: 'ssl', username: 'mailer', from: 'mailer@school.example', ...config }));
    chmodSync(path, 0o600);
    assert.equal(readMailConfig(path).testRecipient, TEST_RECIPIENT);
    writeFileSync(path, JSON.stringify({ host: 'school.example', port: 465, encryption: 'ssl', username: 'mailer', from: 'mailer@school.example', ...config, testRecipient: 'staff@school.example' }));
    assert.throws(() => readMailConfig(path), /ungültig/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Sammelmailvorschau zeigt veröffentlichte Updates und sendet nur nach Bestätigung an Marc', async () => {
  const cms = fakeCmsStore();
  const config = { password: 'nur-im-Test', issueRecipient: 'staff@school.example', testRecipient: TEST_RECIPIENT };
  const sent = [];
  const fixture = await setup(null, cms, validInfo, null, config, undefined, null, null, async (mail, updates) => {
    await sendDigestTest(mail, updates, async (_config, recipient, notice) => sent.push({ recipient, notice }));
  });
  try {
    assert.equal((await request(fixture.base, '/bbsinfo/editor/digest/')).status, 401);
    const sid = await login(fixture);
    const empty = await request(fixture.base, '/bbsinfo/editor/digest/', { headers: { cookie: sid } });
    assert.equal(empty.status, 200);
    assert.doesNotMatch(await empty.text(), /Sammelmail an Marc testen/);
    await cms.createDraft(uuid, 'Testmeldung', 'Inhalt');
    await cms.publishUpdate(uuid, 1);
    const preview = await request(fixture.base, '/bbsinfo/editor/digest/', { headers: { cookie: sid } });
    const html = await preview.text();
    assert.match(html, /Testmeldung/);
    assert.match(html, /Vorschau der HTML-Sammelmail/);
    assert.match(html, /Persönliche Abos werden unabhängig von diesem Test/);
    assert.doesNotMatch(html, /Abonnentenversand ist noch nicht aktiv/);
    assert.match(html, /Inhalt/);
    assert.match(html, /admin@school\.example/);
    assert.doesNotMatch(html, /kollegium@school\.example/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(fixture.base, '/bbsinfo/editor/digest/send-test', { method: 'POST', headers, body: new URLSearchParams({ csrf }) })).status, 400);
    assert.equal(sent.length, 0);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/digest/send-test', { method: 'POST', headers, body: new URLSearchParams({ csrf, confirm: 'yes' }) })).status, 303);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].recipient, TEST_RECIPIENT);
    assert.match(sent[0].notice.body, /https:\/\/apps\.school\.example\/bbsinfo\/updates\/1/);
    assert.match(sent[0].notice.body, /Inhalt/);
    assert.match(sent[0].notice.html, /Beitrag in BBS Info öffnen/);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Sammelmail-Text normalisiert Titel und verweigert leere Auswahl', () => {
  assert.throws(() => digestNotice([]), /Ungültige/);
  const notice = digestNotice([{ id: 8, title: 'Neu\r\nBcc: fremd' }]);
  assert.equal(notice.subject, 'BBS Info: 1 neue Meldung');
  assert.match(notice.body, /Neu Bcc: fremd/);
  assert.match(notice.body, /\/bbsinfo\/updates\/8/);
});

test('Sammelmail enthält formatierte Beiträge und lädt keine geschützten oder fremden Bilder', () => {
  const notice = digestNotice([{ id: 8, title: 'Neu <Test>', body: 'Absatz und Bild', bodyHtml: '<h2>Absatz</h2><p>Ein <strong>wichtiger</strong> Text.</p><img src="/bbsinfo/editor-images/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"><img src="https://fremd.example/pixel"><script>alert(1)</script>' }]);
  assert.match(notice.html, /Neu &lt;Test&gt;/);
  assert.match(notice.html, /<strong>wichtiger<\/strong>/);
  assert.match(notice.html, /Enthaltene Bilder/);
  assert.doesNotMatch(notice.html, /<img|<script|fremd\.example/);
  assert.match(notice.body, /Absatz und Bild/);
});

test('Mailtext enthält eine feste interne Zieladresse und keinen ungefilterten Titelumbruch', () => {
  const notice = issueNotice({ number: 93, title: 'Neu\r\nBcc: fremd', publishedAt: '26.10.2026' });
  assert.equal(notice.subject, 'BBS Info 93: Neu Bcc: fremd');
  assert.match(notice.body, /https:\/\/apps\.school\.example\/bbsinfo\/issues\/93/);
});

test('Bausteine und formatierte Beiträge bleiben redaktionell geschützt und sicher lesbar', async () => {
  const cms = fakeCmsStore();
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    const settingsPage = await request(fixture.base, '/bbsinfo/editor/templates/', { headers: { cookie: sid } });
    assert.equal(settingsPage.status, 200);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(await settingsPage.text())[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(fixture.base, '/bbsinfo/editor/templates/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, name: 'Personalrat', bodyHtml: '<p>Mitteilung des Personalrats</p>', enabled: '1' }) })).status, 303);
    const editorPage = await request(fixture.base, '/bbsinfo/editor/', { headers: { cookie: sid } });
    const editorHtml = await editorPage.text();
    assert.match(editorHtml, /Personalrat/);
    assert.match(editorHtml, /id="template-1"/);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/drafts', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Neuigkeit', bodyHtml: '<h2>Hallo</h2><p>Willkommen <strong>im Kollegium</strong><script>alert(1)</script></p>' }) })).status, 303);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1' }) })).status, 303);
    const updates = await request(fixture.base, '/bbsinfo/updates/', { headers: { cookie: sid } });
    const updateHtml = await updates.text();
    assert.match(updateHtml, /<h2>Hallo<\/h2>/);
    assert.match(updateHtml, /<strong>im Kollegium<\/strong>/);
    assert.doesNotMatch(updateHtml, /alert\(1\)/);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Herbst', bodyHtml: '', period: 'Oktober', updateId: '1' }) })).status, 303);
    const issue = await request(fixture.base, '/bbsinfo/issues/93', { headers: { cookie: sid } });
    assert.match(await issue.text(), /<strong>im Kollegium<\/strong>/);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }

  const reader = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Leser' });
  try {
    const sid = await login(reader);
    assert.equal((await request(reader.base, '/bbsinfo/editor/templates/', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(reader.base, '/bbsinfo/editor/templates/save', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Fremd' })).status, 403);
  } finally { await new Promise((resolve) => reader.app.close(resolve)); }
});

test('Einstellungen zeigen getrennte Tabs und speichern nur den gewählten Bereich', async () => {
  const cms = fakeCmsStore();
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    const issueResponse = await request(fixture.base, '/bbsinfo/editor/settings/', { headers: { cookie: sid } });
    const issueHtml = await issueResponse.text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(issueHtml)[1];
    assert.match(issueHtml, /aria-label="Einstellungsbereiche"/);
    assert.match(issueHtml, /tab=issues" aria-current="page"/);
    assert.match(issueHtml, /name="mailSubject"/);
    assert.doesNotMatch(issueHtml, /name="digestCadence"|id="template-new"/);

    const updateResponse = await request(fixture.base, '/bbsinfo/editor/settings/?tab=updates', { headers: { cookie: sid } });
    const updateHtml = await updateResponse.text();
    assert.match(updateHtml, /tab=updates" aria-current="page"/);
    assert.match(updateHtml, /name="digestCadence"/);
    assert.doesNotMatch(updateHtml, /name="mailSubject"|id="template-new"/);

    const templateResponse = await request(fixture.base, '/bbsinfo/editor/settings/?tab=templates', { headers: { cookie: sid } });
    const templateHtml = await templateResponse.text();
    assert.match(templateHtml, /tab=templates" aria-current="page"/);
    assert.match(templateHtml, /id="template-new"/);
    assert.doesNotMatch(templateHtml, /name="mailSubject"|name="digestCadence"/);
    assert.match(templateResponse.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);

    const original = await cms.getAppSettings();
    const saved = await request(fixture.base, '/bbsinfo/editor/settings/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, settingsTab: 'updates', digestCadence: 'disabled' }) });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/bbsinfo/editor/settings/?tab=updates');
    assert.deepEqual(await cms.getAppSettings(), { ...original, digestCadence: 'disabled' });
    const issueSaved = await request(fixture.base, '/bbsinfo/editor/settings/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, settingsTab: 'issues', mailSubject: 'Neue Ausgabe {nummer}', mailBody: 'Hier ist {link}' }) });
    assert.equal(issueSaved.status, 303);
    assert.equal(issueSaved.headers.get('location'), '/bbsinfo/editor/settings/?tab=issues');
    assert.deepEqual(await cms.getAppSettings(), { mailSubject: 'Neue Ausgabe {nummer}', mailBody: 'Hier ist {link}', digestCadence: 'disabled' });
    assert.equal((await request(fixture.base, '/bbsinfo/editor/settings/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, settingsTab: 'unknown', digestCadence: 'every_monday' }) })).status, 400);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Schuljahr wird zum Veröffentlichungszeitpunkt in Berliner Ortszeit bestimmt', () => {
  assert.equal(currentSchoolYear(Date.parse('2026-07-31T21:59:59Z')), '2025/26');
  assert.equal(currentSchoolYear(Date.parse('2026-07-31T22:00:00Z')), '2026/27');
});

test('Nach Veröffentlichung bleibt die Redaktion bei weiteren Entwürfen geöffnet', async () => {
  const cms = fakeCmsStore();
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    const html = await (await request(fixture.base, '/bbsinfo/editor/', { headers: { cookie: sid } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    await cms.createDraft(uuid, 'Erster Beitrag', 'Text');
    await cms.createDraft(uuid, 'Zweiter Beitrag', 'Text');
    const first = await request(fixture.base, '/bbsinfo/editor/publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1' }) });
    assert.equal(first.headers.get('location'), '/bbsinfo/editor/');
    const second = await request(fixture.base, '/bbsinfo/editor/publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '2' }) });
    assert.equal(second.headers.get('location'), '/bbsinfo/');
    await cms.createIssueDraft(uuid, 'Alter Ausgabenentwurf', 'Text', '2026/27', '', []);
    const fresh = await request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Neue Ausgabe', body: 'Text' }) });
    assert.equal(fresh.headers.get('location'), '/bbsinfo/editor/issues/?mailTest=unavailable');
    const old = await request(fixture.base, '/bbsinfo/editor/issues/publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1' }) });
    assert.equal(old.headers.get('location'), '/bbsinfo/?mailTest=unavailable');
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Neue Ausgabe sendet im Pilotbetrieb automatisch genau eine Testmail an Marc', async () => {
  const cms = fakeCmsStore();
  const sent = [];
  const mailConfig = { password: 'nur-im-Test', issueRecipient: 'staff@school.example', testRecipient: TEST_RECIPIENT };
  const fixture = await setup(null, cms, validInfo, null, mailConfig, (config, issue, appSettings) => sendIssueNotice(config, issue, appSettings, async (_config, recipient, notice) => sent.push({ recipient, notice })));
  try {
    const sid = await login(fixture);
    const html = await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    const publish = await request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Pilot-Ausgabe', body: 'Text' }) });
    assert.equal(publish.status, 303);
    assert.equal(publish.headers.get('location'), '/bbsinfo/?mailTest=sent');
    assert.deepEqual(sent.map((mail) => mail.recipient), [TEST_RECIPIENT]);
    assert.match(sent[0].notice.subject, /Pilot-Ausgabe/);
    assert.match(await (await request(fixture.base, '/bbsinfo/?mailTest=sent', { headers: { cookie: sid } })).text(), /Testmail wurde an Marc gesendet/);
    assert.equal(sent.length, 1);
    assert.ok(cms.events.some((event) => event.action === 'issue.mail_test'));
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Fehlgeschlagene Testmail lässt veröffentlichte Ausgabe bestehen', async () => {
  const cms = fakeCmsStore();
  const mailConfig = { password: 'nur-im-Test', issueRecipient: 'staff@school.example', testRecipient: TEST_RECIPIENT };
  const fixture = await setup(null, cms, validInfo, null, mailConfig, async () => { throw new Error('SMTP test failure'); });
  try {
    const sid = await login(fixture);
    const html = await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    const publish = await request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Bleibt veröffentlicht', body: 'Text' }) });
    assert.equal(publish.headers.get('location'), '/bbsinfo/?mailTest=failed');
    assert.equal((await request(fixture.base, '/bbsinfo/issues/93', { headers: { cookie: sid } })).status, 200);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Automatische Ausgaben-Testmail sendet nur nach Audit-Start und meldet fehlenden Abschluss als unklar', async (t) => {
  for (const scenario of [
    { failedAction: 'issue.mail_test_start', status: 'not_sent', sends: 0 },
    { failedAction: 'issue.mail_test', status: 'uncertain', sends: 1 },
  ]) await t.test(scenario.failedAction, async () => {
    const cms = fakeCmsStore();
    const originalAudit = cms.recordAudit.bind(cms);
    cms.recordAudit = async (...args) => {
      if (args[1] === scenario.failedAction) throw new Error('Audit nicht verfügbar');
      return originalAudit(...args);
    };
    const sent = [];
    const mailConfig = { password: 'nur-im-Test', issueRecipient: 'staff@school.example', testRecipient: TEST_RECIPIENT };
    const fixture = await setup(null, cms, validInfo, null, mailConfig, async () => { sent.push(TEST_RECIPIENT); });
    try {
      const sid = await login(fixture);
      const html = await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
      const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
      const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
      const publish = await request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Audittest', body: 'Text' }) });
      assert.equal(publish.status, 303);
      assert.equal(publish.headers.get('location'), `/bbsinfo/?mailTest=${scenario.status}`);
      assert.equal(sent.length, scenario.sends);
      assert.equal((await request(fixture.base, '/bbsinfo/issues/93', { headers: { cookie: sid } })).status, 200);
      const notice = await (await request(fixture.base, publish.headers.get('location'), { headers: { cookie: sid } })).text();
      assert.match(notice, scenario.status === 'not_sent' ? /Testmail wurde wegen eines Auditfehlers nicht versendet/ : /Auditeintrag konnte nicht abgeschlossen werden/);
      assert.equal(cms.events.some((event) => event.action === 'issue.mail_test_start'), scenario.sends === 1);
      assert.equal(cms.events.some((event) => event.action === 'issue.mail_test'), false);
    } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
  });
});

test('Manuelle Testmails sperren SMTP ohne Audit-Start und warnen bei fehlendem Audit-Abschluss', async (t) => {
  for (const scenario of [
    { kind: 'issue', failedAction: 'issue.mail_test_start', sends: 0 },
    { kind: 'issue', failedAction: 'issue.mail_test', sends: 1 },
    { kind: 'digest', failedAction: 'digest.test_start', sends: 0 },
    { kind: 'digest', failedAction: 'digest.test_sent', sends: 1 },
  ]) await t.test(scenario.failedAction, async () => {
    const cms = fakeCmsStore();
    await cms.createIssueDraft(uuid, 'Audittest', 'Text', '', '', []);
    await cms.publishIssue(uuid, 1);
    await cms.createDraft(uuid, 'Update', 'Text');
    await cms.publishUpdate(uuid, 1);
    const originalAudit = cms.recordAudit.bind(cms);
    cms.recordAudit = async (...args) => {
      if (args[1] === scenario.failedAction) throw new Error('Audit nicht verfügbar');
      return originalAudit(...args);
    };
    let sends = 0;
    const mailConfig = { password: 'nur-im-Test', issueRecipient: 'staff@school.example', testRecipient: TEST_RECIPIENT };
    const fixture = await setup(null, cms, validInfo, null, mailConfig, async () => { sends++; }, null, null, async () => { sends++; });
    try {
      const sid = await login(fixture);
      const previewPath = scenario.kind === 'issue' ? '/bbsinfo/editor/issues/93/mail' : '/bbsinfo/editor/digest/';
      const path = scenario.kind === 'issue' ? '/bbsinfo/editor/issues/93/mail-test' : '/bbsinfo/editor/digest/send-test';
      const html = await (await request(fixture.base, previewPath, { headers: { cookie: sid } })).text();
      const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
      const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
      const response = await request(fixture.base, path, { method: 'POST', headers, body: new URLSearchParams({ csrf, confirm: scenario.kind === 'issue' ? '93' : 'yes' }) });
      assert.equal(response.status, 503);
      assert.match(await response.text(), scenario.sends === 0 ? /Es wurde keine Testmail versendet/ : /Bitte zuerst Marcs Postfach prüfen/);
      assert.equal(sends, scenario.sends);
      const startAction = scenario.kind === 'issue' ? 'issue.mail_test_start' : 'digest.test_start';
      const sentAction = scenario.kind === 'issue' ? 'issue.mail_test' : 'digest.test_sent';
      assert.equal(cms.events.some((event) => event.action === startAction), scenario.sends === 1);
      assert.equal(cms.events.some((event) => event.action === sentAction), false);
    } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
  });
});

test('Nur Marc verwaltet zusätzliche Redakteure; Rechte werden nach IServ-Anmeldung wirksam und entziehbar', async () => {
  const cms = fakeCmsStore();
  const editorUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const editorInfo = { 'iserv:uuid': editorUuid, 'iserv:groups': [{ name: 'Kollegium' }], name: 'Melanie Test', email: 'melanie@school.example', email_verified: true };
  const owner = await setup(null, cms);
  const colleague = await setup(null, cms, editorInfo);
  try {
    const ownerSid = await login(owner);
    const colleagueSid = await login(colleague);
    const ownerHtml = await (await request(owner.base, '/bbsinfo/editor/settings/?tab=editors', { headers: { cookie: ownerSid } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(ownerHtml)[1];
    const headers = { cookie: ownerSid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.match(ownerHtml, /Redakteur hinzufügen/);
    assert.equal((await request(colleague.base, '/bbsinfo/editor/settings/?tab=editors', { headers: { cookie: colleagueSid } })).status, 403);
    assert.equal((await request(colleague.base, '/bbsinfo/editor/', { headers: { cookie: colleagueSid } })).status, 403);
    assert.equal((await request(owner.base, '/bbsinfo/editor/settings/editors/add', { method: 'POST', headers, body: new URLSearchParams({ csrf, email: editorInfo.email }) })).status, 303);
    assert.match(await (await request(owner.base, '/bbsinfo/editor/settings/?tab=editors', { headers: { cookie: ownerSid } })).text(), /melanie@school\.example/);
    assert.equal((await request(colleague.base, '/bbsinfo/editor/', { headers: { cookie: colleagueSid } })).status, 200);
    assert.equal((await request(colleague.base, '/bbsinfo/editor/settings/?tab=editors', { headers: { cookie: colleagueSid } })).status, 403);
    assert.doesNotMatch(await (await request(colleague.base, '/bbsinfo/editor/settings/', { headers: { cookie: colleagueSid } })).text(), /tab=editors/);
    assert.equal((await request(colleague.base, '/bbsinfo/editor/settings/editors/add', { method: 'POST', headers: { ...headers, cookie: colleagueSid }, body: new URLSearchParams({ csrf, email: 'other@school.example' }) })).status, 403);
    assert.equal((await request(colleague.base, '/bbsinfo/audit/', { headers: { cookie: colleagueSid } })).status, 403);
    assert.equal((await request(owner.base, '/bbsinfo/editor/settings/editors/remove', { method: 'POST', headers, body: new URLSearchParams({ csrf, email: editorInfo.email, confirm: editorInfo.email }) })).status, 303);
    assert.equal((await request(colleague.base, '/bbsinfo/editor/', { headers: { cookie: colleagueSid } })).status, 403);
  } finally {
    await new Promise((resolve) => owner.app.close(resolve));
    await new Promise((resolve) => colleague.app.close(resolve));
  }
});

test('Redaktion kann Testbeitrag und Ausgabe nach Bestätigung wirklich löschen', async () => {
  const cms = fakeCmsStore();
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    const html = await (await request(fixture.base, '/bbsinfo/editor/', { headers: { cookie: sid } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(fixture.base, '/bbsinfo/editor/drafts', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Test', body: 'Text' }) })).status, 303);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1' }) })).status, 303);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Testausgabe', body: 'Ausgabentext', updateId: '1' }) })).status, 303);
    const updateEditor = await (await request(fixture.base, '/bbsinfo/editor/', { headers: { cookie: sid } })).text();
    const issueEditor = await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
    assert.match(updateEditor, /<ul class="editor-items"><li class="editor-item">/);
    assert.match(issueEditor, /<ul class="editor-items"><li class="editor-item">/);
    assert.match(updateEditor, /<summary class="editor-edit-action">Bearbeiten<\/summary>/);
    assert.match(issueEditor, /<a class="editor-edit-action" href="\/bbsinfo\/editor\/issues\/93\/edit">Bearbeiten<\/a>/);
    assert.match(issueEditor, /<a href="\/bbsinfo\/">← Zur Startseite<\/a><\/p><h1>Ausgaben bearbeiten<\/h1>/);
    assert.match(updateEditor, /href="\/bbsinfo\/editor\/issues\/">Ausgaben bearbeiten<\/a>/);
    assert.match(updateEditor, /data-confirm-kind="Beitrag"[^>]*>.*?<button type="submit" class="delete-x"/s);
    assert.match(issueEditor, /data-confirm-kind="Ausgabe"[^>]*>.*?<button type="submit" class="delete-x"/s);
    assert.doesNotMatch(issueEditor, /danger-zone|danger-button/);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/delete-update', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1' }) })).status, 400);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/delete-update', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1', confirm: '1' }) })).status, 303);
    assert.doesNotMatch(await (await request(fixture.base, '/bbsinfo/updates/', { headers: { cookie: sid } })).text(), /<h2>Test<\/h2>/);
    assert.match(await (await request(fixture.base, '/bbsinfo/issues/93', { headers: { cookie: sid } })).text(), /<h2>Test<\/h2>/);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/delete', { method: 'POST', headers, body: new URLSearchParams({ csrf, number: '93', confirm: '93' }) })).status, 303);
    assert.equal((await request(fixture.base, '/bbsinfo/issues/93', { headers: { cookie: sid } })).status, 404);
    assert.equal(cms.events.some((event) => event.action === 'update.delete'), true);
    assert.equal(cms.events.some((event) => event.action === 'issue.delete'), true);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Veröffentlichte Ausgabe kann Beiträge und Steckbriefe nachträglich erhalten', async () => {
  const cms = fakeCmsStore();
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-issue-edit-'));
  const pdfName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const imageName = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const pdfFile = await renderIssuePdf({ number: 1, title: 'Steckbrief A', body: 'Profil', updates: [], attachments: [] }, null);
  const imageFile = readFileSync(new URL('../design/web/logo-mappe.png', import.meta.url));
  writeFileSync(join(root, pdfName), pdfFile, { mode: 0o600 });
  writeFileSync(join(root, imageName), imageFile, { mode: 0o600 });
  const firstFile = await cms.createSubmission(uuid, 'Steckbrief A', '', pdfName, 'application/pdf', pdfFile.length);
  const secondFile = await cms.createSubmission(uuid, 'Steckbrief B', '', imageName, 'image/png', imageFile.length);
  await cms.takeOverSubmission(uuid, firstFile);
  await cms.takeOverSubmission(uuid, secondFile);
  const fixture = await setup(null, cms, validInfo, root);
  try {
    const sid = await login(fixture);
    const editList = await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(editList)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.match(editList, /Berichtszeitraum \(optional\)/);
    assert.match(editList, /Steckbrief A/);
    await cms.createDraft(uuid, 'Neue Kollegin', 'Vorstellung');
    await cms.publishUpdate(uuid, 1);
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Herbst', body: 'Grußwort', submissionId: String(firstFile) }) })).status, 303);
    const listing = await (await request(fixture.base, '/bbsinfo/issues/', { headers: { cookie: sid } })).text();
    assert.match(listing, /BBS Info 93: Herbst/);
    assert.doesNotMatch(listing, /<ol reversed>/);
    const form = await (await request(fixture.base, '/bbsinfo/editor/issues/93/edit', { headers: { cookie: sid } })).text();
    assert.match(form, /name="submissionId" value="1" checked/);
    assert.match(form, /name="updateId" value="1"/);
    const change = new URLSearchParams({ csrf, title: 'Herbst korrigiert', bodyHtml: '<p>Neues Grußwort</p>', period: 'Oktober 2026', updateId: '1' });
    change.append('submissionId', String(firstFile));
    change.append('submissionId', String(secondFile));
    assert.equal((await request(fixture.base, '/bbsinfo/editor/issues/93/edit', { method: 'POST', headers, body: change })).status, 303);
    const updated = await (await request(fixture.base, '/bbsinfo/issues/93', { headers: { cookie: sid } })).text();
    assert.match(updated, /Herbst korrigiert/);
    assert.match(updated, /Oktober 2026/);
    assert.match(updated, /Neue Kollegin/);
    assert.match(updated, /Steckbrief B/);
    assert.match(updated, /src="\/bbsinfo\/media\/1\/page\/1\.webp"/);
    assert.match(updated, /src="\/bbsinfo\/media\/2\/inline"/);
    assert.doesNotMatch(updated, /Steckbrief [AB] herunterladen/);
    assert.ok(updated.indexOf('src="/bbsinfo/media/2/inline"') < updated.indexOf('Ausgabe als PDF herunterladen'));
    assert.match(updated, /download="BBS-Info-93\.pdf"/);
    assert.equal((await request(fixture.base, '/bbsinfo/media/1/page/1.webp', { headers: { cookie: sid } })).headers.get('content-type'), 'image/webp');
    assert.equal((await request(fixture.base, '/bbsinfo/media/1/page/2.webp', { headers: { cookie: sid } })).status, 404);
    assert.equal((await request(fixture.base, '/bbsinfo/media/2/inline', { headers: { cookie: sid } })).headers.get('content-disposition'), 'inline; filename="Steckbrief-2.png"');
    assert.equal((await request(fixture.base, '/bbsinfo/media/1/page/1.webp')).status, 401);
    const issuePdf = await request(fixture.base, '/bbsinfo/issues/93.pdf', { headers: { cookie: sid } });
    assert.equal(issuePdf.status, 200);
    assert.equal(issuePdf.headers.get('content-disposition'), 'attachment; filename="BBS-Info-93.pdf"');
    assert.equal(Buffer.from(await issuePdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal(cms.events.some((event) => event.action === 'issue.edit'), true);
  } finally {
    await new Promise((resolve) => fixture.app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
  const reader = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Leser' });
  try {
    const sid = await login(reader);
    assert.equal((await request(reader.base, '/bbsinfo/editor/issues/93/edit', { headers: { cookie: sid } })).status, 403);
    assert.equal((await request(reader.base, '/bbsinfo/editor/issues/93/edit', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=Fremd' })).status, 403);
  } finally { await new Promise((resolve) => reader.app.close(resolve)); }
});

test('HEAD auf Ausgabenseite zählt Steckbrief-PDFs nicht erneut', async () => {
  const cms = fakeCmsStore();
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-issue-head-'));
  const storedName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pdf = await renderIssuePdf({ number: 1, title: 'Steckbrief', body: 'Profil', updates: [], attachments: [] }, null);
  writeFileSync(join(root, storedName), pdf, { mode: 0o600 });
  let pageCount = 0;
  let writes = 0;
  const attachment = { id: 1, title: 'Steckbrief', storedName, mediaType: 'application/pdf' };
  Object.defineProperty(attachment, 'pageCount', {
    get() { return pageCount; },
    set(value) { writes++; pageCount = value; },
  });
  cms.getPublishedIssue = async () => ({ number: 93, title: 'Ausgabe', body: '', updates: [], attachments: [attachment] });
  const fixture = await setup(null, cms, validInfo, root);
  try {
    const sid = await login(fixture);
    assert.equal((await request(fixture.base, '/bbsinfo/issues/93', { method: 'HEAD', headers: { cookie: sid } })).status, 200);
    assert.equal(writes, 0);
    const body = await (await request(fixture.base, '/bbsinfo/issues/93', { headers: { cookie: sid } })).text();
    assert.equal(writes, 1);
    assert.match(body, /src="\/bbsinfo\/media\/1\/page\/1\.webp"/);
  } finally {
    await new Promise((resolve) => fixture.app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Neue Ausgaben zeigen verwendete Inhalte eingeklappt und erlauben erneute Auswahl', async () => {
  const cms = fakeCmsStore();
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-issue-sources-'));
  const fixture = await setup(null, cms, validInfo, root);
  try {
    const sid = await login(fixture);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text())[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    await cms.createDraft(uuid, 'Meldung A', 'Text');
    await cms.publishUpdate(uuid, 1);
    await cms.saveContribution(uuid, null, 'Kollegenbericht A', 'Bericht');
    const fileId = await cms.createSubmission(uuid, 'Steckbrief A', '', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'application/pdf', 100);
    await cms.takeOverSubmission(uuid, fileId);
    const publish = (title) => request(fixture.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title, updateId: '1', contributionId: '1', submissionId: String(fileId) }) });
    assert.equal((await publish('Erste Ausgabe')).status, 303);
    const listing = await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
    const priorGroups = [...listing.matchAll(/<details class="issue-source-used">([\s\S]*?)<\/details>/g)].map((match) => match[1]);
    assert.equal(priorGroups.length, 3, priorGroups.map((group) => group.slice(0, 250)).join('\n'));
    assert.ok(priorGroups.some((group) => group.includes('Meldung A') && group.includes('BBS Info 93')));
    assert.ok(priorGroups.some((group) => group.includes('Kollegenbericht A') && group.includes('BBS Info 93')));
    assert.ok(priorGroups.some((group) => group.includes('Steckbrief A') && group.includes('BBS Info 93')));
    assert.doesNotMatch(listing, /<details class="issue-source-used" open/);
    const edit = await (await request(fixture.base, '/bbsinfo/editor/issues/93/edit', { headers: { cookie: sid } })).text();
    assert.match(edit, /name="contributionId" value="1" checked/);
    assert.match(edit, /name="submissionId" value="1" checked/);
    assert.equal((await publish('Zweite Ausgabe')).status, 303);
    const repeated = await (await request(fixture.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
    assert.match(repeated, /BBS Info 93, 94/);
  } finally {
    await new Promise((resolve) => fixture.app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Redaktionsbild ist vor Veröffentlichung privat und danach für das Kollegium sichtbar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-image-'));
  const cms = fakeCmsStore();
  const editor = await setup(null, cms, validInfo, null, null, undefined, null, root);
  let url;
  try {
    const sid = await login(editor);
    const html = await (await request(editor.base, '/bbsinfo/editor/', { headers: { cookie: sid } })).text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const form = new FormData();
    form.set('csrf', csrf);
    form.set('title', 'Profil.png');
    const original = readFileSync(new URL('../design/web/logo-mappe.png', import.meta.url));
    form.set('file', new Blob([original], { type: 'image/png' }), 'profil.png');
    const upload = await request(editor.base, '/bbsinfo/editor/images/upload', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example' }, body: form });
    assert.equal(upload.status, 201);
    url = (await upload.json()).url;
    assert.match(url, /^\/bbsinfo\/editor-images\/[0-9a-f-]{36}$/);
    const optimized = await request(editor.base, url, { headers: { cookie: sid } });
    assert.equal(optimized.status, 200);
    assert.equal(optimized.headers.get('content-type'), 'image/webp');
    assert.ok((await optimized.arrayBuffer()).byteLength < original.length);
    const beforeReader = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Leser' }, null, null, undefined, null, root);
    try {
      const readerSid = await login(beforeReader);
    assert.equal((await request(beforeReader.base, `${url}?w=200`, { headers: { cookie: readerSid } })).status, 404);
    } finally { await new Promise((resolve) => beforeReader.app.close(resolve)); }
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(editor.base, '/bbsinfo/editor/drafts', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Bildbeitrag', bodyHtml: `<p>Text</p><img src="${url}" alt="Profil" style="width: 100px">` }) })).status, 303);
    assert.equal((await request(editor.base, '/bbsinfo/editor/publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1' }) })).status, 303);
  } finally { await new Promise((resolve) => editor.app.close(resolve)); }
  const reader = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Leser' }, null, null, undefined, null, root);
  try {
    const sid = await login(reader);
    const image = await request(reader.base, url, { headers: { cookie: sid } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    const variant = await request(reader.base, `${url}?w=200`, { headers: { cookie: sid } });
    assert.equal(variant.status, 200);
    assert.equal(variant.headers.get('content-type'), 'image/webp');
    assert.ok((await variant.arrayBuffer()).byteLength < (await image.arrayBuffer()).byteLength);
    assert.match(await (await request(reader.base, '/bbsinfo/updates/', { headers: { cookie: sid } })).text(), /<img src="\/bbsinfo\/editor-images\/[0-9a-f-]{36}\?w=200"/);
  } finally {
    await new Promise((resolve) => reader.app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kollegin kann eigene Bilder im Beitragseditor sehen, andere Konten nicht', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-contribution-image-'));
  const cms = fakeCmsStore();
  const ownerUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const owner = await setup(null, cms, { ...validInfo, 'iserv:uuid': ownerUuid, name: 'Lea Test' }, null, null, undefined, null, root);
  let url;
  try {
    const sid = await login(owner);
    const landing = await request(owner.base, '/bbsinfo/contributions/', { headers: { cookie: sid } });
    assert.match(landing.headers.get('content-security-policy'), /connect-src 'self'/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(await landing.text())[1];
    const form = new FormData();
    form.set('csrf', csrf);
    form.set('title', 'Foto.png');
    form.set('file', new Blob([readFileSync(new URL('../design/web/logo-mappe.png', import.meta.url))], { type: 'image/png' }), 'foto.png');
    const upload = await request(owner.base, '/bbsinfo/editor/images/upload', { method: 'POST', headers: { cookie: sid, origin: 'https://apps.school.example' }, body: form });
    assert.equal(upload.status, 201);
    url = (await upload.json()).url;
    assert.equal((await request(owner.base, url, { headers: { cookie: sid } })).status, 200);
  } finally { await new Promise((resolve) => owner.app.close(resolve)); }
  const other = await setup(null, cms, { ...validInfo, 'iserv:uuid': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Andere' }, null, null, undefined, null, root);
  try {
    const sid = await login(other);
    assert.equal((await request(other.base, url, { headers: { cookie: sid } })).status, 404);
  } finally {
    await new Promise((resolve) => other.app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Viele Beiträge und Ausgaben bleiben über Seiten und direkte Beitragslinks erreichbar', async () => {
  const cms = fakeCmsStore();
  for (let id = 1; id <= 17; id++) {
    await cms.createDraft(uuid, `Meldung ${id}`, `Text ${id}`);
    await cms.publishUpdate(uuid, id);
    await cms.createAndPublishIssue(uuid, `Ausgabe ${id}`, `Vorwort ${id}`, '2026/27', '', []);
  }
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    const headers = { cookie: sid };
    const firstUpdates = await (await request(fixture.base, '/bbsinfo/updates/', { headers })).text();
    assert.match(firstUpdates, /<details class="updates-preferences"><summary>/);
    assert.ok(firstUpdates.indexOf('class="updates-preferences"') < firstUpdates.indexOf('id="update-17"'));
    assert.match(firstUpdates, /href="\/bbsinfo\/updates\/\?page=2"/);
    assert.doesNotMatch(firstUpdates, /<h2>Meldung 1<\/h2>/);
    const secondUpdates = await (await request(fixture.base, '/bbsinfo/updates/?page=2', { headers })).text();
    assert.match(secondUpdates, /<h2>Meldung 1<\/h2>/);
    assert.match(secondUpdates, /href="\/bbsinfo\/updates\/\?page=1"/);
    assert.equal((await request(fixture.base, '/bbsinfo/updates/1', { headers })).status, 200);
    assert.equal((await request(fixture.base, '/bbsinfo/updates/1')).status, 401);
    assert.equal((await request(fixture.base, '/bbsinfo/updates/?page=0', { headers })).status, 400);
    assert.equal((await request(fixture.base, '/bbsinfo/updates/?page=3', { headers })).status, 404);
    const issueList = await (await request(fixture.base, '/bbsinfo/issues/', { headers })).text();
    assert.match(issueList, /href="\/bbsinfo\/issues\/\?page=2"/);
    assert.match(await (await request(fixture.base, '/bbsinfo/issues/?page=2', { headers })).text(), /BBS Info 93: Ausgabe 1/);
    assert.match(await (await request(fixture.base, '/bbsinfo/editor/?publishedPage=2', { headers })).text(), /Meldung 1/);
    assert.match(await (await request(fixture.base, '/bbsinfo/editor/issues/?publishedPage=2', { headers })).text(), /BBS Info 93: Ausgabe 1/);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Audit und Statistik blättern in begrenzten Seiten', async () => {
  const cms = fakeCmsStore();
  cms.listUsageStats = async (days) => ({ days, daily: Array.from({ length: 35 }, (_, index) => ({ day: `${String(index + 1).padStart(2, '0')}.10.2026`, action: 'page.view', eventCount: 1 })).reverse(), topContent: [], activeUsers: 1, subscriptions: 0 });
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    for (let i = 0; i < 65; i++) await cms.recordAudit(uuid, 'page.view', 'page', 'home');
    const first = await (await request(fixture.base, '/bbsinfo/audit/', { headers: { cookie: sid } })).text();
    assert.match(first, /pagination-current" aria-current="page">1<\/span>/);
    assert.match(first, /page=2/);
    const nextHref = /href="(\/bbsinfo\/audit\/\?page=2&amp;through=[0-9]+)"/.exec(first)?.[1];
    assert.ok(nextHref);
    await cms.recordAudit(uuid, 'search.perform', 'search');
    const second = await (await request(fixture.base, nextHref.replaceAll('&amp;', '&'), { headers: { cookie: sid } })).text();
    assert.match(second, /pagination-current" aria-current="page">2<\/span>/);
    assert.match(second, /Zurück/);
    assert.equal((await request(fixture.base, '/bbsinfo/audit/?page=3', { headers: { cookie: sid } })).status, 404);
    const stats = await (await request(fixture.base, '/bbsinfo/stats/?days=90&page=2', { headers: { cookie: sid } })).text();
    assert.match(stats, /pagination-current" aria-current="page">2<\/span>/);
    assert.equal((await request(fixture.base, '/bbsinfo/stats/?days=90&page=4', { headers: { cookie: sid } })).status, 404);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Audit-Filter erreichen Listenansicht und CSV mit gleicher Berliner Datumsgrenze', async () => {
  const cms = fakeCmsStore();
  const observed = [];
  cms.listAuditPage = async (pageNumber, filters, through) => {
    observed.push({ kind: 'page', pageNumber, filters, through });
    return { events: [], page: pageNumber, pageCount: 1, through: '91' };
  };
  cms.listAudit = async (before, limit, filters) => {
    observed.push({ kind: 'csv', before, limit, filters });
    return [];
  };
  const fixture = await setup(null, cms);
  try {
    const sid = await login(fixture);
    const headers = { cookie: sid };
    const query = 'actor=Marc&action=issue.edit&object=94&from=2026-10-25&to=2026-10-25';
    const list = await request(fixture.base, `/bbsinfo/audit/?${query}`, { headers });
    assert.equal(list.status, 200);
    assert.match(await list.text(), /object=94&amp;from=2026-10-25&amp;to=2026-10-25/);
    const csv = await request(fixture.base, `/bbsinfo/audit/export.csv?${query}`, { headers });
    assert.equal(csv.status, 200);
    assert.equal(observed.length, 2);
    assert.equal(observed[0].filters.fromUtc, '2026-10-24 22:00:00');
    assert.equal(observed[1].filters.toUtc, '2026-10-25 23:00:00');
    assert.equal(observed[1].limit, 1000);
    assert.equal((await request(fixture.base, '/bbsinfo/audit/?from=2026-02-30', { headers })).status, 400);
    assert.equal((await request(fixture.base, '/bbsinfo/audit/export.csv?to=2026-99-99', { headers })).status, 400);
    assert.equal(observed.length, 2);
  } finally { await new Promise((resolve) => fixture.app.close(resolve)); }
});

test('Kollegenbeitrag bleibt bis zur Übernahme privat und kann danach nicht mehr geändert werden', async () => {
  const cms = fakeCmsStore();
  const readerUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const reader = await setup(null, cms, { ...validInfo, 'iserv:uuid': readerUuid, name: 'Lea Test' });
  try {
    const sid = await login(reader);
    const html = await (await request(reader.base, '/bbsinfo/contributions/', { headers: { cookie: sid } })).text();
    const homeHtml = await (await request(reader.base, '/bbsinfo/', { headers: { cookie: sid } })).text();
    assert.match(homeHtml, /class="personal-action" href="\/bbsinfo\/contributions\/">Meine Beiträge &amp; Steckbriefe<\/a>/);
    assert.doesNotMatch(homeHtml, /href="\/bbsinfo\/submissions\/">Meine Steckbriefe<\/a>/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(reader.base, '/bbsinfo/contributions/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Projektwoche', bodyHtml: '<p>Aus der Klasse berichtet.</p>' }) })).status, 303);
    assert.match(await (await request(reader.base, '/bbsinfo/contributions/', { headers: { cookie: sid } })).text(), /Projektwoche/);
    assert.equal((await request(reader.base, '/bbsinfo/contributions/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1', title: 'Projektwoche aktualisiert', bodyHtml: '<p>Neuer Bericht.</p>' }) })).status, 303);
    assert.equal((await request(reader.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).status, 403);
  } finally { await new Promise((resolve) => reader.app.close(resolve)); }
  const editor = await setup(null, cms);
  try {
    const sid = await login(editor);
    const html = await (await request(editor.base, '/bbsinfo/editor/issues/', { headers: { cookie: sid } })).text();
    assert.match(html, /Projektwoche aktualisiert · von Lea Test/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(editor.base, '/bbsinfo/editor/issues/create-publish', { method: 'POST', headers, body: new URLSearchParams({ csrf, title: 'Herbst', contributionId: '1' }) })).status, 303);
    const issue = await (await request(editor.base, '/bbsinfo/issues/93', { headers: { cookie: sid } })).text();
    assert.match(issue, /Projektwoche aktualisiert/);
    assert.match(issue, /von Lea Test/);
  } finally { await new Promise((resolve) => editor.app.close(resolve)); }
  const readerAgain = await setup(null, cms, { ...validInfo, 'iserv:uuid': readerUuid, name: 'Lea Test' });
  try {
    const sid = await login(readerAgain);
    const html = await (await request(readerAgain.base, '/bbsinfo/contributions/', { headers: { cookie: sid } })).text();
    assert.match(html, /Von der Redaktion übernommen/);
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
    const headers = { cookie: sid, origin: 'https://apps.school.example', 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(readerAgain.base, '/bbsinfo/contributions/save', { method: 'POST', headers, body: new URLSearchParams({ csrf, id: '1', title: 'Manipuliert', bodyHtml: '<p>Anderer Text.</p>' }) })).status, 409);
  } finally { await new Promise((resolve) => readerAgain.app.close(resolve)); }
});
