#!/usr/bin/env node
// Render the application's real templates with fictional data, then capture them locally.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs', 'screenshots');
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = await import(pathToFileURL(path.join(root, 'backend', 'web-pages.mjs')));
const { defaultAppSettings } = await import(pathToFileURL(path.join(root, 'backend', 'app-settings.mjs')));
const { TEST_RECIPIENT } = await import(pathToFileURL(path.join(root, 'backend', 'mail.mjs')));

const demoIdentity = { name: 'Alex Beispiel', editor: true, auditOwner: true };
const readerIdentity = { name: 'Lea Muster', editor: false, auditOwner: false };
const csrf = 'demo-only';
const update = { id: 1, title: 'Projektwoche: Rückblick und Bilder', body: 'Die Projektwoche hat viele neue Ideen hervorgebracht.\n\nEin Bericht aus dem Kollegium folgt in der nächsten Ausgabe.', bodyHtml: '<p>Die Projektwoche hat viele neue Ideen hervorgebracht.</p><p>Ein Bericht aus dem Kollegium folgt in der nächsten Ausgabe.</p>', publishedAt: '28.10.2026 10:15', publishedAtUtc: '2026-10-28 09:15:00', excerpt: 'Die Projektwoche hat viele neue Ideen hervorgebracht.', attachments: [] };
const secondUpdate = { ...update, id: 2, title: 'Neues vom Personalrat', body: 'Der Personalrat informiert über aktuelle Themen.', bodyHtml: '<p>Der Personalrat informiert über aktuelle Themen.</p>', excerpt: 'Der Personalrat informiert über aktuelle Themen.' };
const draft = { ...update, id: 3, title: 'Entwurf: Fortbildung im November', updatedAt: '28.10.2026 11:30' };
const contribution = { id: 4, title: 'Besuch im Museum', body: 'Unsere Lerngruppe berichtet von einem spannenden Projekttag.', bodyHtml: '<p>Unsere Lerngruppe berichtet von einem spannenden Projekttag.</p>', author: 'Lea Muster', ownerName: 'Lea Muster', status: 'submitted', updatedAt: '28.10.2026 09:40' };
const submission = { id: 5, title: 'Steckbrief: Lea Muster', ownerName: 'Lea Muster', mediaType: 'image/webp', status: 'taken_over', createdAt: '28.10.2026 09:00' };
const issue = { number: 93, title: 'Herbst an der BBS', schoolYear: '2026/27', period: '', publishedAt: '28.10.2026', body: 'Liebe Kolleginnen und Kollegen, hier sind die aktuellen Informationen.', bodyHtml: '<p>Liebe Kolleginnen und Kollegen, hier sind die aktuellen Informationen.</p>', updates: [update, secondUpdate], contributions: [contribution], attachments: [submission] };
const choices = (items) => ({ fresh: { items, hasMore: false }, used: { items: [], hasMore: false } });
const settings = { ...defaultAppSettings };
const mailConfig = { password: 'fictional-demo', testRecipient: TEST_RECIPIENT, deliveryEnabled: false };
const events = [
  { id: 3, occurredAt: '2026-10-28 10:15:00', actorName: 'Alex Beispiel', action: 'issue.publish', objectType: 'issue', objectId: '93', objectTitle: 'Herbst an der BBS' },
  { id: 2, occurredAt: '2026-10-28 09:40:00', actorName: 'Lea Muster', action: 'contribution.create', objectType: 'contribution', objectId: '4', objectTitle: 'Besuch im Museum' },
  { id: 1, occurredAt: '2026-10-28 08:00:00', actorName: 'Alex Beispiel', action: 'session.login', objectType: 'session', objectId: '', objectTitle: '' },
];
const stats = { days: 30, activeUsers: 24, subscriptions: 14, daily: [
  { day: '28.10.2026', action: 'session.login', eventCount: 18 }, { day: '28.10.2026', action: 'issue.view', eventCount: 32 },
  { day: '27.10.2026', action: 'search.perform', eventCount: 7 }, { day: '26.10.2026', action: 'archive.pdf', eventCount: 11 },
], topContent: [{ action: 'issue.view', objectType: 'issue', objectId: '93', objectTitle: 'Herbst an der BBS', eventCount: 32 }], searchTerms: [{ term: 'Projektwoche', eventCount: 5 }, { term: 'Personalrat', eventCount: 3 }], searchPeople: [{ person: 'Lea Muster', term: 'Projektwoche', eventCount: 2, lastAtUtc: '2026-10-28 09:00:00' }] };
const archive = { list: () => [{ number: 92, schoolYear: '2025/26', pageCount: 6 }, { number: 91, schoolYear: '2025/26', pageCount: 8 }, { number: 90, schoolYear: '2024/25', pageCount: 10 }], search: () => [{ archiveId: 92, number: 92, page: 2, excerpt: 'Beispieltext zu einer Schulveranstaltung.' }] };
const shots = [
  ['anmeldung', web.landing()],
  ['startseite', web.home(demoIdentity, csrf, true, true, true, { updates: [update, secondUpdate], issues: [issue] })],
  ['startseite-kollegium', web.home(readerIdentity, csrf, true, true, true, { updates: [update], issues: [issue] })],
  ['suche', web.searchPage('Projektwoche', { updates: [update], issues: [issue] }, [{ archiveId: 92, number: 92, page: 2, excerpt: 'Beispieltext zur Projektwoche.' }])],
  ['updates', web.updatesPage([update, secondUpdate], 'weekly', csrf, { page: 1, pageCount: 1 }, true)],
  ['beitrag', web.updateDetailPage(update)],
  ['meine-beitraege', web.contributionsPage([contribution], csrf, true)],
  ['meine-steckbriefe', web.submissionsPage([submission], [submission], csrf, true, true)],
  ['redaktion', web.editorPage([draft], [update, secondUpdate], [submission], [], csrf, {}, [contribution])],
  ['ausgaben', web.issuesPage([issue])],
  ['ausgabe', web.issuePage(issue, true)],
  ['ausgaben-bearbeiten', web.issueEditorPage([], choices([update, secondUpdate]), [issue], choices([submission]), [], csrf, '2026/27', {}, choices([contribution]))],
  ['ausgabe-korrigieren', web.issueEditPage(issue, choices([update, secondUpdate]), choices([submission]), [], csrf, null, choices([contribution]))],
  ['mailvorschau', web.issueMailPage(issue, mailConfig, csrf, settings)],
  ['einstellungen-ausgaben', web.settingsPage(settings, csrf, 'issues', [], true, [])],
  ['einstellungen-updates', web.settingsPage(settings, csrf, 'updates', [], true, [])],
  ['einstellungen-textbausteine', web.settingsPage(settings, csrf, 'templates', [{ id: 1, name: 'Personalrat', bodyHtml: '<p>Der Personalrat informiert.</p>', enabled: true }], true, [])],
  ['einstellungen-redaktion', web.settingsPage(settings, csrf, 'editors', [], true, [{ name: 'Pat Beispiel', email: 'pat@school.example', userUuid: '00000000-0000-4000-8000-000000000001' }])],
  ['historisches-archiv', web.archivePage(archive, '', '2025/26')],
  ['audit-log', web.auditPage({ events, page: 1, pageCount: 1, through: '3' })],
  ['nutzungsstatistik', web.statsPage(stats)],
];

await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-headless-shell', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
const assetRoot = path.join(root, 'design', 'web');
await context.route('http://demo.local/**', async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  const filename = pathname.split('/').pop();
  if (pathname.startsWith('/bbsinfo/assets/')) {
    let asset = path.join(assetRoot, filename);
    if (filename === 'jodit.min.js' || filename === 'jodit.min.css') asset = path.join(root, 'node_modules', 'jodit', 'es2021', filename);
    try { await route.fulfill({ path: asset }); } catch { await route.fulfill({ status: 404, body: '' }); }
    return;
  }
  if (pathname.endsWith('.webp') || pathname.includes('/media/')) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100"><rect width="800" height="1100" fill="#f7f3e5"/><rect x="50" y="55" width="700" height="990" rx="24" fill="#ffffff" stroke="#d8d4c5"/><text x="100" y="180" font-family="Arial" font-size="46" font-weight="bold" fill="#172332">BBS Info · Demo</text><circle cx="400" cy="450" r="100" fill="#7eabc5"/><path d="M190 850c20-240 400-240 420 0" fill="#7eabc5"/><text x="400" y="945" text-anchor="middle" font-family="Arial" font-size="30" fill="#172332">Fiktiver Steckbrief</text></svg>';
    await route.fulfill({ body: svg, contentType: 'image/svg+xml' });
    return;
  }
  await route.fulfill({ status: 404, body: '' });
});
for (const [name, html] of shots) {
  const page = await context.newPage();
  const marked = html.replace('<head>', '<head><base href="http://demo.local/">').replace('<body>', '<body><div class="demo-watermark">DEMO · FIKTIVE DATEN</div><style>.demo-watermark{position:fixed;z-index:99999;right:16px;bottom:16px;background:#172332;color:#fff;padding:7px 10px;border-radius:6px;font:700 12px Arial;letter-spacing:.08em;opacity:.88}</style>');
  await page.setContent(marked, { waitUntil: 'load' });
  if (html.includes('jodit.min.js')) await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' });
  await page.close();
  console.log(name);
}
await browser.close();
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(shots.map(([name]) => `${name}.png`), null, 2) + '\n');
