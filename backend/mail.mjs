import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sanitizeHtml from 'sanitize-html';
import { defaultAppSettings, renderMailTemplate, validateAppSettings } from './app-settings.mjs';
import { plainFromHtml } from './rich-text.mjs';
import { htmlEscape as escapeHtml } from './html-escape.mjs';

const ADDRESS = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
export const TEST_RECIPIENT = 'admin@school.example';
const SCRIPT = fileURLToPath(new URL('./smtp_sender.py', import.meta.url));
const SITE = 'https://apps.school.example';

function mailBodyHtml(update, link) {
  if (!update.bodyHtml) return `<p style="margin:0;line-height:1.6">${escapeHtml(update.body || '').replace(/\n/g, '<br>')}</p>`;
  const formatted = sanitizeHtml(update.bodyHtml, {
    allowedTags: ['p', 'div', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr'],
    allowedAttributes: { a: ['href', 'title', 'style'], h2: ['style'], h3: ['style'], h4: ['style'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedStyles: { a: { color: [/^#195681$/], 'text-decoration': [/^underline$/] }, h2: { color: [/^#195681$/] }, h3: { color: [/^#195681$/] }, h4: { color: [/^#195681$/] } },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attrs) => ({ tagName: 'a', attribs: { href: attrs.href?.startsWith('/bbsinfo/') ? `${SITE}${attrs.href}` : attrs.href, title: attrs.title, style: 'color:#195681;text-decoration:underline' } }),
      h2: () => ({ tagName: 'h2', attribs: { style: 'color:#195681' } }),
      h3: () => ({ tagName: 'h3', attribs: { style: 'color:#195681' } }),
      h4: () => ({ tagName: 'h4', attribs: { style: 'color:#195681' } }),
    },
  });
  const imageNote = /<img\b/i.test(update.bodyHtml) ? `<p style="margin:16px 0 0;font-size:14px;color:#576576">Enthaltene Bilder: <a href="${link}" style="color:#195681">im geschützten Beitrag ansehen</a>.</p>` : '';
  return `${formatted || `<p>${escapeHtml(update.body || '')}</p>`}${imageNote}`;
}

export function readMailConfig(path) {
  if (!path) return null;
  const mode = statSync(path).mode & 0o777;
  const credential = process.env.CREDENTIALS_DIRECTORY && path === `${process.env.CREDENTIALS_DIRECTORY}/mail` && path.startsWith('/run/credentials/');
  if (mode & (credential ? 0o007 : 0o077)) throw new Error('Mailkonfiguration muss privat sein.');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.host !== 'school.example' || value.port !== 465 || value.encryption !== 'ssl' || value.username !== 'mailer' || value.from !== 'mailer@school.example' || value.issueRecipient !== 'staff@school.example' || value.testRecipient !== TEST_RECIPIENT || (value.deliveryEnabled !== undefined && typeof value.deliveryEnabled !== 'boolean') || (value.password && (typeof value.password !== 'string' || value.password.length > 512))) throw new Error('Mailkonfiguration ist ungültig.');
  // The file-backed production configuration requires a live IDM check before personal mail.
  return { ...value, personalMailRequiresIdm: true };
}

function issueMailHtmlBody(template, issue, topics, link) {
  const blocks = [];
  let lines = [];
  const flush = () => {
    if (!lines.length) return;
    const content = lines.map((line) => line.split(/(\{(?:nummer|titel|datum|link|schuljahr|inhalt)\})/g).map((part) => {
      if (part === '{link}') return `<a href="${link}" style="color:#195681;text-decoration:underline">${link}</a>`;
      if (part === '{inhalt}') return escapeHtml(topics.join(', ') || 'Weitere Informationen in der Ausgabe');
      return escapeHtml(renderMailTemplate(part, issue));
    }).join('')).join('<br>');
    blocks.push(`<p style="margin:0 0 18px;line-height:1.55">${content}</p>`);
    lines = [];
  };
  for (const raw of template.trim().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line === '{inhalt}') {
      flush();
      blocks.push(topics.length ? `<ul style="margin:0 0 20px;padding-left:24px;line-height:1.7">${topics.map((topic) => `<li>${escapeHtml(topic)}</li>`).join('')}</ul>` : '<p style="margin:0 0 18px">Weitere Informationen in der Ausgabe.</p>');
    } else if (line === '{link}') {
      flush();
      blocks.push(`<p style="margin:22px 0"><a href="${link}" style="display:inline-block;padding:12px 18px;background:#ffe24a;border-radius:8px;color:#192638;font-weight:bold;text-decoration:none">Ausgabe lesen →</a></p>`);
    } else lines.push(raw);
  }
  flush();
  return blocks.join('');
}

export function issueNotice(issue, appSettings = defaultAppSettings) {
  if (!Number.isSafeInteger(Number(issue.number)) || Number(issue.number) < 93) throw new Error('Ungültige Ausgabe.');
  const title = String(issue.title || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 200) throw new Error('Ungültiger Ausgabentitel.');
  const settings = validateAppSettings(appSettings);
  const topics = [...(issue.updates || []), ...(issue.contributions || [])].map((item) => String(item.title || '').replace(/[\r\n\t]+/g, ' ').trim()).filter(Boolean).slice(0, 30);
  const safeIssue = { ...issue, title };
  const body = renderMailTemplate(settings.mailBody, safeIssue);
  const link = `${SITE}/bbsinfo/issues/${Number(issue.number)}`;
  return {
    subject: renderMailTemplate(settings.mailSubject, safeIssue),
    body,
    html: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f5f8;font-family:Arial,Helvetica,sans-serif;color:#192638"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#fff;border-radius:12px"><tr><td style="padding:22px 24px;background:#172436;color:#fff;border-radius:12px 12px 0 0"><span style="color:#ffe24a;font-size:12px;letter-spacing:2px;font-weight:bold">BBS EINBECK · FÜR DAS KOLLEGIUM</span><h1 style="margin:8px 0 0;font-size:26px">BBS Info ${Number(issue.number)}</h1><p style="margin:5px 0 0;color:#dbe5ed">${escapeHtml(title)}</p></td></tr><tr><td style="padding:24px">${issueMailHtmlBody(settings.mailBody, safeIssue, topics, link)}</td></tr></table></td></tr></table></body></html>`,
  };
}

export async function sendIssueNotice(config, issue, appSettings = defaultAppSettings, send = sendSmtp) {
  if (!config?.password || config.testRecipient !== TEST_RECIPIENT) throw new Error('Mailversand ist nicht eingerichtet.');
  const notice = issueNotice(issue, appSettings);
  await send(config, TEST_RECIPIENT, notice);
}

export function digestNotice(updates) {
  if (!Array.isArray(updates) || !updates.length || updates.length > 50) throw new Error('Ungültige Update-Auswahl für die Sammelmail.');
  const entries = updates.map((update) => {
    const id = Number(update.id);
    const title = String(update.title || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!Number.isSafeInteger(id) || id < 1 || !title || title.length > 200) throw new Error('Ungültiges Update für die Sammelmail.');
    const link = `${SITE}/bbsinfo/updates/${id}`;
    const plain = String(update.body || (update.bodyHtml ? plainFromHtml(update.bodyHtml) : '')).trim();
    return { title, link, plain, html: mailBodyHtml(update, link), hasImage: /<img\b/i.test(update.bodyHtml || '') };
  });
  const count = entries.length;
  return {
    subject: `BBS Info: ${count} neue ${count === 1 ? 'Meldung' : 'Meldungen'}`,
    body: `Guten Tag,\n\nhier sind die aktuellen BBS-Info-Updates:\n\n${entries.map(({ title, link, plain, hasImage }) => `${title}\n${plain ? `${plain}\n` : ''}${hasImage ? 'Bilder im geschützten Beitrag ansehen.\n' : ''}${link}`).join('\n\n')}\n\nWeitere Inhalte sind nach der Anmeldung mit IServ lesbar.\n`,
    html: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BBS Info · Aktuelle Updates</title></head><body style="margin:0;padding:0;background:#f2f5f8;font-family:Arial,Helvetica,sans-serif;color:#192638"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f2f5f8"><tr><td align="center" style="padding:24px 12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px"><tr><td style="background:#172436;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0"><span style="display:block;color:#ffe24a;font-size:12px;font-weight:bold;letter-spacing:2px">BBS EINBECK · FÜR DAS KOLLEGIUM</span><strong style="display:block;margin-top:8px;font-size:28px;line-height:1.2">BBS Info</strong><span style="display:block;margin-top:8px;color:#dbe5ed;font-size:15px">${count} neue ${count === 1 ? 'Meldung' : 'Meldungen'} auf einen Blick</span></td></tr><tr><td style="background:#fff;padding:20px 24px 8px"><p style="margin:0 0 12px;font-size:16px;line-height:1.5">Guten Tag, hier sind die aktuellen Beiträge:</p></td></tr>${entries.map(({ title, link, html }) => `<tr><td style="background:#fff;padding:8px 24px 12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #d7dfe7;border-left:4px solid #ffe24a;border-radius:8px"><tr><td style="padding:18px 20px"><h2 style="margin:0 0 12px;color:#195681;font-size:20px;line-height:1.3">${escapeHtml(title)}</h2><div style="font-size:15px;line-height:1.6;color:#192638;overflow-wrap:anywhere">${html}</div><p style="margin:16px 0 0"><a href="${link}" style="color:#195681;font-weight:bold;text-decoration:underline">Beitrag in BBS Info öffnen →</a></p></td></tr></table></td></tr>`).join('')}<tr><td style="background:#fff;padding:12px 24px 24px;border-radius:0 0 12px 12px;color:#576576;font-size:13px;line-height:1.5">Links öffnen die geschützte BBS-Info-Seite. Dafür ist eine IServ-Anmeldung erforderlich.</td></tr></table></td></tr></table></body></html>`,
  };
}

export async function sendDigestTest(config, updates, send = sendSmtp) {
  if (!config?.password || config.testRecipient !== TEST_RECIPIENT) throw new Error('Testmailversand ist nicht eingerichtet.');
  const notice = digestNotice(updates);
  await send(config, TEST_RECIPIENT, notice);
}

export function colleagueDeliveryEnabled(config) {
  return config?.deliveryEnabled === true && process.env.BBSINFO_COLLEGIUM_SEND_ENABLED === '1';
}

export function subscriberRecipientAllowed(config, recipient) {
  if (!config?.password || config.testRecipient !== TEST_RECIPIENT || typeof recipient !== 'string') return false;
  const email = recipient.toLowerCase();
  return email !== 'staff@school.example' && email !== config.issueRecipient && /^[a-z0-9._%+-]+@school\.example$/.test(email);
}

export function subscriberDeliveryEnabled(config) {
  return Boolean(config?.password && config.testRecipient === TEST_RECIPIENT);
}

export async function sendSubscriberDigest(config, recipient, updates, send = sendSmtp) {
  if (!subscriberRecipientAllowed(config, recipient)) throw new Error('Abonnentenversand ist gesperrt.');
  await send(config, recipient, digestNotice(updates));
}

export async function sendCollegiumIssue(config, issue, settings, send = sendSmtp) {
  if (!colleagueDeliveryEnabled(config) || config.issueRecipient !== 'staff@school.example') throw new Error('Kollegiumsversand ist gesperrt.');
  await send(config, config.issueRecipient, issueNotice(issue, settings));
}

export function sendSmtp(config, recipient, notice) {
  const liveAllowed = recipient !== TEST_RECIPIENT && (recipient === config?.issueRecipient ? colleagueDeliveryEnabled(config) : subscriberRecipientAllowed(config, recipient));
  if (!config?.password || config.testRecipient !== TEST_RECIPIENT || (recipient !== TEST_RECIPIENT && !liveAllowed) || !ADDRESS.test(recipient) || /[\r\n]/.test(recipient) || !notice?.subject || /[\r\n]/.test(notice.subject) || typeof notice.body !== 'string' || notice.body.length > 1200000 || (notice.html !== undefined && (typeof notice.html !== 'string' || notice.html.length > 2000000))) throw new Error('Ungültige Mail.');
  const payload = JSON.stringify({ host: config.host, port: config.port, encryption: config.encryption, username: config.username, password: config.password, from: config.from, to: recipient, liveAllowed, groupAllowed: colleagueDeliveryEnabled(config), subject: notice.subject, body: notice.body, html: notice.html });
  if (Buffer.byteLength(payload) > 3000000) throw new Error('Mail ist zu groß.');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', SCRIPT], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20000);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    child.once('error', () => finish(new Error('SMTP-Prozess konnte nicht gestartet werden.')));
    child.once('close', (code) => finish(code === 0 ? null : new Error('SMTP-Versand fehlgeschlagen oder unklar.')));
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
