import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { provider } from './auth.mjs';
import { identityFromInfo, validateSettings, verifiedUuidFromInfo } from './access.mjs';
import { openArchiveStore } from './archive-store.mjs';
import { openCmsStore, normalizeAuditFilters } from './cms-store.mjs';
import { createAuditGapMarker } from './audit-gap-marker.mjs';
import { checkAuditCapacity } from './audit-capacity.mjs';
import { getSubmissionFile, parseSubmission, removeSubmissionFile, saveSubmissionFile, validateSubmissionRoot } from './submission-files.mjs';
import { readMailConfig, sendIssueNotice, sendDigestTest, sendCollegiumIssue, colleagueDeliveryEnabled, subscriberDeliveryEnabled, subscriberRecipientAllowed, TEST_RECIPIENT } from './mail.mjs';
import { dailyCutoffUtc, deliverVerifiedUpdates, isDailyMailWindow, isWeeklyMailWindow } from './notification-service.mjs';
import { createIdmGroupVerifier, readIdmCredentials } from './idm-eligibility.mjs';
import { renderIssuePdf } from './issue-pdf.mjs';
import { countPdfPages, renderPdfPage } from './submission-preview.mjs';
import { optimizeEditorUpload, renderEditorImageVariant } from './editor-image.mjs';
import { cleanRichText, plainFromHtml } from './rich-text.mjs';
import { base, page, feedbackToast, landing, home, searchPage, updatesPage, updateDetailPage, contributionsPage, editorPage, settingsPage, digestTestPage, issuesPage, issuePage, issueEditorPage, issueEditPage, issueMailPage, auditPage, auditCsv, statsPage, submissionsPage, archivePage } from './web-pages.mjs';

const origin = 'https://apps.school.example';
const publicAssets = new Map([
  [`${base}assets/app.css`, { path: fileURLToPath(new URL('../design/web/app.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
  [`${base}assets/landing.js`, { path: fileURLToPath(new URL('../design/web/landing.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  [`${base}assets/editor.js`, { path: fileURLToPath(new URL('../design/web/editor.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  [`${base}assets/feedback.js`, { path: fileURLToPath(new URL('../design/web/feedback.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  [`${base}assets/jodit.min.js`, { path: fileURLToPath(new URL('../node_modules/jodit/es2021/jodit.min.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  [`${base}assets/jodit.min.css`, { path: fileURLToPath(new URL('../node_modules/jodit/es2021/jodit.min.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
  [`${base}assets/logo-mappe.png`, { path: fileURLToPath(new URL('../design/web/logo-mappe.png', import.meta.url)), type: 'image/png' }],
  [`${base}assets/landing-steckbriefe.webp`, { path: fileURLToPath(new URL('../design/web/landing-steckbriefe.webp', import.meta.url)), type: 'image/webp' }],
  [`${base}assets/landing-steckbriefe-back.webp`, { path: fileURLToPath(new URL('../design/web/landing-steckbriefe-back.webp', import.meta.url)), type: 'image/webp' }],
]);
const sessionCookie = '__Secure-bbsinfo-session';
const transactionCookie = '__Secure-bbsinfo-transaction';
const token = () => randomBytes(32).toString('hex');
const cookie = (name, value, age, path = base) => `${name}=${value}; Path=${path}; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
const sameToken = (a, b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validArchiveQuery = (query) => query.length <= 200 && (query.match(/[\p{L}\p{N}]+/gu) || []).length <= 6;
function contentPageNumber(url, key) {
  const raw = url.searchParams.get(key);
  if (raw === null) return 1;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) return null;
  const page = Number(raw);
  return page <= 2000 ? page : null;
}
function auditFiltersFromUrl(url) {
  return normalizeAuditFilters(Object.fromEntries(['actor', 'action', 'object', 'from', 'to'].map((key) => [key, url.searchParams.get(key) || ''])));
}
export function currentSchoolYear(timestamp = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: 'numeric' }).formatToParts(new Date(timestamp)).filter((part) => part.type === 'year' || part.type === 'month').map((part) => [part.type, Number(part.value)]));
  const start = parts.month >= 8 ? parts.year : parts.year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}
const oauthErrors = new Set(['access_denied', 'invalid_grant', 'invalid_client', 'invalid_request', 'invalid_scope', 'server_error', 'temporarily_unavailable', 'interaction_required', 'login_required', 'consent_required']);
const errorTypes = new Set(['AuthorizationResponseError', 'ResponseBodyError', 'WWWAuthenticateChallengeError', 'ClientError', 'OperationProcessingError', 'TypeError', 'AbortError']);
const deniedLoginMessage = 'BBS Info ist für Mitglieder des Kollegiums freigeschaltet. Dieses IServ-Konto hat derzeit keinen Zugang. Bitte die Mitgliedschaft in „Kollegium“ prüfen.';
const incompleteLoginMessage = 'IServ konnte die Anmeldung nicht abschließen. BBS Info ist für das Kollegium vorgesehen und nur für die IServ-Gruppe „Kollegium“ freigeschaltet. Schülerinnen und Schüler können sich hier nicht anmelden. Falls du zum Kollegium gehörst, prüfe bitte deine Gruppenzugehörigkeit oder wende dich an die Administration.';
const temporaryLoginMessage = 'Die IServ-Anmeldung konnte gerade nicht abgeschlossen werden. Bitte versuche es später erneut. Falls du zum Kollegium gehörst und der Fehler bleibt, wende dich bitte an die Administration.';

function knownOAuthError(error) {
  let cause = error;
  for (let depth = 0; depth < 4 && cause; depth++, cause = cause.cause) {
    if ((cause.name === 'AuthorizationResponseError' || cause.name === 'ResponseBodyError') && oauthErrors.has(cause.error)) return cause.error;
  }
  return null;
}

function safeLoginError(error) {
  let cause = error?.cause;
  for (let depth = 0; depth < 3 && cause; depth++, cause = cause.cause) {
    if (!errorTypes.has(cause.name)) continue;
    const parts = [`type=${cause.name}`];
    if (oauthErrors.has(cause.error)) parts.push(`oauth=${cause.error}`);
    if (Number.isInteger(cause.status) && cause.status >= 400 && cause.status <= 599) parts.push(`http=${cause.status}`);
    if (['ClientError', 'OperationProcessingError'].includes(cause.name) && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{2,50}$/.test(cause.code)) parts.push(`code=${cause.code}`);
    return parts.join(' ');
  }
  return 'type=unknown';
}

function cookies(request) {
  const result = Object.create(null);
  for (const part of (request.headers.cookie || '').split(';')) {
    const match = /^\s*([^=\s]+)=([^;]*)\s*$/.exec(part);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function submittedBody(form, maxText, optional = false) {
  if (!form.has('bodyHtml')) return { plain: form.get('body') || '', html: null };
  if (optional && !plainFromHtml(String(form.get('bodyHtml') || ''))) return { plain: '', html: null };
  const content = cleanRichText(form.get('bodyHtml'), maxText);
  return { plain: content.plain, html: content.html };
}

async function readForm(req, maxBytes = 24000) {
  if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error('Ungültiges Formular.');
  if (Number(req.headers['content-length'] || 0) > maxBytes) throw new Error('Formular zu groß.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Formular zu groß.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createApp({ settings, getProvider, archiveStore = null, cmsStore = null, auditGapMarker = null, submissionRoot = null, editorImageRoot = null, mailConfig = null, sendIssue = sendIssueNotice, sendDigest = sendDigestTest, sendLiveIssue = sendCollegiumIssue, verifySubscriberGroup = null, now = Date.now }) {
  const config = validateSettings(settings);
  if (typeof getProvider !== 'function') throw new Error('OIDC-Provider fehlt.');
  const personalMailPaused = mailConfig?.personalMailRequiresIdm === true && typeof verifySubscriberGroup !== 'function';
  const transactions = new Map();
  const sessions = new Map();
  const verifyPendingEditor = async (uuid, email) => {
    if (typeof verifySubscriberGroup !== 'function') return false;
    try { return await verifySubscriberGroup(uuid, email) === true; }
    catch { return false; }
  };
  async function withEditorGrant(identity) {
    if (identity && !identity.editor && cmsStore?.hasEditorGrant) identity.editor = await cmsStore.hasEditorGrant(identity, verifyPendingEditor);
    return identity;
  }
  async function auditAuthFailure(category, actor = null) {
    if (!cmsStore?.recordAuthFailure) return;
    try { await cmsStore.recordAuthFailure(category, actor); }
    catch { process.stderr.write('BBS Info: Anmeldefehler konnte nicht protokolliert werden.\n'); }
  }
  async function readAuditHealth() {
    if (!auditGapMarker) return null;
    try { return await auditGapMarker.read(); }
    catch {
      process.stderr.write('BBS Info: Audit-Prüfstatus konnte nicht gelesen werden.\n');
      return { unavailable: true };
    }
  }
  async function issueSourcePage(kind, query = '', used = false, pageNumber = 1) {
    if (kind === 'submissions' && !submissionRoot) return { items: [], hasMore: false, page: pageNumber };
    const method = { updates: 'listIssueUpdates', contributions: 'listIssueContributions', submissions: 'listIssueSubmissions' }[kind];
    if (!method) throw new Error('Ungültige Ausgabenquelle.');
    const result = await cmsStore[method]({ query, used, page: pageNumber });
    // Array-basierte Store-Anbindungen bleiben lesbar; der eingebaute Store filtert bereits in SQL.
    const legacy = Array.isArray(result) ? result.filter((item) => !!item.usedInIssues === used && (!query || [item.title, item.author, item.ownerName].some((value) => String(value || '').toLocaleLowerCase('de').includes(query.toLocaleLowerCase('de'))))) : null;
    const state = legacy ? { items: legacy.slice((pageNumber - 1) * 30, pageNumber * 30), hasMore: legacy.length > pageNumber * 30, page: pageNumber } : result;
    if (!state || !Array.isArray(state.items) || state.items.length > 30 || typeof state.hasMore !== 'boolean') throw new Error('Ungültige Ausgabenquelle.');
    return {
      items: state.items.map((item) => ({ id: Number(item.id), title: String(item.title || ''), publishedAtUtc: String(item.publishedAtUtc || ''), author: String(item.author || ''), ownerName: String(item.ownerName || ''), usedInIssues: item.usedInIssues ? String(item.usedInIssues) : null })),
      hasMore: state.hasMore,
      page: pageNumber,
    };
  }
  async function issueSourceGroups(kind) {
    const [fresh, used] = await Promise.all([issueSourcePage(kind), issueSourcePage(kind, '', true)]);
    return { fresh, used };
  }
  async function auditedTestMail(actor, startAction, sentAction, type, id, deliver) {
    try { await cmsStore.recordAudit(actor, startAction, type, id); }
    catch {
      process.stderr.write('BBS Info: Testmail nicht gestartet, Audit-Eintrag fehlgeschlagen.\n');
      return 'not_sent';
    }
    try { await deliver(); }
    catch {
      process.stderr.write('BBS Info: Testmailversand fehlgeschlagen oder Status unklar.\n');
      return 'failed';
    }
    try { await cmsStore.recordAudit(actor, sentAction, type, id); }
    catch {
      process.stderr.write('BBS Info: Testmail versendet, Audit-Abschluss fehlgeschlagen.\n');
      return 'uncertain';
    }
    return 'sent';
  }
  const testMailError = (status) => page('Testmailstatus', `<section><h1>${status === 'not_sent' ? 'Testmail nicht gesendet' : 'Testmailstatus unklar'}</h1><p>${status === 'not_sent' ? 'Der erforderliche Auditeintrag konnte nicht gespeichert werden. Es wurde keine Testmail versendet.' : 'Bitte zuerst Marcs Postfach prüfen, bevor die Testmail erneut gesendet wird.'}</p></section>`);
  async function pilotIssueMail(number, actor) {
    if (!mailConfig?.password || mailConfig.testRecipient !== TEST_RECIPIENT) return 'unavailable';
    try {
      const [issue, appSettings] = await Promise.all([cmsStore.getPublishedIssue(number), cmsStore.getAppSettings()]);
      if (!issue) throw new Error('Ausgabe nicht gefunden.');
      return auditedTestMail(actor, 'issue.mail_test_start', 'issue.mail_test', 'issue', number, () => sendIssue(mailConfig, issue, appSettings));
    } catch {
      process.stderr.write('BBS Info: Automatische Ausgaben-Testmail nicht vorbereitet.\n');
      return 'failed';
    }
  }
  const imageVariants = new Map();
  let loginWindow = now();
  let loginCount = 0;
  let inFlight = 0;
  const authWaiters = [];
  async function acquireAuthSlot() {
    if (inFlight < 8) { inFlight++; return; }
    if (authWaiters.length >= 100) throw new Error('IServ-Prüfungen ausgelastet.');
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = authWaiters.indexOf(waiter);
        if (index !== -1) {
          authWaiters.splice(index, 1);
          reject(new Error('IServ-Prüfung dauert zu lange.'));
        }
      }, 5000);
      authWaiters.push(waiter);
    });
  }
  function releaseAuthSlot() {
    const next = authWaiters.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else inFlight--;
  }
  function refreshIdentity(session, sid) {
    if (!session.refreshing) {
      session.refreshing = (async () => {
        await acquireAuthSlot();
        try {
          const auth = await getProvider();
          const identity = await withEditorGrant(identityFromInfo(await auth.refresh(session), config));
          if (identity && sessions.get(sid) === session) {
            session.identity = identity;
            if (cmsStore && (session.recordedName !== identity.name || session.recordedEmail !== identity.email)) {
              await cmsStore.rememberIdentity(identity);
              session.recordedName = identity.name;
              session.recordedEmail = identity.email;
            }
          }
          return identity;
        } finally { releaseAuthSlot(); }
      })().finally(() => { session.refreshing = null; });
    }
    return session.refreshing;
  }
  const clean = () => {
    for (const map of [transactions, sessions]) for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
  };
  const timer = setInterval(clean, 30000);
  timer.unref();
  let notificationsRunning = false;
  const notificationScan = { instant: { afterUserUuid: null }, daily: { afterUserUuid: null }, weekly: { afterUserUuid: null } };
  async function runNotifications() {
    if (notificationsRunning || !cmsStore || !subscriberDeliveryEnabled(mailConfig) || typeof verifySubscriberGroup !== 'function') return;
    notificationsRunning = true;
    try {
      await deliverVerifiedUpdates(cmsStore, mailConfig, 'instant', verifySubscriberGroup, undefined, null, notificationScan.instant);
      const timestamp = now();
      if (isDailyMailWindow(timestamp)) await deliverVerifiedUpdates(cmsStore, mailConfig, 'daily', verifySubscriberGroup, undefined, dailyCutoffUtc(timestamp), notificationScan.daily);
      if (isWeeklyMailWindow(timestamp) && (await cmsStore.getAppSettings()).digestCadence !== 'disabled') await deliverVerifiedUpdates(cmsStore, mailConfig, 'weekly', verifySubscriberGroup, undefined, null, notificationScan.weekly);
    } catch { process.stderr.write('BBS Info: Benachrichtigungsprüfung fehlgeschlagen.\n'); }
    finally { notificationsRunning = false; }
  }
  const notificationTimer = setInterval(() => { void runNotifications(); }, 60000);
  notificationTimer.unref();
  const retentionTimer = setInterval(() => { if (cmsStore?.pruneSearchEvents) void cmsStore.pruneSearchEvents().catch(() => process.stderr.write('BBS Info: Suchdatenbereinigung fehlgeschlagen.\n')); }, 24 * 60 * 60 * 1000);
  retentionTimer.unref();
  const app = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let feedbackSession = null;
    const send = (status, body) => {
      const notice = status === 200 && req.method === 'GET' ? feedbackSession?.flash : null;
      if (notice && body.includes('</body>')) {
        body = body.replace('</body>', `${feedbackToast(notice)}</body>`);
        feedbackSession.flash = null;
      }
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? '' : body);
    };
    const denyProtectedAccess = async (identity, section) => {
      try {
        if (!['editor', 'editor.issues', 'editor.templates', 'audit', 'stats', 'submissions'].includes(section)) throw new Error('Ungültiger geschützter Bereich.');
        await cmsStore.recordAudit(identity.uuid, 'access.denied', 'page', section);
      } catch {
        process.stderr.write('BBS Info: Abgewiesener Zugriff konnte nicht protokolliert werden.\n');
        return send(503, page('Vorübergehend nicht verfügbar', '<section><h1>BBS Info ist gerade nicht verfügbar.</h1></section>'));
      }
      return send(403, page('Zugriff verweigert', '<section><h1>Zugriff verweigert</h1></section>'));
    };
    const redirect = (location, notice = '') => {
      if (notice && feedbackSession) feedbackSession.flash = notice;
      res.writeHead(303, { Location: location }); res.end();
    };
    try {
      if (!req.url || req.url.length > 4096) return send(414, landing('Anfrage zu lang.'));
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return send(400, landing('Ungültige Anfrage.'));
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(405, landing('Methode nicht erlaubt.'));
      const path = url.pathname;
      if ([`${base}editor/`, `${base}editor/issues/`, `${base}editor/templates/`, `${base}editor/digest/`, `${base}updates/`, `${base}contributions/`].includes(path) || (path === `${base}editor/settings/` && url.searchParams.get('tab') === 'templates') || /^\/bbsinfo\/updates\/[1-9][0-9]*$/.test(path) || /^\/bbsinfo\/issues\/[1-9][0-9]*$/.test(path) || /^\/bbsinfo\/editor\/issues\/[1-9][0-9]*\/edit$/.test(path)) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      const c = cookies(req);
      clean();
      if (publicAssets.has(path) && (req.method === 'GET' || req.method === 'HEAD')) {
        const asset = publicAssets.get(path);
        const image = statSync(asset.path);
        if (path === `${base}assets/logo-mappe.png`) res.setHeader('Cache-Control', 'no-cache');
        res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': image.size });
        if (req.method === 'HEAD') return res.end();
        createReadStream(asset.path).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (path === '/bbsinfo' && req.method === 'GET') return redirect(base);
      if (path === `${base}oidc/login` && req.method === 'GET') {
        if (now() - loginWindow > 60000) { loginWindow = now(); loginCount = 0; }
        if (++loginCount > 30 || transactions.size >= 100) return send(429, landing('Bitte später erneut versuchen.'));
        try { await acquireAuthSlot(); }
        catch {
          await auditAuthFailure('auth.session_unavailable');
          return send(503, landing(temporaryLoginMessage));
        }
        try {
          const auth = await getProvider();
          const transaction = await auth.begin();
          const tid = token();
          transactions.set(tid, { ...transaction, expires: now() + 300000 });
          res.setHeader('Set-Cookie', cookie(transactionCookie, tid, 300, `${base}oidc/`));
          return redirect(transaction.url);
        } catch (error) {
          process.stderr.write(`BBS Info Login-Fehler: phase=begin ${safeLoginError(error)}\n`);
          await auditAuthFailure('auth.login_start_failed');
          return send(503, landing(temporaryLoginMessage));
        } finally { releaseAuthSlot(); }
      }
      if (path === `${base}oidc/callback` && req.method === 'GET') {
        const tx = transactions.get(c[transactionCookie]);
        transactions.delete(c[transactionCookie]);
        res.setHeader('Set-Cookie', cookie(transactionCookie, '', 0, `${base}oidc/`));
        if (!tx || tx.expires <= now()) return send(400, landing('Die Anmeldung ist abgelaufen. Bitte neu beginnen.'));
        try { await acquireAuthSlot(); }
        catch {
          await auditAuthFailure('auth.session_unavailable');
          return send(503, landing(temporaryLoginMessage));
        }
        let loginStage = 'provider';
        try {
          const auth = await getProvider();
          loginStage = 'oidc';
          const result = await auth.complete(new URL(path + url.search, origin), tx);
          loginStage = 'identity';
          const identity = await withEditorGrant(identityFromInfo(result.info, config));
          if (!identity) {
            const claim = verifiedUuidFromInfo(result.info);
            const validUuid = claim !== null;
            process.stderr.write(`BBS Info OIDC-Zugriff abgelehnt: uuid_gueltig=${validUuid} gruppe_liste=${Array.isArray(result.info?.['iserv:groups'])} gruppen_anzahl=${Array.isArray(result.info?.['iserv:groups']) ? result.info['iserv:groups'].length : 0} userinfo_gruppen=${result.groupSources?.userInfo || 'unknown'} idtoken_gruppen=${result.groupSources?.idToken || 'unknown'} admin_uuid=${validUuid && claim.toLowerCase() === config.auditOwnerUuid} redaktion_uuid=${validUuid && config.editorUuids.includes(claim.toLowerCase())}.\n`);
            await auditAuthFailure('auth.identity_denied', claim);
            return send(403, landing(deniedLoginMessage));
          }
          if (!Number.isFinite(result.expires) || result.expires <= now() || (sessions.size >= 1000 && !sessions.has(c[sessionCookie]))) {
            process.stderr.write('BBS Info Login-Fehler: phase=session_limit\n');
            await auditAuthFailure('auth.session_unavailable', identity.uuid);
            return send(503, landing(temporaryLoginMessage));
          }
          loginStage = 'identity_store';
          if (cmsStore) {
            await cmsStore.rememberIdentity(identity);
            await cmsStore.recordAudit(identity.uuid, 'session.login');
          }
          const sid = token();
          const expires = Math.min(result.expires, now() + 3600000);
          sessions.delete(c[sessionCookie]);
          sessions.set(sid, { ...result, identity, recordedName: cmsStore ? identity.name : null, recordedEmail: cmsStore ? identity.email : null, csrf: token(), expires });
          res.setHeader('Set-Cookie', [cookie(transactionCookie, '', 0, `${base}oidc/`), cookie(sessionCookie, sid, Math.max(1, Math.floor((expires - now()) / 1000)))]);
          return redirect(base);
        } catch (error) {
          const phase = ['token', 'userinfo'].includes(error?.step) ? error.step : loginStage;
          const oauth = knownOAuthError(error);
          process.stderr.write(`BBS Info Login-Fehler: phase=${phase} ${safeLoginError(error)}\n`);
          await auditAuthFailure(phase === 'identity' || phase === 'identity_store' ? 'auth.finalize_failed' : oauth === 'access_denied' ? 'auth.access_denied' : 'auth.oidc_error');
          if (phase === 'token' && oauth === 'access_denied') {
            return send(403, landing('IServ hat die Anmeldung für dieses Konto abgelehnt. BBS Info ist für das Kollegium freigeschaltet. Bitte die Mitgliedschaft in „Kollegium“ prüfen.'));
          }
          if (phase === 'token' && oauth === 'invalid_grant') {
            return send(400, landing('Die IServ-Anmeldung konnte nicht abgeschlossen werden. Bitte neu beginnen.'));
          }
          return send(503, landing(phase === 'token' && oauth === 'invalid_request' ? incompleteLoginMessage : temporaryLoginMessage));
        } finally { releaseAuthSlot(); }
      }
      if (path === `${base}logout` && req.method === 'POST') {
        const session = sessions.get(c[sessionCookie]);
        if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return send(403, landing('Zugriff verweigert.'));
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString('utf8');
          if (body.length > 4096) return send(413, landing('Anfrage zu groß.'));
        }
        if (!session || !sameToken(new URLSearchParams(body).get('csrf'), session.csrf)) return send(403, landing('Zugriff verweigert.'));
        if (cmsStore) await cmsStore.recordAudit(session.identity.uuid, 'session.logout');
        sessions.delete(c[sessionCookie]);
        res.setHeader('Set-Cookie', cookie(sessionCookie, '', 0));
        return redirect(base);
      }
      const archivePath = `${base}archive/`;
      const pdfMatch = /^\/bbsinfo\/archive\/([1-9][0-9]*)\.pdf$/.exec(path);
      const thumbnailMatch = /^\/bbsinfo\/archive\/([1-9][0-9]*)\/thumbnail\.webp$/.exec(path);
      const issueMatch = /^\/bbsinfo\/issues\/([1-9][0-9]*)$/.exec(path);
      const issuePdfMatch = /^\/bbsinfo\/issues\/([1-9][0-9]*)\.pdf$/.exec(path);
      const issueMailMatch = /^\/bbsinfo\/editor\/issues\/([1-9][0-9]*)\/mail$/.exec(path);
      const issueMailTestMatch = /^\/bbsinfo\/editor\/issues\/([1-9][0-9]*)\/mail-test$/.exec(path);
      const issueEditMatch = /^\/bbsinfo\/editor\/issues\/([1-9][0-9]*)\/edit$/.exec(path);
      const submissionFileMatch = /^\/bbsinfo\/submissions\/([1-9][0-9]*)\/file$/.exec(path);
      const mediaMatch = /^\/bbsinfo\/media\/([1-9][0-9]*)$/.exec(path);
      const mediaInlineMatch = /^\/bbsinfo\/media\/([1-9][0-9]*)\/inline$/.exec(path);
      const mediaPageMatch = /^\/bbsinfo\/media\/([1-9][0-9]*)\/page\/([1-9][0-9]*)\.webp$/.exec(path);
      const editorImageMatch = /^\/bbsinfo\/editor-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path);
      const updateDetailMatch = /^\/bbsinfo\/updates\/([1-9][0-9]*)$/.exec(path);
      const submissionsAvailable = cmsStore && submissionRoot;
      const imagesAvailable = cmsStore && editorImageRoot;
      const cmsGet = cmsStore && ([base + 'updates/', base + 'issues/', base + 'search/', base + 'contributions/', base + 'editor/', base + 'editor/issues/', base + 'editor/issue-sources', base + 'editor/templates/', base + 'editor/settings/', base + 'editor/digest/', base + 'audit/', base + 'audit/export.csv', base + 'stats/'].includes(path) || updateDetailMatch || issueMatch || issuePdfMatch || issueMailMatch || issueEditMatch || (submissionsAvailable && (path === `${base}submissions/` || submissionFileMatch || mediaMatch || mediaInlineMatch || mediaPageMatch)) || (imagesAvailable && editorImageMatch));
      const cmsPost = cmsStore && ([base + 'subscribe', base + 'contributions/save', base + 'contributions/delete', base + 'editor/drafts', base + 'editor/update', base + 'editor/publish', base + 'editor/delete-update', base + 'editor/issues/create-publish', base + 'editor/issues/publish', base + 'editor/issues/delete', base + 'editor/issues/delete-draft', base + 'editor/templates/save', base + 'editor/settings/save', base + 'editor/settings/editors/add', base + 'editor/settings/editors/remove', base + 'editor/digest/send-test'].includes(path) || issueMailMatch || issueMailTestMatch || issueEditMatch || (imagesAvailable && path === `${base}editor/images/upload`) || (submissionsAvailable && [base + 'submissions/upload', base + 'submissions/replace', base + 'submissions/delete', base + 'submissions/take-over'].includes(path)));
      if (((path === base || (archiveStore && (path === archivePath || pdfMatch || thumbnailMatch)) || cmsGet) && (req.method === 'GET' || req.method === 'HEAD')) || (cmsPost && req.method === 'POST')) {
        const sid = c[sessionCookie];
        const session = sessions.get(sid);
        if (!session || session.expires <= now()) return send(path === base ? 200 : 401, landing(sid ? 'Sitzung abgelaufen. Bitte erneut anmelden.' : 'Bitte mit IServ anmelden.'));
        try {
          const identity = await refreshIdentity(session, sid);
          if (!identity || sessions.get(sid) !== session) {
            sessions.delete(sid);
            res.setHeader('Set-Cookie', cookie(sessionCookie, '', 0));
            return send(403, landing('Dieses IServ-Konto ist nicht für BBS Info freigeschaltet.'));
          }
          feedbackSession = session;
          if (path === base) {
            const highlights = cmsStore ? await cmsStore.homeHighlights() : { updates: [], issues: [] };
            if (cmsStore && req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'home');
            return send(200, home(identity, session.csrf, !!archiveStore, !!cmsStore, !!submissionsAvailable, highlights, url.searchParams.get('mailTest')));
          }
          if (path === archivePath) {
            const query = url.searchParams.get('q') || '';
            if (!validArchiveQuery(query)) return send(400, page('Suche eingrenzen', '<section><h1>Suche eingrenzen</h1><p>Bitte höchstens sechs Suchwörter und 200 Zeichen eingeben.</p></section>'));
            if (cmsStore && req.method === 'GET') {
              await cmsStore.recordAudit(identity.uuid, url.searchParams.has('q') ? 'archive.search' : 'archive.list', 'archive');
              if (query.trim().length >= 2) await cmsStore.recordSearch(identity.uuid, query, 'archive');
            }
            return send(200, archivePage(archiveStore, query, url.searchParams.get('year') || ''));
          }
          if (thumbnailMatch) {
            const thumbnail = archiveStore.thumbnail(Number(thumbnailMatch[1]));
            if (!thumbnail) return send(404, page('Nicht gefunden', '<section><h1>Vorschau nicht gefunden</h1></section>'));
            res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': thumbnail.size });
            if (req.method === 'HEAD') return res.end();
            createReadStream(thumbnail.path).on('error', () => res.destroy()).pipe(res);
            return;
          }
          if (pdfMatch) {
            const pdf = archiveStore.pdf(Number(pdfMatch[1]));
            if (!pdf) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden</h1></section>'));
            if (cmsStore && req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'archive.pdf', 'archive', pdfMatch[1]);
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.size, 'Content-Disposition': `inline; filename="${pdf.filename}"` });
            if (req.method === 'HEAD') return res.end();
            createReadStream(pdf.path).on('error', () => res.destroy()).pipe(res);
            return;
          }
          if (path === `${base}updates/`) {
            const pageNumber = contentPageNumber(url, 'page');
            if (!pageNumber) return send(400, page('Ungültige Seite', '<section><h1>Ungültige Seite</h1></section>'));
            const [listing, mode] = await Promise.all([cmsStore.listContentPage('updates', pageNumber), cmsStore.subscriptionMode(identity.uuid)]);
            if (pageNumber > 1 && !listing.items.length) return send(404, page('Seite nicht gefunden', '<section><h1>Seite nicht gefunden</h1></section>'));
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'updates');
            return send(200, updatesPage(listing.items, mode, session.csrf, listing, subscriberRecipientAllowed(mailConfig, identity.email), personalMailPaused));
          }
          if (path === `${base}contributions/`) {
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'contributions');
            return send(200, contributionsPage(await cmsStore.listOwnContributions(identity.uuid), session.csrf, !!submissionsAvailable));
          }
          if (updateDetailMatch) {
            const update = await cmsStore.getPublishedUpdate(updateDetailMatch[1]);
            if (!update) return send(404, page('Nicht gefunden', '<section><h1>Beitrag nicht gefunden</h1></section>'));
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'update.view', 'update', update.id);
            return send(200, updateDetailPage(update));
          }
          if (path === `${base}search/`) {
            const query = (url.searchParams.get('q') || '').trim();
            if (query.length < 2 || query.length > 100) return send(200, searchPage(query.slice(0, 100), { updates: [], issues: [] }, []));
            if (archiveStore && !validArchiveQuery(query)) return send(400, page('Suche eingrenzen', '<section><h1>Suche eingrenzen</h1><p>Bitte höchstens sechs Suchwörter eingeben.</p></section>'));
            const [web, archive] = await Promise.all([cmsStore.searchPublished(query), archiveStore ? Promise.resolve(archiveStore.search(query)) : Promise.resolve([])]);
            if (req.method === 'GET') {
              await cmsStore.recordAudit(identity.uuid, 'search.perform', 'search');
              await cmsStore.recordSearch(identity.uuid, query, 'all');
            }
            return send(200, searchPage(query, web, archive));
          }
          if (path === `${base}issues/`) {
            const pageNumber = contentPageNumber(url, 'page');
            if (!pageNumber) return send(400, page('Ungültige Seite', '<section><h1>Ungültige Seite</h1></section>'));
            const listing = await cmsStore.listContentPage('issues', pageNumber);
            if (pageNumber > 1 && !listing.items.length) return send(404, page('Seite nicht gefunden', '<section><h1>Seite nicht gefunden</h1></section>'));
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'issues');
            return send(200, issuesPage(listing.items, listing));
          }
          if (issueMatch) {
            const issue = await cmsStore.getPublishedIssue(issueMatch[1]);
            if (!issue) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden</h1></section>'));
            if (req.method === 'GET' && submissionRoot) for (const attachment of issue.attachments || []) {
              if (attachment.mediaType !== 'application/pdf') continue;
              try { attachment.pageCount = await countPdfPages((await getSubmissionFile(submissionRoot, attachment.storedName)).path); }
              catch { attachment.pageCount = 0; }
            }
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'issue.view', 'issue', issueMatch[1]);
            return send(200, issuePage(issue, identity.editor));
          }
          if (issuePdfMatch) {
            const issue = await cmsStore.getPublishedIssue(issuePdfMatch[1]);
            if (!issue) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden</h1></section>'));
            const pdf = req.method === 'HEAD' ? null : await renderIssuePdf(issue, editorImageRoot, submissionRoot);
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'issue.pdf', 'issue', issuePdfMatch[1]);
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="BBS-Info-${issue.number}.pdf"`, ...(pdf ? { 'Content-Length': pdf.length } : {}) });
            return res.end(pdf);
          }
          if (path === `${base}editor/`) {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor');
            const draftPage = contentPageNumber(url, 'draftPage');
            const publishedPage = contentPageNumber(url, 'publishedPage');
            if (!draftPage || !publishedPage) return send(400, page('Ungültige Seite', '<section><h1>Ungültige Seite</h1></section>'));
            const [drafts, published, submissions, templates, contributions] = await Promise.all([cmsStore.listContentPage('updateDrafts', draftPage), cmsStore.listContentPage('updates', publishedPage), submissionsAvailable ? cmsStore.listTakenOverSubmissions() : Promise.resolve([]), cmsStore.listTemplates(true), cmsStore.listSubmittedContributions()]);
            if ((draftPage > 1 && !drafts.items.length) || (publishedPage > 1 && !published.items.length)) return send(404, page('Seite nicht gefunden', '<section><h1>Seite nicht gefunden</h1></section>'));
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'editor');
            return send(200, editorPage(drafts.items, published.items, submissions, templates, session.csrf, { drafts, published }, contributions));
          }
          if (path === `${base}editor/templates/`) {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor.templates');
            const [appSettings, templates] = await Promise.all([cmsStore.getAppSettings(), cmsStore.listTemplates()]);
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'editor.templates');
            return send(200, settingsPage(appSettings, session.csrf, 'templates', templates, identity.auditOwner));
          }
          if (path === `${base}editor/settings/`) {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor');
            const tab = url.searchParams.get('tab') || 'issues';
            if (!['issues', 'updates', 'templates', 'editors'].includes(tab)) return send(400, page('Ungültige Ansicht', '<section><h1>Ungültige Ansicht</h1></section>'));
            if (tab === 'editors' && !identity.auditOwner) return denyProtectedAccess(identity, 'editor');
            const [appSettings, templates, editorGrants] = await Promise.all([cmsStore.getAppSettings(), tab === 'templates' ? cmsStore.listTemplates() : Promise.resolve([]), tab === 'editors' ? cmsStore.listEditorGrants() : Promise.resolve([])]);
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'editor.settings');
            return send(200, settingsPage(appSettings, session.csrf, tab, templates, identity.auditOwner, editorGrants));
          }
          if (path === `${base}editor/digest/`) {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor');
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'digest.preview', 'digest');
            return send(200, digestTestPage(await cmsStore.listDigestTestUpdates(), mailConfig, session.csrf, url.searchParams.get('testSent') === '1'));
          }
          if (path === `${base}editor/issue-sources`) {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor.issues');
            const kind = url.searchParams.get('kind');
            const used = url.searchParams.get('used');
            const pageNumber = contentPageNumber(url, 'page');
            const query = url.searchParams.get('q') || '';
            const keys = [...url.searchParams.keys()];
            if (!['updates', 'contributions', 'submissions'].includes(kind) || !['0', '1'].includes(used) || !pageNumber || query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query) || keys.some((key) => !['kind', 'used', 'page', 'q'].includes(key) || url.searchParams.getAll(key).length !== 1)) return send(400, page('Ungültige Auswahl', '<section><h1>Ungültige Auswahl</h1></section>'));
            const sources = await issueSourcePage(kind, query.trim(), used === '1', pageNumber);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(req.method === 'HEAD' ? '' : JSON.stringify(sources));
          }
          if (path === `${base}editor/issues/`) {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor.issues');
            const draftPage = contentPageNumber(url, 'draftPage');
            const publishedPage = contentPageNumber(url, 'publishedPage');
            if (!draftPage || !publishedPage) return send(400, page('Ungültige Seite', '<section><h1>Ungültige Seite</h1></section>'));
            const [drafts, updates, publishedIssues, submissions, templates, contributions] = await Promise.all([cmsStore.listContentPage('issueDrafts', draftPage), issueSourceGroups('updates'), cmsStore.listContentPage('issues', publishedPage), issueSourceGroups('submissions'), cmsStore.listTemplates(true), issueSourceGroups('contributions')]);
            if ((draftPage > 1 && !drafts.items.length) || (publishedPage > 1 && !publishedIssues.items.length)) return send(404, page('Seite nicht gefunden', '<section><h1>Seite nicht gefunden</h1></section>'));
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'editor.issues');
            return send(200, issueEditorPage(drafts.items, updates, publishedIssues.items, submissions, templates, session.csrf, currentSchoolYear(now()), { drafts, published: publishedIssues }, contributions, url.searchParams.get('mailTest')));
          }
          if (issueEditMatch && req.method !== 'POST') {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor.issues');
            const issue = await cmsStore.getPublishedIssue(issueEditMatch[1]);
            if (!issue) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden</h1></section>'));
            const [updates, submissions, templates, mailStatus, contributions] = await Promise.all([issueSourceGroups('updates'), issueSourceGroups('submissions'), cmsStore.listTemplates(true), cmsStore.issueMailStatus(issue.number), issueSourceGroups('contributions')]);
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'editor.issues');
            return send(200, issueEditPage(issue, updates, submissions, templates, session.csrf, mailStatus, contributions));
          }
          if (issueMailMatch && req.method !== 'POST') {
            if (!identity.editor) return denyProtectedAccess(identity, 'editor.issues');
            const issue = await cmsStore.getPublishedIssue(issueMailMatch[1]);
            if (!issue) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden</h1></section>'));
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'issue.mail_preview', 'issue', issueMailMatch[1]);
            const [appSettings, deliveryStatus] = await Promise.all([cmsStore.getAppSettings(), cmsStore.issueMailStatus(issue.number)]);
            return send(200, issueMailPage(issue, mailConfig, session.csrf, appSettings, url.searchParams.get('testSent') === '1', deliveryStatus));
          }
          if (path === `${base}submissions/`) {
            const [own, all] = await Promise.all([cmsStore.listOwnSubmissions(identity.uuid), identity.editor ? cmsStore.listAllSubmissions() : Promise.resolve([])]);
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'submissions');
            return send(200, submissionsPage(own, all, session.csrf, identity.editor, !!cmsStore));
          }
          if (submissionFileMatch || mediaMatch || mediaInlineMatch || mediaPageMatch) {
            const ownFile = !!submissionFileMatch;
            const submission = await cmsStore.getSubmission((submissionFileMatch || mediaMatch || mediaInlineMatch || mediaPageMatch)[1]);
            if (!submission) return send(404, page('Nicht gefunden', '<section><h1>Datei nicht gefunden</h1></section>'));
            if (ownFile && submission.ownerUuid !== identity.uuid && !identity.editor) return denyProtectedAccess(identity, 'submissions');
            if (!ownFile && !(await cmsStore.isPublishedSubmission(submission.id))) return send(404, page('Nicht gefunden', '<section><h1>Datei nicht gefunden</h1></section>'));
            const file = await getSubmissionFile(submissionRoot, submission.storedName);
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, ownFile ? 'submission.file' : 'submission.published_file', 'submission', submission.id);
            if (mediaPageMatch) {
              if (submission.mediaType !== 'application/pdf') return send(404, page('Nicht gefunden', '<section><h1>Seite nicht gefunden</h1></section>'));
              const pageNumber = Number(mediaPageMatch[2]);
              if (pageNumber > await countPdfPages(file.path)) return send(404, page('Nicht gefunden', '<section><h1>Seite nicht gefunden</h1></section>'));
              const image = req.method === 'HEAD' ? null : await renderPdfPage(file.path, pageNumber);
              res.writeHead(200, { 'Content-Type': 'image/webp', ...(image ? { 'Content-Length': image.length } : {}) });
              return res.end(image);
            }
            if (mediaInlineMatch && !submission.mediaType.startsWith('image/')) return send(404, page('Nicht gefunden', '<section><h1>Bild nicht gefunden</h1></section>'));
            const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[submission.mediaType];
            res.writeHead(200, { 'Content-Type': submission.mediaType, 'Content-Length': file.size, 'Content-Disposition': `${mediaInlineMatch ? 'inline' : 'attachment'}; filename="Steckbrief-${submission.id}.${extension}"` });
            if (req.method === 'HEAD') return res.end();
            createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
            return;
          }
          if (editorImageMatch) {
            const image = await cmsStore.getEditorImage(editorImageMatch[1]);
            if (!image || (!identity.editor && image.uploadedBy !== identity.uuid && !(await cmsStore.isEditorImagePublished(image.storedName)))) return send(404, page('Nicht gefunden', '<section><h1>Bild nicht gefunden</h1></section>'));
            const file = await getSubmissionFile(editorImageRoot, image.storedName);
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'image.view', 'image', image.id);
            const variantWidth = url.searchParams.get('w');
            if (variantWidth !== null) {
              if (!/^(100|200|400|600|800|1000|1200|1600)$/.test(variantWidth)) return send(400, page('Ungültige Bildgröße', '<section><h1>Ungültige Bildgröße</h1></section>'));
              const key = `${image.storedName}:${variantWidth}`;
              let resized = imageVariants.get(key);
              if (!resized && req.method !== 'HEAD') {
                resized = await renderEditorImageVariant(file.path, Number(variantWidth));
                imageVariants.set(key, resized);
                if (imageVariants.size > 32) imageVariants.delete(imageVariants.keys().next().value);
              }
              res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Disposition': 'inline', ...(resized ? { 'Content-Length': resized.length } : {}) });
              return res.end(req.method === 'HEAD' ? null : resized);
            }
            res.writeHead(200, { 'Content-Type': image.mediaType, 'Content-Length': file.size, 'Content-Disposition': 'inline' });
            if (req.method === 'HEAD') return res.end();
            createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
            return;
          }
          if (path === `${base}audit/`) {
            if (!identity.auditOwner) return denyProtectedAccess(identity, 'audit');
            const pageNumber = Number(url.searchParams.get('page') || '1');
            if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 2000) return send(400, page('Ungültige Seite', '<section><h1>Ungültige Seite</h1></section>'));
            const through = url.searchParams.get('through');
            if (through !== null && !/^[1-9][0-9]{0,19}$/.test(through)) return send(400, page('Ungültige Seite', '<section><h1>Ungültige Seite</h1></section>'));
            let filters;
            try { filters = auditFiltersFromUrl(url); } catch { return send(400, page('Ungültiger Filter', '<section><h1>Ungültiger Filter</h1></section>')); }
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'audit');
            const listing = await cmsStore.listAuditPage(pageNumber, filters, through);
            if (pageNumber > listing.pageCount) return send(404, page('Seite nicht gefunden', '<section><h1>Seite nicht gefunden</h1></section>'));
            return send(200, auditPage(listing, filters, await readAuditHealth()));
          }
          if (path === `${base}audit/export.csv`) {
            if (!identity.auditOwner) return denyProtectedAccess(identity, 'audit');
            const before = url.searchParams.get('before');
            if (before !== null && !/^[1-9][0-9]{0,19}$/.test(before)) return send(400, page('Ungültiger Export', '<section><h1>Ungültiger Export</h1></section>'));
            let filters;
            try { filters = auditFiltersFromUrl(url); } catch { return send(400, page('Ungültiger Export', '<section><h1>Ungültiger Filter</h1></section>')); }
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'audit.export', 'audit');
            const rows = await cmsStore.listAudit(before, 1000, filters);
            const csv = auditCsv(rows);
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bbsinfo-audit.csv"' });
            return res.end(req.method === 'HEAD' ? '' : csv);
          }
          if (path === `${base}stats/`) {
            if (!identity.auditOwner) return denyProtectedAccess(identity, 'stats');
            const days = Number(url.searchParams.get('days') || 30);
            if (![7, 30, 90].includes(days)) return send(400, page('Ungültiger Zeitraum', '<section><h1>Ungültiger Zeitraum</h1></section>'));
            const pageNumber = Number(url.searchParams.get('page') || '1');
            if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 7) return send(400, page('Ungültige Seite', '<section><h1>Ungültige Seite</h1></section>'));
            if (req.method === 'GET') await cmsStore.recordAudit(identity.uuid, 'page.view', 'page', 'stats');
            const report = await cmsStore.listUsageStats(days);
            if (pageNumber > Math.max(1, Math.ceil(new Set(report.daily.map((row) => row.day)).size / 14))) return send(404, page('Seite nicht gefunden', '<section><h1>Statistikseite nicht gefunden</h1></section>'));
            return send(200, statsPage(report, pageNumber, await readAuditHealth()));
          }
          if (cmsPost) {
            if (![`${base}subscribe`, `${base}contributions/save`, `${base}contributions/delete`, `${base}editor/images/upload`, `${base}submissions/upload`, `${base}submissions/replace`, `${base}submissions/delete`].includes(path) && !identity.editor) return denyProtectedAccess(identity, path.startsWith(`${base}editor/issues/`) ? 'editor.issues' : 'editor');
            if (path === `${base}editor/images/upload`) {
              if (req.headers.origin !== origin) return send(403, page('Zugriff verweigert', '<section><h1>Zugriff verweigert</h1></section>'));
              let upload;
              try { upload = await parseSubmission(req); } catch { return send(400, page('Ungültiges Bild', '<section><h1>Bitte ein Bild bis 3 MB wählen.</h1></section>')); }
              if (!sameToken(upload.csrf, session.csrf)) return send(403, page('Zugriff verweigert', '<section><h1>Zugriff verweigert</h1></section>'));
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(upload.mediaType) || upload.data.length > 3 * 1024 * 1024) return send(400, page('Ungültiges Bild', '<section><h1>Bitte JPEG, PNG oder WebP bis 3 MB wählen.</h1></section>'));
              let optimized;
              try { optimized = await optimizeEditorUpload(upload.data); }
              catch { return send(400, page('Ungültiges Bild', '<section><h1>Das Bild konnte nicht verarbeitet werden.</h1></section>')); }
              const data = optimized.length < upload.data.length ? optimized : upload.data;
              const mediaType = data === optimized ? 'image/webp' : upload.mediaType;
              const storedName = await saveSubmissionFile(editorImageRoot, data);
              try { await cmsStore.createEditorImage(identity.uuid, storedName, mediaType, data.length); }
              catch (error) { await removeSubmissionFile(editorImageRoot, storedName); throw error; }
              res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(JSON.stringify({ url: `${base}editor-images/${storedName}` }));
            }
            if (path === `${base}submissions/upload` || path === `${base}submissions/replace`) {
              if (req.headers.origin !== origin) return send(403, page('Zugriff verweigert', '<section><h1>Zugriff verweigert</h1></section>'));
              let upload;
              try { upload = await parseSubmission(req); } catch { return send(400, page('Ungültige Einreichung', '<section><h1>Bitte eine PDF- oder Bilddatei bis 10 MB wählen.</h1></section>')); }
              if (!sameToken(upload.csrf, session.csrf)) return send(403, page('Zugriff verweigert', '<section><h1>Zugriff verweigert</h1></section>'));
              const replacing = path === `${base}submissions/replace`;
              if ((!replacing && upload.id !== null) || (replacing && !/^[1-9][0-9]{0,9}$/.test(upload.id || ''))) return send(400, page('Ungültige Einreichung', '<section><h1>Ungültige Einreichung</h1></section>'));
              const storedName = await saveSubmissionFile(submissionRoot, upload.data);
              let oldName;
              try {
                if (replacing) oldName = await cmsStore.replaceSubmission(identity.uuid, upload.id, upload.title, upload.note, storedName, upload.mediaType, upload.data.length);
                else await cmsStore.createSubmission(identity.uuid, upload.title, upload.note, storedName, upload.mediaType, upload.data.length);
              }
              catch (error) { await removeSubmissionFile(submissionRoot, storedName); throw error; }
              if (replacing && !oldName) {
                await removeSubmissionFile(submissionRoot, storedName);
                return send(404, page('Nicht gefunden', '<section><h1>Einreichung nicht gefunden oder bereits übernommen</h1></section>'));
              }
              if (oldName) try { await removeSubmissionFile(submissionRoot, oldName); } catch { process.stderr.write('BBS Info: Alte Einreichungsdatei konnte nicht entfernt werden.\n'); }
              return redirect(`${base}submissions/`, replacing ? 'Steckbrief aktualisiert.' : 'Steckbrief eingereicht.');
            }
            let form;
            try { form = await readForm(req, [ `${base}contributions/save`, `${base}editor/issues/create-publish`, `${base}editor/drafts`, `${base}editor/update`, `${base}editor/templates/save` ].includes(path) || issueEditMatch ? 200000 : 24000); } catch { return send(400, page('Ungültiges Formular', '<section><h1>Ungültiges Formular</h1></section>')); }
            if (!sameToken(form.get('csrf'), session.csrf)) return send(403, page('Zugriff verweigert', '<section><h1>Zugriff verweigert</h1></section>'));
            if (path === `${base}editor/settings/editors/add` || path === `${base}editor/settings/editors/remove`) {
              if (!identity.auditOwner) return denyProtectedAccess(identity, 'editor');
              try {
                if (path.endsWith('/add')) await cmsStore.addEditorGrant(identity.uuid, form.get('email'));
                else {
                  if (form.get('confirm') !== form.get('email')) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte das Entfernen bestätigen.</h1></section>'));
                  if (!(await cmsStore.removeEditorGrant(identity.uuid, form.get('email')))) return send(404, page('Nicht gefunden', '<section><h1>Redaktionskonto nicht gefunden.</h1></section>'));
                }
              } catch (error) {
                if (/IServ-E-Mail-Adresse|Redaktionskonten|IServ-Adresse ist nicht eindeutig/.test(error.message)) return send(400, page('Ungültige Adresse', '<section><h1>Bitte eine eindeutige IServ-Adresse der BBS Einbeck eingeben.</h1></section>'));
                throw error;
              }
              return redirect(`${base}editor/settings/?tab=editors`, path.endsWith('/add') ? 'Redaktionsrecht eingetragen.' : 'Redaktionsrecht entfernt.');
            }
            if (path === `${base}submissions/take-over`) {
              if (!/^[1-9][0-9]{0,9}$/.test(form.get('id') || '')) return send(400, page('Ungültige Einreichung', '<section><h1>Ungültige Einreichung</h1></section>'));
              const taken = await cmsStore.takeOverSubmission(identity.uuid, form.get('id'));
              if (!taken) return send(404, page('Nicht gefunden', '<section><h1>Einreichung nicht gefunden</h1></section>'));
              return redirect(`${base}submissions/`, 'Steckbrief redaktionell übernommen.');
            }
            if (path === `${base}submissions/delete`) {
              const id = form.get('id');
              if (!/^[1-9][0-9]{0,9}$/.test(id || '') || form.get('confirm') !== id) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte das Löschen bestätigen.</h1></section>'));
              const storedName = await cmsStore.deleteSubmission(identity.uuid, id);
              if (!storedName) return send(409, page('Nicht mehr löschbar', '<section><h1>Dieser Steckbrief wurde bereits übernommen oder gehört nicht zu deinem Konto.</h1></section>'));
              try { await removeSubmissionFile(submissionRoot, storedName); }
              catch { process.stderr.write('BBS Info: Gelöschte Einreichungsdatei konnte nicht entfernt werden.\n'); }
              return redirect(`${base}submissions/`, 'Steckbrief gelöscht.');
            }
            if (path === `${base}subscribe`) {
              const mode = form.get('mode');
              if (!['off', 'instant', 'daily', 'weekly'].includes(mode)) return send(400, page('Ungültiges Abo', '<section><h1>Ungültiges Abo</h1></section>'));
              if (mode !== 'off' && !identity.email) return send(400, page('E-Mail fehlt', '<section><h1>IServ hat keine bestätigte Schul-E-Mail-Adresse übermittelt.</h1></section>'));
              await cmsStore.setSubscription(identity.uuid, mode);
              const available = subscriberRecipientAllowed(mailConfig, identity.email);
              const notice = mode === 'off' ? 'Update-Mails ausgeschaltet.' : personalMailPaused ? 'Auswahl gespeichert. Persönliche Update-Mails sind derzeit pausiert, weil die IServ-Gruppenprüfung nicht verfügbar ist.' : available ? ({ instant: 'Sofortige Update-Mails eingeschaltet.', daily: 'Tägliche Update-Mails eingeschaltet.', weekly: 'Wöchentliche Update-Mails eingeschaltet.' })[mode] : 'Auswahl gespeichert. Der Versand an dieses Konto ist im Testbetrieb noch gesperrt.';
              return redirect(`${base}updates/`, notice);
            }
            if (path === `${base}contributions/save`) {
              const id = form.get('id');
              if (id !== null && !/^[1-9][0-9]{0,9}$/.test(id)) return send(400, page('Ungültiger Beitrag', '<section><h1>Ungültiger Beitrag</h1></section>'));
              let saved;
              try { const body = submittedBody(form, 20000); saved = await cmsStore.saveContribution(identity.uuid, id, form.get('title'), body.plain, body.html); }
              catch (error) { if (/außerhalb|fehlen|Formatierter Text|Text fehlt|stimmt nicht/.test(error.message)) return send(400, page('Ungültiger Beitrag', '<section><h1>Bitte Titel und Text prüfen.</h1></section>')); throw error; }
              if (!saved) return send(409, page('Nicht mehr änderbar', '<section><h1>Dieser Beitrag wurde bereits übernommen.</h1></section>'));
              return redirect(`${base}contributions/`, id ? 'Beitrag geändert.' : 'Beitrag eingereicht.');
            }
            if (path === `${base}contributions/delete`) {
              const id = form.get('id');
              if (!/^[1-9][0-9]{0,9}$/.test(id || '') || form.get('confirm') !== id) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte das Löschen bestätigen.</h1></section>'));
              if (!(await cmsStore.deleteContribution(identity.uuid, id))) return send(409, page('Nicht mehr löschbar', '<section><h1>Dieser Beitrag wurde bereits übernommen.</h1></section>'));
              return redirect(`${base}contributions/`, 'Beitrag gelöscht.');
            }
            if (issueMailMatch) {
              if (!colleagueDeliveryEnabled(mailConfig)) return send(403, page('Versand gesperrt', '<section><h1>Der Versand an das Kollegium ist im Testmodus gesperrt.</h1></section>'));
              if (form.get('confirm') !== issueMailMatch[1]) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte den Kollegiumsversand ausdrücklich bestätigen.</h1></section>'));
              const issue = await cmsStore.getPublishedIssue(issueMailMatch[1]);
              if (!issue) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden.</h1></section>'));
              if (!(await cmsStore.startIssueMail(identity.uuid, issue.number))) return send(409, page('Bereits versendet', '<section><h1>Für diese Ausgabe wurde der Mailversand bereits gestartet.</h1></section>'));
              try {
                await sendLiveIssue(mailConfig, issue, await cmsStore.getAppSettings());
                await cmsStore.finishIssueMail(identity.uuid, issue.number, true);
              } catch {
                await cmsStore.finishIssueMail(identity.uuid, issue.number, false);
                return send(503, page('Mailstatus unklar', '<section><h1>Der Versandstatus ist unklar. Bitte vor einem weiteren Versuch prüfen.</h1></section>'));
              }
              try { await cmsStore.markIssueUpdatesMailed(issue.number); }
              catch { process.stderr.write('BBS Info: Ausgaben-Mail versendet, Update-Abgleich fehlgeschlagen.\n'); }
              return redirect(`${base}editor/issues/${issue.number}/mail`, 'Ausgaben-Mail versendet.');
            }
            if (issueMailTestMatch) {
              if (form.get('confirm') !== issueMailTestMatch[1]) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte die Testmail ausdrücklich bestätigen.</h1></section>'));
              if (!mailConfig?.password || mailConfig?.testRecipient !== TEST_RECIPIENT) return send(503, page('Mail nicht eingerichtet', '<section><h1>Der Testmailversand ist noch nicht eingerichtet.</h1></section>'));
              const issue = await cmsStore.getPublishedIssue(issueMailTestMatch[1]);
              if (!issue) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden</h1></section>'));
              const appSettings = await cmsStore.getAppSettings();
              const status = await auditedTestMail(identity.uuid, 'issue.mail_test_start', 'issue.mail_test', 'issue', issue.number, () => sendIssue(mailConfig, issue, appSettings));
              if (status !== 'sent') return send(503, testMailError(status));
              return redirect(`${base}editor/issues/${issue.number}/mail?testSent=1`, 'Testmail an Marc versendet.');
            }
            if (path === `${base}editor/digest/send-test`) {
              if (form.get('confirm') !== 'yes') return send(400, page('Bestätigung fehlt', '<section><h1>Bitte die Testmail ausdrücklich bestätigen.</h1></section>'));
              if (!mailConfig?.password || mailConfig.testRecipient !== TEST_RECIPIENT) return send(503, page('Mail nicht eingerichtet', '<section><h1>Der Testmailversand ist noch nicht eingerichtet.</h1></section>'));
              const updates = await cmsStore.listDigestTestUpdates();
              if (!updates.length) return send(409, page('Keine Updates', '<section><h1>Es sind keine Updates für einen Test vorhanden.</h1></section>'));
              const status = await auditedTestMail(identity.uuid, 'digest.test_start', 'digest.test_sent', 'digest', null, () => sendDigest(mailConfig, updates));
              if (status !== 'sent') return send(503, testMailError(status));
              return redirect(`${base}editor/digest/?testSent=1`, 'Sammelmail-Test an Marc versendet.');
            }
            if (path === `${base}editor/templates/save`) {
              const rawId = form.get('id');
              if (rawId !== null && !/^[1-9][0-9]{0,9}$/.test(rawId)) return send(400, page('Ungültiger Baustein', '<section><h1>Ungültiger Baustein</h1></section>'));
              try {
                const saved = await cmsStore.saveTemplate(identity.uuid, rawId, form.get('name'), form.get('bodyHtml'), form.get('enabled') === '1');
                if (saved === null) return send(404, page('Nicht gefunden', '<section><h1>Baustein nicht gefunden</h1></section>'));
              } catch (error) {
                if (/Baustein|Formatierter Text|Text fehlt|Zu viele/.test(error.message)) return send(400, page('Ungültiger Baustein', '<section><h1>Bitte Name und Textvorlage prüfen.</h1></section>'));
                throw error;
              }
              return redirect(`${base}editor/settings/?tab=templates`, 'Textbaustein gespeichert.');
            }
            if (path === `${base}editor/settings/save`) {
              const tab = form.get('settingsTab');
              if (!['issues', 'updates'].includes(tab)) return send(400, page('Ungültige Einstellungen', '<section><h1>Ungültiger Einstellungsbereich.</h1></section>'));
              const current = await cmsStore.getAppSettings();
              const values = tab === 'issues'
                ? { ...current, mailSubject: form.get('mailSubject'), mailBody: form.get('mailBody') }
                : { ...current, digestCadence: form.get('digestCadence') };
              try { await cmsStore.saveAppSettings(identity.uuid, values); }
              catch (error) { if (/Einstellungen|Platzhalter/.test(error.message)) return send(400, page('Ungültige Einstellungen', '<section><h1>Bitte Mailvorlage und Versandrhythmus prüfen.</h1></section>')); throw error; }
              return redirect(`${base}editor/settings/?tab=${tab}`, 'Einstellungen gespeichert.');
            }
            if (path === `${base}editor/drafts`) {
              try { const body = submittedBody(form, 20000); await cmsStore.createDraft(identity.uuid, form.get('title'), body.plain, form.getAll('submissionId'), body.html); }
              catch (error) { if (/außerhalb|fehlen|Steckbrief|Update-ID|Formatierter Text|Text fehlt|stimmt nicht/.test(error.message)) return send(400, page('Ungültiger Entwurf', '<section><h1>Bitte Titel, Text und ausgewählte Steckbriefe prüfen.</h1></section>')); throw error; }
              return redirect(`${base}editor/`, 'Entwurf gespeichert.');
            }
            if (path === `${base}editor/update`) {
              if (!/^[1-9][0-9]{0,9}$/.test(form.get('id') || '')) return send(400, page('Ungültiges Update', '<section><h1>Ungültiges Update</h1></section>'));
              let edited;
              try { const body = submittedBody(form, 20000); edited = await cmsStore.editUpdate(identity.uuid, form.get('id'), form.get('title'), body.plain, form.get('mode'), body.html); }
              catch (error) { if (/außerhalb|fehlen|Ungültige Änderung|Formatierter Text|Text fehlt|stimmt nicht/.test(error.message)) return send(400, page('Ungültige Änderung', '<section><h1>Bitte Titel und Text prüfen.</h1></section>')); throw error; }
              if (!edited) return send(404, page('Update nicht gefunden', '<section><h1>Update nicht gefunden oder Status geändert</h1></section>'));
              return redirect(`${base}editor/`, 'Beitrag geändert.');
            }
            if (path === `${base}editor/issues/create-publish`) {
              let number;
              try { const body = submittedBody(form, 40000, true); number = await cmsStore.createAndPublishIssue(identity.uuid, form.get('title'), body.plain, currentSchoolYear(now()), form.get('period') || '', form.getAll('updateId'), body.html, form.getAll('submissionId'), form.getAll('contributionId')); }
              catch (error) { if (/Ungültige Ausgabendaten|Zu viele Updates|Zu viele Steckbriefe|Zu viele Kollegenbeiträge|Ausgabe ohne Inhalt|Doppelte Auswahl|Ein gewähltes|Ungültige Update-ID|Formatierter Text|Text fehlt|stimmt nicht/.test(error.message)) return send(400, page('Ungültige Ausgabe', '<section><h1>Bitte Ausgabendaten und ausgewählte Beiträge prüfen.</h1></section>')); throw error; }
              const mailTest = await pilotIssueMail(number, identity.uuid);
              return redirect(`${(await cmsStore.hasIssueDrafts()) ? `${base}editor/issues/` : base}?mailTest=${mailTest}`, 'Ausgabe veröffentlicht.');
            }
            if (issueEditMatch) {
              let edited;
              try { const body = submittedBody(form, 40000, true); edited = await cmsStore.editPublishedIssue(identity.uuid, issueEditMatch[1], form.get('title'), body.plain, form.get('period') || '', form.getAll('updateId'), form.getAll('submissionId'), form.getAll('keepSnapshotId'), body.html, form.getAll('contributionId')); }
              catch (error) { if (/Ungültige Ausgabendaten|Zu viele Updates|Zu viele Steckbriefe|Zu viele Kollegenbeiträge|Ausgabe ohne Inhalt|Doppelte Auswahl|doppelte Auswahl|gespeicherte Beiträge|Ein gewähltes|Ungültige Update-ID|Formatierter Text|Text fehlt|stimmt nicht/.test(error.message)) return send(400, page('Ungültige Änderung', '<section><h1>Bitte Ausgabendaten und ausgewählte Beiträge prüfen.</h1></section>')); throw error; }
              if (!edited) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden.</h1></section>'));
              return redirect(`${base}editor/issues/${issueEditMatch[1]}/edit`, 'Ausgabe geändert.');
            }
            if (path === `${base}editor/issues/delete`) {
              if (!/^[1-9][0-9]{0,9}$/.test(form.get('number') || '') || form.get('confirm') !== form.get('number')) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte das Löschen bestätigen.</h1></section>'));
              let deleted;
              try { deleted = await cmsStore.deleteIssue(identity.uuid, form.get('number')); }
              catch (error) { if (/begonnenem Mailversand/.test(error.message)) return send(409, page('Löschen nicht möglich', '<section><h1>Für diese Ausgabe wurde der Mailversand bereits begonnen. Ihre Nummer darf nicht erneut vergeben werden.</h1></section>')); throw error; }
              if (!deleted) return send(404, page('Nicht gefunden', '<section><h1>Ausgabe nicht gefunden.</h1></section>'));
              return redirect(`${base}editor/issues/`, 'Ausgabe gelöscht.');
            }
            if (!/^[1-9][0-9]{0,9}$/.test(form.get('id') || '')) return send(400, page('Ungültiger Entwurf', '<section><h1>Ungültiger Entwurf</h1></section>'));
            if (path === `${base}editor/delete-update`) {
              if (form.get('confirm') !== form.get('id')) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte das Löschen bestätigen.</h1></section>'));
              if (!(await cmsStore.deleteUpdate(identity.uuid, form.get('id')))) return send(404, page('Nicht gefunden', '<section><h1>Beitrag nicht gefunden.</h1></section>'));
              return redirect(`${base}editor/`, 'Beitrag gelöscht.');
            }
            if (path === `${base}editor/issues/delete-draft`) {
              if (form.get('confirm') !== form.get('id')) return send(400, page('Bestätigung fehlt', '<section><h1>Bitte das Löschen bestätigen.</h1></section>'));
              if (!(await cmsStore.deleteIssueDraft(identity.uuid, form.get('id')))) return send(404, page('Nicht gefunden', '<section><h1>Entwurf nicht gefunden.</h1></section>'));
              return redirect(`${base}editor/issues/`, 'Ausgabenentwurf gelöscht.');
            }
            if (path === `${base}editor/issues/publish`) {
              const number = await cmsStore.publishIssue(identity.uuid, form.get('id'));
              if (!number) return send(404, page('Entwurf nicht gefunden', '<section><h1>Entwurf nicht gefunden</h1></section>'));
              const mailTest = await pilotIssueMail(number, identity.uuid);
              return redirect(`${(await cmsStore.hasIssueDrafts()) ? `${base}editor/issues/` : base}?mailTest=${mailTest}`, 'Ausgabe veröffentlicht.');
            }
            const published = await cmsStore.publishUpdate(identity.uuid, form.get('id'));
            if (!published) return send(404, page('Entwurf nicht gefunden', '<section><h1>Entwurf nicht gefunden</h1></section>'));
            setImmediate(() => { void runNotifications(); });
            return redirect((await cmsStore.hasUpdateDrafts()) ? `${base}editor/` : base, 'Beitrag veröffentlicht.');
          }
        } catch {
          return send(503, page('Vorübergehend nicht verfügbar', '<section><h1>BBS Info ist gerade nicht verfügbar.</h1></section>'));
        }
      }
      return send(404, landing('Seite nicht gefunden.'));
    } catch {
      if (!res.headersSent) return send(503, landing('Anmeldung gerade nicht möglich.'));
      res.end();
    }
  });
  app.requestTimeout = 10000;
  app.headersTimeout = 10000;
  app.keepAliveTimeout = 3000;
  app.maxConnections = 100;
  app.maxHeadersCount = 30;
  app.on('close', () => {
    clearInterval(timer);
    clearInterval(notificationTimer);
    clearInterval(retentionTimer);
    for (const waiter of authWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('Dienst beendet.')); }
    archiveStore?.close?.();
    const closeError = () => process.stderr.write('BBS Info: Datenbankverbindung konnte beim Beenden nicht geschlossen werden.\n');
    try { void Promise.resolve(cmsStore?.close?.()).catch(closeError); }
    catch { closeError(); }
  });
  return app;
}

export function readSettings(path) {
  const mode = statSync(path).mode & 0o777;
  const systemdCredential = process.env.CREDENTIALS_DIRECTORY && path === `${process.env.CREDENTIALS_DIRECTORY}/config` && path.startsWith('/run/credentials/');
  if (mode & (systemdCredential ? 0o007 : 0o077)) throw new Error('Konfigurationsdatei muss privat sein.');
  return validateSettings(JSON.parse(readFileSync(path, 'utf8')));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stage = 'Konfiguration';
  try {
    const config = readSettings(process.env.BBSINFO_CONFIG || `${process.env.CREDENTIALS_DIRECTORY || '.'}/config`);
    let cached;
    let retryAfter = 0;
    const getProvider = () => {
      if (Date.now() < retryAfter) throw new Error('IServ nicht verfügbar.');
      if (!cached) cached = provider(config.clientId, config.clientSecret).catch(() => { cached = undefined; retryAfter = Date.now() + 30000; throw new Error('IServ nicht verfügbar.'); });
      return cached;
    };
    stage = 'Archiv';
    const archiveStore = process.env.BBSINFO_ARCHIVE_ROOT ? openArchiveStore(process.env.BBSINFO_ARCHIVE_ROOT) : null;
    stage = 'MariaDB';
    const auditGapMarker = config.database ? createAuditGapMarker() : null;
    const cmsStore = config.database ? openCmsStore(config.database, { auditGapMarker }) : null;
    if (cmsStore) await cmsStore.ready();
    stage = 'Einreichungen';
    const submissionRoot = process.env.BBSINFO_SUBMISSION_ROOT || null;
    if (submissionRoot) validateSubmissionRoot(submissionRoot);
    const editorImageRoot = process.env.BBSINFO_EDITOR_IMAGE_ROOT || null;
    if (editorImageRoot) validateSubmissionRoot(editorImageRoot);
    stage = 'Mailkonfiguration';
    const mailConfig = process.env.BBSINFO_MAIL_CONFIG ? readMailConfig(process.env.BBSINFO_MAIL_CONFIG) : null;
    let verifySubscriberGroup = null;
    let idmSetupError = false;
    const idmCredentialPath = process.env.CREDENTIALS_DIRECTORY && `${process.env.CREDENTIALS_DIRECTORY}/idm-credentials`;
    if (idmCredentialPath && existsSync(idmCredentialPath)) {
      try { verifySubscriberGroup = createIdmGroupVerifier(readIdmCredentials(idmCredentialPath), config.readerGroupName); }
      catch { idmSetupError = true; }
    }
    if (subscriberDeliveryEnabled(mailConfig) && !verifySubscriberGroup) process.stderr.write(`BBS Info: Persönliche Update-Mails pausiert; ${idmSetupError ? 'IDM-Dienstzugang ungültig' : 'IDM-Prüfung nicht eingerichtet'}.\n`);
    const app = createApp({ settings: config, getProvider, archiveStore, cmsStore, auditGapMarker, submissionRoot, editorImageRoot, mailConfig, verifySubscriberGroup });
    if (auditGapMarker) {
      const checkCapacity = async () => {
        try {
          const result = await checkAuditCapacity(auditGapMarker);
          if (result === 'unknown' || result === 'marker_failed') process.stderr.write('BBS Info: Audit-Speicherprüfung nicht verfügbar.\n');
        } catch { process.stderr.write('BBS Info: Audit-Speicherprüfung nicht verfügbar.\n'); }
      };
      await checkCapacity();
      const capacityTimer = setInterval(() => { void checkCapacity(); }, 60 * 60 * 1000);
      capacityTimer.unref();
      app.on('close', () => clearInterval(capacityTimer));
    }
    if (process.env.BBSINFO_SOCKET) app.listen(process.env.BBSINFO_SOCKET, () => chmodSync(process.env.BBSINFO_SOCKET, 0o660));
    else app.listen(Number(process.env.PORT || 3188), '127.0.0.1');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,50}$/.test(error.code) ? error.code : error?.name === 'Error' ? 'ERROR' : 'UNBEKANNT';
    process.stderr.write(`BBS Info konnte nicht gestartet werden (${stage}, ${code}).\n`);
    process.exitCode = 1;
  }
}
