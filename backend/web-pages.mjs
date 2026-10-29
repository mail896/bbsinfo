import { issueNotice, digestNotice, TEST_RECIPIENT, colleagueDeliveryEnabled } from './mail.mjs';
import { cleanRichText } from './rich-text.mjs';
import { htmlEscape } from './html-escape.mjs';

export const base = '/bbsinfo/';
const githubIcon = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.73c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
const pagesIcon = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d="M3 1.5h6l4 4V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2a.5.5 0 0 1 .5-.5zM9 1.5V5a.5.5 0 0 0 .5.5H13M5.5 8h5M5.5 10.5h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function publishedDateTime(row) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.publishedAtUtc || '')) return row.publishedAt || '';
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(`${row.publishedAtUtc.replace(' ', 'T')}Z`)).replace(',', '');
}

function teaserText(value, limit = 180) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const beginning = lines.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  if (beginning.length > limit) {
    const cut = beginning.slice(0, limit + 1);
    const wordEnd = cut.lastIndexOf(' ');
    return `${cut.slice(0, wordEnd > limit * .6 ? wordEnd : limit).trimEnd()}…`;
  }
  return `${beginning}${lines.length > 2 ? '…' : ''}`;
}

export function page(title, body, script = '') {
  const editorAssets = script === 'editor.js' ? `<link rel="stylesheet" href="${base}assets/jodit.min.css"><script defer src="${base}assets/jodit.min.js"></script>` : '';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#172332"><link rel="icon" type="image/png" href="${base}assets/logo-mappe.png"><title>${htmlEscape(title)} · BBS Info</title><link rel="stylesheet" href="${base}assets/app.css">${editorAssets}${script ? `<script defer src="${base}assets/${script}"></script>` : ''}<script defer src="${base}assets/feedback.js"></script></head><body><header><div class="header-inner"><a class="brand" href="${base}"><img class="brand-logo" src="${base}assets/logo-mappe.png" width="44" height="44" alt="">BBS Info<span class="school">BBS EINBECK</span></a><span class="header-note">Informationen für das Kollegium</span></div></header><main>${body}</main><footer><span>BBS Einbeck · BBS Info<br>2026 <a href="mailto:admin@school.example">Marc Schulz</a></span><nav class="footer-links" aria-label="Projektlinks"><a href="https://github.com/mail896/bbsinfo" target="_blank" rel="noopener noreferrer">${githubIcon}<span>GitHub ↗</span></a><a href="https://mail896.github.io/bbsinfo/" target="_blank" rel="noopener noreferrer">${pagesIcon}<span>Pages ↗</span></a></nav></footer></body></html>`;
}

export function feedbackToast(message) {
  return `<div class="feedback-toast" data-feedback role="status"><span class="feedback-icon" aria-hidden="true">✓</span><span>${htmlEscape(message)}</span><button type="button" class="feedback-close" data-feedback-close aria-label="Hinweis schließen">×</button></div>`;
}

function editorHtml(row) {
  if (row.bodyHtml) return row.bodyHtml;
  return String(row.body || '').split(/\n{2,}/).map((paragraph) => `<p>${htmlEscape(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
}

function renderBody(row) {
  if (!row.bodyHtml) return `<p class="pre-wrap">${htmlEscape(row.body || '')}</p>`;
  const markup = cleanRichText(row.bodyHtml, 40000).html.replace(/<img\b[^>]*>/g, (tag) => {
    const source = /\bsrc="(\/bbsinfo\/editor-images\/[0-9a-f-]{36})"/i.exec(tag)?.[1];
    if (!source) return tag;
    const displayWidth = Number(/\bstyle="width:\s*(\d+)px"/i.exec(tag)?.[1] || 420);
    const variant = [100, 200, 400, 600, 800, 1000, 1200, 1600].find((width) => width >= displayWidth * 2) || 1600;
    return tag.replace(`src="${source}"`, `src="${source}?w=${variant}"`);
  });
  return `<div class="rich-body">${markup}</div>`;
}

function numberedPager(pageNumber, pageCount, href, label = 'Seitennavigation') {
  if (pageCount <= 1) return '';
  const visible = new Set([1, 2, pageCount - 2, pageCount - 1, pageCount, pageNumber - 1, pageNumber, pageNumber + 1]);
  const numbers = [...visible].filter((number) => number >= 1 && number <= pageCount).sort((a, b) => a - b);
  const links = numbers.map((number, index) => `${index && number > numbers[index - 1] + 1 ? '<span class="pagination-gap" aria-hidden="true">…</span>' : ''}${number === pageNumber ? `<span class="pagination-current" aria-current="page">${number}</span>` : `<a href="${htmlEscape(href(number))}" aria-label="Seite ${number}">${number}</a>`}`).join('');
  return `<nav class="pagination" aria-label="${label}"><span class="pagination-edge">${pageNumber > 1 ? `<a href="${htmlEscape(href(pageNumber - 1))}">← Zurück</a>` : ''}</span><span class="pagination-pages">${links}</span><span class="pagination-edge">${pageNumber < pageCount ? `<a href="${htmlEscape(href(pageNumber + 1))}">Weiter →</a>` : ''}</span></nav>`;
}

function contentPager(path, key, state, other = {}) {
  if (!state) return '';
  const href = (page) => {
    const params = new URLSearchParams({ ...other, [key]: String(page) });
    return `${base}${path}?${params}`;
  };
  return numberedPager(state.page, state.pageCount || (state.hasNext ? state.page + 1 : state.page), href);
}

function templatePicker(templates, target) {
  if (!templates.length) return '';
  return `<div class="template-insert"><label for="picker-${target}">Optionaler Baustein</label><select id="picker-${target}" data-template-picker="${target}"><option value="">Baustein wählen</option>${templates.map((item) => `<option value="${Number(item.id)}">${htmlEscape(item.name)}</option>`).join('')}</select><button type="button" class="secondary" data-insert-template="${target}">Einfügen</button></div>`;
}

function templateSources(templates) {
  return templates.map((item) => `<template id="template-${Number(item.id)}">${cleanRichText(item.bodyHtml, 10000).html}</template>`).join('');
}

function imagePicker(target) {
  return `<div class="editor-image-picker"><label for="image-${target}">Bild in den Text einfügen (JPEG, PNG oder WebP, höchstens 3 MB; wird beim Hochladen optimiert)</label><input id="image-${target}" type="file" accept="image/jpeg,image/png,image/webp" data-image-editor="${target}"><span class="image-upload-status" role="status" aria-live="polite"></span></div>`;
}

export function landing(message = '') {
  return page('Anmeldung', `<section class="landing-shell" data-landing-shell><div class="landing-copy"><span class="eyebrow">BBS EINBECK · FÜR DAS KOLLEGIUM</span><h1 class="landing-title"><span>BBS</span> <span>Info</span></h1><p>Neuigkeiten, Ausgaben und Mitteilungen aus unserer Schule – an einem Ort.</p>${message ? `<p role="alert">${htmlEscape(message)}</p>` : ''}<a class="button" href="${base}oidc/login">Mit IServ anmelden →</a><p class="landing-note">Zugang für berechtigte IServ-Konten.</p></div><div class="landing-visual" data-landing-animation><div class="landing-scene"><div class="landing-flip"><div class="landing-face landing-back" aria-hidden="true"><img src="${base}assets/landing-steckbriefe-back.webp" width="960" height="960" alt=""></div><div class="landing-face landing-front"><img src="${base}assets/landing-steckbriefe.webp" width="960" height="960" alt="Gelbe BBS-Info-Mappe mit drei fiktiven Lehrkraftporträts"></div></div><div class="landing-announcements" aria-hidden="true"><strong>Info Mappe</strong><span class="notice-item">Neue Kollegin in der Abteilung SPH</span><span class="notice-item">Das Referendariat haben abgeschlossen...</span><span class="notice-item">Neues vom Personalrat</span><span class="notice-item">Veränderungsanzeigen</span></div><button type="button" class="landing-hit" data-replay-animation aria-label="Animation der Mappe erneut abspielen" title="Animation erneut ansehen"></button></div></div></section>`, 'landing.js');
}

function publicationMailNotice(status) {
  if (status === 'sent') return '<p class="mail-status" role="status">Ausgabe veröffentlicht. Die Testmail wurde an Marc gesendet.</p>';
  if (status === 'not_sent') return '<p class="mail-status" role="alert">Ausgabe veröffentlicht. Die Testmail wurde wegen eines Auditfehlers nicht versendet.</p>';
  if (status === 'uncertain') return '<p class="mail-status" role="alert">Ausgabe veröffentlicht. Die Testmail wurde versendet, aber der Auditeintrag konnte nicht abgeschlossen werden. Bitte Marcs Postfach prüfen, bevor du sie erneut sendest.</p>';
  if (status === 'failed') return '<p class="mail-status" role="alert">Ausgabe veröffentlicht. Der Status der Testmail ist unklar. Bitte erst das Postfach prüfen, bevor du sie erneut sendest.</p>';
  if (status === 'unavailable') return '<p class="mail-status" role="alert">Ausgabe veröffentlicht. Der Testmailversand ist nicht eingerichtet.</p>';
  return '';
}

function personalPage(active, content, script = '', showContributions = true, showSubmissions = true) {
  const tabs = [
    showContributions ? { label: 'Meine Beiträge', href: `${base}contributions/`, key: 'contributions' } : null,
    showSubmissions ? { label: 'Meine Steckbriefe', href: `${base}submissions/`, key: 'submissions' } : null,
    { label: 'Papierkorb', href: `${base}trash/`, key: 'trash' },
  ].filter(Boolean);
  const nav = tabs.length > 1 ? `<nav class="personal-tabs" aria-label="Meine Inhalte">${tabs.map((tab) => `<a href="${tab.href}"${active === tab.key ? ' aria-current="page"' : ''}>${tab.label}</a>`).join('')}</nav>` : '';
  return page('Meine Inhalte', `<section class="personal-page"><p><a href="${base}">← Zur Startseite</a></p><h1>Meine Inhalte</h1>${nav}<div class="personal-content">${content}</div></section>`, script);
}

export function home(identity, csrf, archiveAvailable, cmsAvailable, submissionsAvailable, highlights = { updates: [], issues: [] }, mailTest = null) {
  const updateItems = highlights.updates.length ? highlights.updates.map((item, index) => {
    const href = `${base}updates/${Number(item.id)}`;
    const date = `<time>${htmlEscape(publishedDateTime(item))} Uhr</time>`;
    const title = `<h3><a href="${href}">${htmlEscape(item.title)}</a></h3>`;
    return index === 0
      ? `<article class="teaser">${date}${title}<p>${htmlEscape(teaserText(item.excerpt))}</p><a class="teaser-more" href="${href}">Weiterlesen →</a></article>`
      : `<article class="teaser teaser-compact">${date}${title}</article>`;
  }).join('') : '<p class="meta">Noch keine Updates veröffentlicht.</p>';
  const issueItems = highlights.issues.length ? highlights.issues.map((item) => `<article class="teaser"><time>${htmlEscape(item.publishedAt || '')}</time><h3><a href="${base}issues/${Number(item.number)}">BBS Info ${Number(item.number)}: ${htmlEscape(item.title)}</a></h3></article>`).join('') : '<p class="meta">Noch keine neue Ausgabe veröffentlicht.</p>';
  const nav = `<nav class="home-nav" aria-label="Bereiche">${cmsAvailable ? `<a href="${base}updates/">Aktuelles</a><a href="${base}issues/">Ausgaben</a>` : ''}${archiveAvailable ? `<a class="archive-action" href="${base}archive/">Historisches Archiv</a>` : ''}${cmsAvailable || submissionsAvailable ? `<a class="personal-action" href="${base}${cmsAvailable ? 'contributions/' : 'submissions/'}">Meine Beiträge &amp; Steckbriefe</a>` : ''}</nav>`;
  const work = identity.editor || identity.auditOwner ? `<section class="work-panel"><span class="eyebrow">Arbeitsbereich</span><h2>${identity.auditOwner ? 'Redaktion & Verwaltung' : 'Redaktion'}</h2><div class="work-links">${identity.editor && cmsAvailable ? `<a href="${base}editor/">Beiträge bearbeiten →</a><a class="issue-action" href="${base}editor/issues/">Ausgaben bearbeiten →</a><a href="${base}editor/settings/">Einstellungen →</a>` : ''}${identity.auditOwner && cmsAvailable ? `<a href="${base}audit/">Audit-Log →</a><a href="${base}stats/">Nutzungsstatistik →</a>` : ''}</div></section>` : '';
  return page('Startseite', `<section class="home-shell">${identity.editor ? publicationMailNotice(mailTest) : ''}<div class="hero"><div><span class="eyebrow">BBS INFO · INTERN</span><h1>Gut informiert.<br>Gemeinsam <span>im Blick.</span></h1><p>Neuigkeiten, Ausgaben und Mitteilungen für das Kollegium.</p></div><div class="hero-account"><span>Mit IServ angemeldet als</span><strong>${htmlEscape(identity.name)}</strong><span>${identity.auditOwner ? 'Administration und Auswertung' : identity.editor ? 'Redaktion' : 'Kollegium'}</span><form method="post" action="${base}logout"><input type="hidden" name="csrf" value="${csrf}"><button type="submit" title="Von BBS Info abmelden">Abmelden →</button></form></div></div>${nav}${cmsAvailable ? `<section class="search-panel"><div><span class="eyebrow">Alles an einem Ort</span><h2>BBS Info durchsuchen</h2></div><form method="get" action="${base}search/"><label class="visually-hidden" for="home-search">Suchbegriff</label><input id="home-search" name="q" placeholder="Thema oder Stichwort" minlength="2" maxlength="100" required><button type="submit">Suchen →</button></form></section><div class="home-grid"><section class="home-card"><div class="card-header"><div><span class="eyebrow">Laufend</span><h2>Aktuelle Updates</h2></div><a href="${base}updates/">Alle ansehen →</a></div>${updateItems}</section><section class="home-card issue-card"><div class="card-header"><div><span class="eyebrow">Nummeriert</span><h2>Neue Ausgaben</h2></div><a href="${base}issues/">Alle ansehen →</a></div>${issueItems}</section></div>` : ''}${work}</section>`);
}

export function searchPage(query, web, archive) {
  const issues = web.issues.length ? `<h2>Neue Ausgaben</h2><ul>${web.issues.map((row) => `<li><a href="${base}issues/${Number(row.number)}">BBS Info ${Number(row.number)}: ${htmlEscape(row.title)}</a>${row.excerpt ? `<p>${htmlEscape(row.excerpt)}</p>` : ''}</li>`).join('')}</ul>` : '';
  const updates = web.updates.length ? `<h2>Updates</h2><ul>${web.updates.map((row) => `<li><a href="${base}updates/${Number(row.id)}">${htmlEscape(row.title)}</a>${row.excerpt ? `<p>${htmlEscape(row.excerpt)}</p>` : ''}</li>`).join('')}</ul>` : '';
  const historical = archive.length ? `<h2>Historische PDFs</h2><ul>${archive.map((row) => `<li><a href="${base}archive/${Number(row.archiveId)}.pdf" target="_blank" rel="noopener noreferrer">Ausgabe ${Number(row.number)}, Seite ${Number(row.page)}</a>${row.excerpt ? `<p>${htmlEscape(row.excerpt)}</p>` : ''}</li>`).join('')}</ul>` : '';
  return page('Suche', `<section><p><a href="${base}">← Zur Startseite</a></p><h1>Suche</h1><form method="get" action="${base}search/"><label>Suchbegriff <input name="q" minlength="2" maxlength="100" value="${htmlEscape(query)}" required></label> <button type="submit">Suchen</button></form>${issues || updates || historical ? issues + updates + historical : '<p>Keine Treffer gefunden.</p>'}</section>`);
}

export function updatesPage(updates, mode, csrf, pagination = null, mailActive = false, idmPaused = false) {
  const items = updates.length ? updates.map((row) => `<article id="update-${Number(row.id)}"><h2>${htmlEscape(row.title)}</h2><p class="meta">${htmlEscape(publishedDateTime(row))} Uhr</p>${renderBody(row)}${row.attachments?.length ? `<ul>${row.attachments.map((item) => `<li><a href="${base}media/${Number(item.id)}">${htmlEscape(item.title)} herunterladen</a></li>`).join('')}</ul>` : ''}</article>`).join('<hr>') : '<p>Noch keine Updates veröffentlicht.</p>';
  const modeLabel = { off: 'Aus', instant: 'Sofort', daily: 'Täglich', weekly: 'Wöchentlich' }[mode] || 'Aus';
  const paused = mode !== 'off' && (idmPaused || !mailActive) ? ' · pausiert' : '';
  return page('Updates', `<section><p><a href="${base}">← Zur Startseite</a></p><h1>Updates</h1><details class="updates-preferences"><summary><span class="updates-mail-icon" aria-hidden="true">✉</span><span>E-Mail-Benachrichtigung: <strong>${modeLabel}${paused}</strong></span><span class="updates-preferences-action">Einstellungen</span></summary><div class="updates-preferences-panel"><form method="post" action="${base}subscribe"><input type="hidden" name="csrf" value="${csrf}"><label for="update-mail-mode">Benachrichtigung über neue Updates</label><div class="subscription-row"><select id="update-mail-mode" name="mode"><option value="off"${mode === 'off' ? ' selected' : ''}>Keine E-Mail</option><option value="instant"${mode === 'instant' ? ' selected' : ''}>Sofort bei Veröffentlichung</option><option value="daily"${mode === 'daily' ? ' selected' : ''}>Täglich um 18:00 Uhr</option><option value="weekly"${mode === 'weekly' ? ' selected' : ''}>Wöchentlich montags um 07:00 Uhr</option></select><button type="submit">Auswahl speichern</button></div><p class="meta">Die tägliche Mail bündelt Beiträge bis 18:00 Uhr; später veröffentlichte Beiträge folgen am nächsten Abend. Die Auswahl gilt für künftig veröffentlichte Beiträge. Die Ausgaben-Mail ist unabhängig von dieser Auswahl; der Versand an das gesamte Kollegium bleibt derzeit gesperrt.</p>${idmPaused ? '<p class="pilot-mail-note">Persönliche Update-Mails sind derzeit pausiert, weil die IServ-Gruppenprüfung nicht verfügbar ist. Die Auswahl wird gespeichert.</p>' : !mailActive ? '<p class="pilot-mail-note">Für dieses Konto ist aktuell kein persönlicher Mailversand möglich. Die Auswahl wird gespeichert.</p>' : ''}</form></div></details>${items}${contentPager('updates/', 'page', pagination)}</section>`);
}

export function contributionsPage(own, csrf, submissionsAvailable = true) {
  const items = own.length ? `<ul class="editor-items">${own.map((item) => editorListItem({ title: item.title, meta: `${item.status === 'taken_over' ? 'Von der Redaktion übernommen' : 'Eingereicht, noch änderbar'} · ${item.updatedAt || ''} Uhr`, actions: item.status === 'submitted' ? `<details><summary class="editor-edit-action">Bearbeiten</summary><form method="post" action="${base}contributions/save"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(item.id)}"><p><label>Titel<input name="title" maxlength="200" required value="${htmlEscape(item.title)}"></label></p>${editorField(`contribution-${Number(item.id)}`, item, [])}<p><button type="submit">Änderung speichern</button></p></form></details>${deleteControl({ action: 'contributions/delete', field: 'id', id: item.id, title: item.title, kind: 'Beitrag', csrf })}` : '' })).join('')}</ul>` : '<p>Noch keine eigenen Beiträge.</p>';
  return personalPage('contributions', `<p>Berichte und Meldungen für die nächste Ausgabe kannst du hier mit Text und Bildern einreichen. Bis zur Übernahme durch die Redaktion kannst du sie ändern.</p><h2>Neuen Beitrag einreichen</h2><form method="post" action="${base}contributions/save"><input type="hidden" name="csrf" value="${csrf}"><p><label>Titel<input name="title" maxlength="200" required></label></p>${editorField('new-contribution', null, [])}<p><button type="submit">Bei der Redaktion einreichen</button></p></form><h2>Eigene Beiträge</h2>${items}`, 'editor.js', true, submissionsAvailable);
}

export function updateDetailPage(update) {
  const attachments = update.attachments?.length ? `<ul>${update.attachments.map((item) => `<li><a href="${base}media/${Number(item.id)}">${htmlEscape(item.title)} herunterladen</a></li>`).join('')}</ul>` : '';
  return page(update.title, `<section><p><a href="${base}updates/">← Alle Updates</a></p><article id="update-${Number(update.id)}"><h1>${htmlEscape(update.title)}</h1><p class="meta">${htmlEscape(publishedDateTime(update))} Uhr</p>${renderBody(update)}${attachments}</article></section>`);
}

function editorField(id, row, templates) {
  return `<label for="${id}">Text</label>${templatePicker(templates, id)}<textarea id="${id}" name="bodyHtml" rows="10" data-rich-editor>${htmlEscape(row ? editorHtml(row) : '')}</textarea>${imagePicker(id)}`;
}

function deleteControl({ action, field, id, title, kind, csrf }) {
  const label = htmlEscape(title);
  const key = Number(id);
  return `<form class="inline-delete" method="post" action="${base}${action}" data-confirm-delete="${label}" data-confirm-kind="${kind}" data-confirm-id="${key}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="${field}" value="${key}"><input type="hidden" name="confirm" value=""><button type="submit" class="delete-x" aria-label="${kind} ${label} in den Papierkorb verschieben"><span aria-hidden="true">×</span> In Papierkorb</button></form>`;
}

function editorListItem({ title, href, meta = '', actions }) {
  const heading = href ? `<a href="${href}">${htmlEscape(title)}</a>` : htmlEscape(title);
  return `<li class="editor-item"><h3>${heading}</h3>${meta ? `<p class="meta">${htmlEscape(meta)}</p>` : ''}<div class="editor-row-actions">${actions}</div></li>`;
}

export function editorPage(drafts, published, submissions, templates, csrf, pages = {}, contributions = []) {
  const deleteForm = (row) => deleteControl({ action: 'editor/delete-update', field: 'id', id: row.id, title: row.title, kind: 'Beitrag', csrf });
  const items = drafts.length ? `<ul class="editor-items">${drafts.map((row) => editorListItem({
    title: row.title,
    meta: `Zuletzt geändert: ${row.updatedAt || ''} Uhr`,
    actions: `<details><summary class="editor-edit-action">Bearbeiten</summary><form method="post" action="${base}editor/update"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(row.id)}"><input type="hidden" name="mode" value="draft_edit"><p><label>Titel<input name="title" required maxlength="200" value="${htmlEscape(row.title)}"></label></p>${editorField(`update-${Number(row.id)}`, row, templates)}<p><button type="submit">Änderung speichern</button></p></form></details>${deleteForm(row)}<form method="post" action="${base}editor/publish"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(row.id)}"><button type="submit" class="secondary">Veröffentlichen</button></form>`,
  })).join('')}</ul>` : '<p>Keine Entwürfe vorhanden.</p>';
  const publishedItems = published.length ? `<ul class="editor-items">${published.map((row) => editorListItem({
    title: row.title,
    href: `${base}updates/${Number(row.id)}`,
    actions: `<details><summary class="editor-edit-action">Bearbeiten</summary><form method="post" action="${base}editor/update"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(row.id)}"><input type="hidden" name="mode" value="published_edit"><p><label>Titel<input name="title" required maxlength="200" value="${htmlEscape(row.title)}"></label></p>${editorField(`published-${Number(row.id)}`, row, templates)}<p><button type="submit">Änderungen speichern</button></p></form></details>${deleteForm(row)}`,
  })).join('')}</ul>` : '<p>Noch keine veröffentlichten Updates.</p>';
  const choices = submissions.map((item) => `<label class="choice"><input type="checkbox" name="submissionId" value="${Number(item.id)}"> ${htmlEscape(item.title)} · ${htmlEscape(item.ownerName || 'Name noch nicht erfasst')}</label>`).join('');
  const colleagueItems = contributions.length ? `<ul class="editor-items">${contributions.map((item) => `<li class="editor-item"><h3>${htmlEscape(item.title)}</h3><p class="meta">von ${htmlEscape(item.author)}</p><div class="editor-row-actions"><details><summary>Beitrag ansehen</summary>${renderBody(item)}</details>${deleteControl({ action: 'editor/contributions/delete', field: 'id', id: item.id, title: item.title, kind: 'Einreichung', csrf })}</div></li>`).join('')}</ul><p><a href="${base}editor/issues/">In eine Ausgabe übernehmen →</a></p>` : '<p>Keine neuen Beiträge eingereicht.</p>';
  return page('Redaktion', `<section><p><a href="${base}">← Zur Startseite</a></p><h1>Redaktion: Updates</h1><nav class="subnav"><a href="${base}editor/issues/">Ausgaben bearbeiten</a><a href="${base}editor/templates/">Bausteine verwalten</a></nav><h2>Aus dem Kollegium eingereicht</h2>${colleagueItems}<h2>Neuen Entwurf anlegen</h2><form method="post" action="${base}editor/drafts"><input type="hidden" name="csrf" value="${csrf}"><p><label>Titel<input name="title" required maxlength="200"></label></p>${editorField('new-update', null, templates)}${choices ? `<fieldset><legend>Übernommene Steckbriefe anhängen</legend>${choices}</fieldset>` : ''}<p><button type="submit">Als Entwurf speichern</button></p></form><h2>Entwürfe</h2>${items}${contentPager('editor/', 'draftPage', pages.drafts, { publishedPage: pages.published?.page || 1 })}<h2>Veröffentlichte Updates bearbeiten</h2><p>Änderungen am bestehenden Beitrag stehen im Audit-Log. Neue Informationen und Ergänzungen bitte als neues Update veröffentlichen.</p>${publishedItems}${contentPager('editor/', 'publishedPage', pages.published, { draftPage: pages.drafts?.page || 1 })}${templateSources(templates)}</section>`, 'editor.js');
}

function templateSettingsPanel(templates, csrf) {
  const rows = templates.length ? `<div class="template-list">${templates.map((row) => `<details><summary>${htmlEscape(row.name)}${row.enabled ? '' : ' · deaktiviert'}</summary><form method="post" action="${base}editor/templates/save"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(row.id)}"><p><label>Name<input name="name" maxlength="100" required value="${htmlEscape(row.name)}"></label></p><label for="template-body-${Number(row.id)}">Textvorlage</label><textarea id="template-body-${Number(row.id)}" name="bodyHtml" rows="8" data-rich-editor>${htmlEscape(row.bodyHtml)}</textarea>${imagePicker(`template-body-${Number(row.id)}`)}<p><label class="choice"><input type="checkbox" name="enabled" value="1"${row.enabled ? ' checked' : ''}> Beim Schreiben auswählbar</label></p><button type="submit">Baustein speichern</button></form></details>`).join('')}</div>` : '<p>Noch keine Bausteine angelegt.</p>';
  return `<h2>Textbausteine</h2><p>Bausteine sind optionale Starttexte. Nach dem Einfügen kann die Redaktion sie vollständig ändern.</p><h3>Neuen Baustein anlegen</h3><form method="post" action="${base}editor/templates/save"><input type="hidden" name="csrf" value="${csrf}"><p><label>Name<input name="name" maxlength="100" required></label></p><label for="template-new">Textvorlage</label><textarea id="template-new" name="bodyHtml" rows="8" data-rich-editor></textarea>${imagePicker('template-new')}<p><label class="choice"><input type="checkbox" name="enabled" value="1" checked> Beim Schreiben auswählbar</label></p><button type="submit">Baustein anlegen</button></form><h3>Vorhandene Bausteine</h3>${rows}`;
}

export function issuesPage(issues, pagination = null) {
  const items = issues.length ? `<ul class="issue-list">${issues.map((issue) => `<li><a href="${base}issues/${Number(issue.number)}">BBS Info ${Number(issue.number)}: ${htmlEscape(issue.title)}</a> · ${htmlEscape(issue.publishedAt || '')}${issue.schoolYear ? ` · ${htmlEscape(issue.schoolYear)}` : ''}${issue.period ? ` · ${htmlEscape(issue.period)}` : ''}</li>`).join('')}</ul>` : '<p>Noch keine neue Ausgabe veröffentlicht.</p>';
  return page('Neue Ausgaben', `<section><p><a href="${base}">← Zur Startseite</a></p><h1>Neue Ausgaben</h1>${items}${contentPager('issues/', 'page', pagination)}</section>`);
}

export function issuePage(issue, canEdit = false) {
  const updates = issue.updates.map((item) => `<article><h2>${htmlEscape(item.title)}</h2>${renderBody(item)}</article>`).join('<hr>');
  const contributions = (issue.contributions || []).map((item) => `<article><h2>${htmlEscape(item.title)}</h2>${renderBody(item)}<p class="article-author">von ${htmlEscape(item.author)}</p></article>`).join('<hr>');
  const attachments = issue.attachments?.length ? `<hr><h2>Steckbriefe</h2>${issue.attachments.map((item) => {
    const title = htmlEscape(item.title);
    const id = Number(item.id);
    const pages = item.mediaType === 'application/pdf' && item.pageCount ? Array.from({ length: item.pageCount }, (_, index) => `<img src="${base}media/${id}/page/${index + 1}.webp" alt="${title}, Seite ${index + 1}" loading="lazy" width="2000" height="2800">`).join('') : item.mediaType?.startsWith('image/') ? `<img src="${base}media/${id}/inline" alt="Steckbrief ${title}" loading="lazy">` : '<p>Dieser Steckbrief kann gerade nicht angezeigt werden.</p>';
    return `<section class="issue-attachment" aria-label="Steckbrief ${title}"><div class="issue-attachment-pages">${pages}</div></section>`;
  }).join('')}` : '';
  return page(`Ausgabe ${issue.number}`, `<section><p class="no-print"><a href="${base}issues/">← Alle neuen Ausgaben</a></p><h1>BBS Info ${Number(issue.number)}: ${htmlEscape(issue.title)}</h1><p class="meta">${htmlEscape(issue.publishedAt || '')}${issue.schoolYear ? ` · ${htmlEscape(issue.schoolYear)}` : ''}${issue.period ? ` · ${htmlEscape(issue.period)}` : ''}</p>${canEdit ? `<p class="no-print"><a href="${base}editor/issues/${Number(issue.number)}/edit">Ausgabe bearbeiten →</a></p>` : ''}${issue.body ? renderBody(issue) : ''}${updates ? `<hr><h2>Ausgewählte Updates</h2>${updates}` : ''}${contributions ? `<hr><h2>Aus dem Kollegium</h2>${contributions}` : ''}${attachments}<p class="issue-download no-print"><a class="button secondary" href="${base}issues/${Number(issue.number)}.pdf" download="BBS-Info-${Number(issue.number)}.pdf">Ausgabe als PDF herunterladen ↓</a></p></section>`);
}

function issueSourceChoices(group, kind, selectedItems = []) {
  const settings = {
    updates: { field: 'updateId', empty: 'Keine neuen Updates vorhanden.', used: 'Bereits veröffentlichte Updates', description: (item) => `${htmlEscape(item.title)}${publishedDateTime(item) ? ` · ${htmlEscape(publishedDateTime(item))}` : ''}` },
    contributions: { field: 'contributionId', empty: 'Keine neuen Beiträge aus dem Kollegium vorhanden.', used: 'Bereits veröffentlichte Kollegiumsbeiträge', description: (item) => `${htmlEscape(item.title)} · von ${htmlEscape(item.author || 'Name noch nicht erfasst')}` },
    submissions: { field: 'submissionId', empty: 'Keine neuen Steckbriefe vorhanden.', used: 'Bereits verwendete Steckbriefe', description: (item) => `${htmlEscape(item.title)} · ${htmlEscape(item.ownerName || 'Name noch nicht erfasst')}` },
  }[kind];
  const selected = new Set(selectedItems.map((item) => Number(item.id)));
  const priorIssues = (item) => String(item.usedInIssues || '').split(',').filter((number) => /^[1-9][0-9]*$/.test(number)).join(', ');
  const choice = (item, checked = false) => `<div class="issue-source-row" data-issue-source-row="${Number(item.id)}"${checked ? ' data-source-used="1"' : ''}><label class="choice"><input type="checkbox" name="${settings.field}" value="${Number(item.id)}"${checked ? ' checked' : ''}> ${settings.description(item)}</label>${item.usedInIssues ? `<span class="issue-source-reference">BBS Info ${htmlEscape(priorIssues(item))}</span>` : ''}</div>`;
  const fresh = group.fresh.items.filter((item) => !selected.has(Number(item.id)));
  const used = group.used.items.filter((item) => !selected.has(Number(item.id)));
  return `<div class="issue-source" data-issue-source="${kind}"><label class="issue-source-search-label">Liste durchsuchen<input type="search" maxlength="100" placeholder="Titel oder Name" data-issue-source-search></label><div class="issue-source-current" data-issue-source-selected${selectedItems.length ? '' : ' hidden'}><p class="meta">In dieser Ausgabe ausgewählt</p>${selectedItems.map((item) => choice(item, true)).join('')}</div><div data-issue-source-results="fresh">${fresh.length ? fresh.map((item) => choice(item)).join('') : `<p class="meta" data-issue-source-empty>${settings.empty}</p>`}</div><button type="button" class="secondary issue-source-more" data-issue-source-more="fresh"${group.fresh.hasMore ? '' : ' hidden'}>Weitere anzeigen</button><details class="issue-source-used"${used.length || group.used.hasMore ? '' : ' hidden'}><summary>${settings.used}</summary><p class="meta">Diese Inhalte stehen schon in einer Ausgabe. Bei Bedarf kannst du sie erneut übernehmen.</p><div data-issue-source-results="used">${used.map((item) => choice(item)).join('')}</div><button type="button" class="secondary issue-source-more" data-issue-source-more="used"${group.used.hasMore ? '' : ' hidden'}>Weitere anzeigen</button></details><p class="issue-source-status meta" data-issue-source-status role="status" aria-live="polite"></p></div>`;
}

export function issueEditorPage(drafts, updates, publishedIssues, submissions, templates, csrf, schoolYear, pages = {}, contributions = [], mailTest = null) {
  const choices = issueSourceChoices(updates, 'updates');
  const colleagueChoices = issueSourceChoices(contributions, 'contributions');
  const oldDrafts = drafts.length ? `<h2>Frühere Ausgaben-Entwürfe</h2><p>Diese älteren Entwürfe kannst du noch veröffentlichen oder in den Papierkorb verschieben.</p><ul class="editor-items">${drafts.map((item) => editorListItem({
    title: item.title,
    actions: `<form method="post" action="${base}editor/issues/publish"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(item.id)}"><button type="submit" class="secondary">Entwurf veröffentlichen</button></form>${deleteControl({ action: 'editor/issues/delete-draft', field: 'id', id: item.id, title: item.title, kind: 'Ausgabenentwurf', csrf })}`,
  })).join('')}</ul>${contentPager('editor/issues/', 'draftPage', pages.drafts, { publishedPage: pages.published?.page || 1 })}` : '';
  const published = publishedIssues.length ? `<h2>Veröffentlichte Ausgaben</h2><ul class="editor-items">${publishedIssues.map((item) => editorListItem({
    title: `BBS Info ${item.number}: ${item.title}`,
    href: `${base}issues/${Number(item.number)}`,
    actions: `<a class="editor-edit-action" href="${base}editor/issues/${Number(item.number)}/edit">Bearbeiten</a>${deleteControl({ action: 'editor/issues/delete', field: 'number', id: item.number, title: `BBS Info ${item.number}: ${item.title}`, kind: 'Ausgabe', csrf })}<a href="${base}issues/${Number(item.number)}.pdf" download="BBS-Info-${Number(item.number)}.pdf">PDF herunterladen</a><a href="${base}editor/issues/${Number(item.number)}/mail">Mailvorschau</a>`,
  })).join('')}</ul>${contentPager('editor/issues/', 'publishedPage', pages.published, { draftPage: pages.drafts?.page || 1 })}` : '';
  return page('Ausgaben bearbeiten', `<section><p><a href="${base}">← Zur Startseite</a></p>${publicationMailNotice(mailTest)}<h1>Ausgaben bearbeiten</h1><h2>Neue Ausgabe veröffentlichen</h2><p>Die nächste Nummer und das aktuelle Schuljahr ${htmlEscape(schoolYear)} werden beim Veröffentlichen automatisch gesetzt. Im Pilotbetrieb geht bei der Veröffentlichung automatisch eine Testmail nur an Marc.</p><form method="post" action="${base}editor/issues/create-publish"><input type="hidden" name="csrf" value="${csrf}"><p><label>Titel<input name="title" required maxlength="200"></label></p><p><label>Berichtszeitraum (optional)<input name="period" maxlength="100" placeholder="z. B. Oktober 2026"></label><span class="meta">Nur ausfüllen, wenn die Ausgabe einen bestimmten Zeitraum zusammenfasst; sonst leer lassen.</span></p><label for="new-issue">Eigener Text (optional, wenn Updates übernommen werden)</label>${templatePicker(templates, 'new-issue')}<textarea id="new-issue" name="bodyHtml" rows="12" data-rich-editor></textarea>${imagePicker('new-issue')}<fieldset><legend>Veröffentlichte Updates übernehmen</legend>${choices || '<p>Noch keine Updates vorhanden.</p>'}</fieldset><fieldset><legend>Beiträge aus dem Kollegium</legend>${colleagueChoices || '<p>Keine eingereichten Beiträge vorhanden.</p>'}</fieldset><fieldset><legend>Übernommene Steckbriefe anhängen</legend>${issueSourceChoices(submissions, 'submissions')}</fieldset><p>Übernommene Beiträge werden bei Veröffentlichung als Textstand gespeichert.</p><button type="submit">Ausgabe jetzt veröffentlichen</button></form>${oldDrafts}${published}${templateSources(templates)}</section>`, 'editor.js');
}

export function issueEditPage(issue, updates, submissions, templates, csrf, mailStatus, contributions = []) {
  const selectedUpdates = issue.updates.filter((item) => item.updateId).map((item) => ({ id: item.updateId, title: item.title, publishedAtUtc: '' }));
  const choices = issueSourceChoices(updates, 'updates', selectedUpdates);
  const missing = issue.updates.filter((item) => !item.updateId).map((item) => `<label class="choice"><input type="checkbox" name="keepSnapshotId" value="${Number(item.snapshotId)}" checked> ${htmlEscape(item.title)} · gespeicherter Beitrag ohne aktuelle Quelle</label>`).join('');
  const selectedContributions = (issue.contributions || []).filter((item) => item.contributionId).map((item) => ({ id: item.contributionId, title: item.title, author: item.author }));
  const colleagueChoices = issueSourceChoices(contributions, 'contributions', selectedContributions);
  const selectedFiles = issue.attachments || [];
  return page(`Ausgabe ${issue.number} bearbeiten`, `<section><p><a href="${base}editor/issues/">← Ausgaben bearbeiten</a></p><h1>BBS Info ${Number(issue.number)} bearbeiten</h1><p>Nummer, Veröffentlichungsdatum und Schuljahr ${htmlEscape(issue.schoolYear)} bleiben erhalten. Nach dem Speichern zeigen Webseite und PDF den neuen Stand. Es wird keine Mail versendet.${mailStatus ? ' Die Ausgaben-Mail wurde bereits angestoßen; eine frühere Mail ändert sich dadurch nicht.' : ''}</p><form method="post" action="${base}editor/issues/${Number(issue.number)}/edit"><input type="hidden" name="csrf" value="${csrf}"><p><label>Titel<input name="title" required maxlength="200" value="${htmlEscape(issue.title)}"></label></p><p><label>Berichtszeitraum (optional)<input name="period" maxlength="100" placeholder="z. B. Oktober 2026" value="${htmlEscape(issue.period || '')}"></label><span class="meta">Nur ausfüllen, wenn die Ausgabe einen bestimmten Zeitraum zusammenfasst; sonst leer lassen.</span></p><label for="edit-issue">Eigener Text</label>${templatePicker(templates, 'edit-issue')}<textarea id="edit-issue" name="bodyHtml" rows="12" data-rich-editor>${htmlEscape(editorHtml(issue))}</textarea>${imagePicker('edit-issue')}<fieldset><legend>Beiträge in dieser Ausgabe</legend><p class="meta">Ausgewählte Beiträge werden beim Speichern mit ihrem aktuellen Text übernommen.</p>${choices}${missing || (!choices ? '<p>Noch keine veröffentlichten Updates vorhanden.</p>' : '')}</fieldset><fieldset><legend>Beiträge aus dem Kollegium</legend>${colleagueChoices || '<p>Keine eingereichten Beiträge vorhanden.</p>'}</fieldset><fieldset><legend>Steckbriefe in dieser Ausgabe</legend><p class="meta">Bereits angehängte Steckbriefe sind ausgewählt. Weitere übernommene Steckbriefe kannst du ergänzen.</p>${issueSourceChoices(submissions, 'submissions', selectedFiles)}</fieldset><button type="submit">Änderungen speichern</button></form>${templateSources(templates)}</section>`, 'editor.js');
}

export function issueMailPage(issue, mailConfig, csrf, appSettings, testSent = false, deliveryStatus = null) {
  const notice = issueNotice(issue, appSettings);
  const ready = mailConfig?.password && mailConfig?.testRecipient === TEST_RECIPIENT;
  const state = colleagueDeliveryEnabled(mailConfig) ? 'Kollegiumsversand ist freigegeben. Erst die separate Bestätigung unten versendet diese Ausgabe.' : ready ? 'Testmodus: Diese Mail geht ausschließlich an Marc. Der Kollegiumsversand ist gesperrt.' : 'SMTP ist noch nicht vollständig eingerichtet. Es kann keine Mail versendet werden.';
  const action = ready ? `<form method="post" action="${base}editor/issues/${Number(issue.number)}/mail-test"><input type="hidden" name="csrf" value="${csrf}"><p><label><input type="checkbox" name="confirm" value="${Number(issue.number)}" required> Testmail an ${TEST_RECIPIENT} ausdrücklich bestätigen</label></p><button type="submit">Testmail an Marc senden</button></form>` : '';
  const liveAction = deliveryStatus ? `<p role="status">Kollegiumsversand für diese Ausgabe: ${deliveryStatus === 'sent' ? 'gesendet' : 'Status unklar; nicht erneut senden'}.</p>` : colleagueDeliveryEnabled(mailConfig) ? `<form method="post" action="${base}editor/issues/${Number(issue.number)}/mail"><input type="hidden" name="csrf" value="${csrf}"><p><label><input type="checkbox" name="confirm" value="${Number(issue.number)}" required> Ausgabe ${Number(issue.number)} jetzt verbindlich an das gesamte Kollegium senden</label></p><button type="submit">Ausgabe an Kollegium senden</button></form>` : '';
  return page('Ausgaben-Mail', `<section><p><a href="${base}editor/issues/">← Ausgaben bearbeiten</a></p><h1>Mailvorschau für BBS Info ${Number(issue.number)}</h1><p><strong>Testempfänger:</strong> ${TEST_RECIPIENT}</p><p>${htmlEscape(state)}</p>${testSent ? '<p role="status">Testmail an Marc wurde versendet.</p>' : ''}<p><strong>Betreff:</strong> ${htmlEscape(notice.subject)}</p><div class="digest-mail-preview">${notice.html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] || ''}</div><details><summary>Textfassung</summary><pre class="mail-preview">${htmlEscape(notice.body)}</pre></details><p><a href="${base}editor/settings/">Mailvorlage bearbeiten →</a></p>${action}${liveAction}</section>`);
}

export function digestTestPage(updates, mailConfig, csrf, testSent = false) {
  const notice = updates.length ? digestNotice(updates) : null;
  const ready = mailConfig?.password && mailConfig?.testRecipient === TEST_RECIPIENT;
  const action = ready && notice ? `<form method="post" action="${base}editor/digest/send-test"><input type="hidden" name="csrf" value="${csrf}"><p><label><input type="checkbox" name="confirm" value="yes" required> Testmail ausschließlich an ${TEST_RECIPIENT} ausdrücklich bestätigen</label></p><button type="submit">Sammelmail an Marc testen</button></form>` : '';
  return page('Sammelmailvorschau', `<section><p><a href="${base}editor/settings/">← Einstellungen</a></p><h1>Update-Sammelmail testen</h1><p>Diese Vorschau verwendet die neuesten ${updates.length} veröffentlichten Updates (höchstens 50). Ein Testversand erfolgt nur nach Bestätigung und ausschließlich an Marc. Persönliche Abos werden unabhängig von diesem Test nach der gewählten Einstellung versendet. Der Kollegiumsverteiler bleibt gesperrt.</p><p><strong>Testempfänger:</strong> ${TEST_RECIPIENT}</p>${testSent ? '<p role="status">Testmail an Marc wurde versendet.</p>' : ''}${notice ? `<p><strong>Betreff:</strong> ${htmlEscape(notice.subject)}</p><div class="digest-mail-preview" aria-label="Vorschau der HTML-Sammelmail">${notice.html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] || ''}</div><details><summary>Textfassung für Mailprogramme ohne HTML</summary><pre class="mail-preview">${htmlEscape(notice.body)}</pre></details>` : '<p>Keine veröffentlichten Updates vorhanden.</p>'}${!ready ? '<p>SMTP-Testversand ist noch nicht eingerichtet.</p>' : ''}${action}</section>`);
}

function trashContents(trash, csrf, editor = false, settings = false) {
  const groups = [
    ...(editor ? [['updates', 'update', 'Updates']] : []),
    ...(editor ? [['issues', 'issue', 'Ausgaben']] : []),
    ['contributions', 'contribution', editor ? 'Beiträge aus dem Kollegium' : 'Meine Beiträge'],
    ['submissions', 'submission', editor ? 'Steckbriefe aus dem Kollegium' : 'Meine Steckbriefe'],
  ];
  const pageNumber = trash.page || 1;
  const href = (number) => settings ? `${base}editor/settings/?tab=trash&page=${number}` : `${base}trash/?page=${number}`;
  const pager = pageNumber > 1 || trash.hasNext ? `<nav class="pagination" aria-label="Papierkorb-Seiten">${pageNumber > 1 ? `<a href="${href(pageNumber - 1)}">← Zurück</a>` : ''}<span>Seite ${pageNumber}</span>${trash.hasNext ? `<a href="${href(pageNumber + 1)}">Weiter →</a>` : ''}</nav>` : '';
  const itemHtml = (item, kind) => {
    const owner = editor && ['contribution', 'submission'].includes(kind) ? ` · von ${htmlEscape(item.ownerName || 'Name nicht erfasst')}` : '';
    const preview = kind === 'contribution' ? `<details><summary>Beitrag ansehen</summary>${renderBody(item)}</details>` : kind === 'submission' ? `<p><a href="${base}trash/submissions/${Number(item.id)}/file">Datei herunterladen</a></p>` : '';
    return `<li class="editor-item"><strong>${item.number ? `BBS Info ${Number(item.number)} · ` : ''}${htmlEscape(item.title)}</strong><p class="meta">Gelöscht: ${htmlEscape(publishedDateTime({ publishedAtUtc: item.deletedAtUtc }))} Uhr${owner}${item.status ? ` · ${item.status === 'published' ? 'Veröffentlicht' : 'Entwurf'}` : ''}</p>${preview}<form method="post" action="${base}trash/restore"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="id" value="${Number(item.id)}"><button type="submit" class="secondary">Wiederherstellen</button></form></li>`;
  };
  return `<p>Gelöschte Inhalte können 30 Tage lang wiederhergestellt werden. Danach werden sie automatisch endgültig entfernt. Ausgabennummern bleiben bis dahin reserviert. Wiederhergestellte veröffentlichte Updates lösen keine neue persönliche E-Mail aus.</p>${groups.map(([key, kind, label]) => `<h2>${label}</h2>${trash[key]?.length ? `<ul class="editor-items">${trash[key].map((item) => itemHtml(item, kind)).join('')}</ul>` : '<p>Keine Einträge.</p>'}`).join('')}${pager}`;
}

export function trashPage(trash, csrf, editor = false) {
  return personalPage('trash', trashContents(trash, csrf, editor), '', true, true);
}

export function settingsPage(settings, csrf, tab = 'issues', templates = [], canManageEditors = false, editorGrants = [], trash = null) {
  const tabs = [
    ['issues', 'Ausgaben-Mail'],
    ['updates', 'Update-Mails'],
    ['templates', 'Textbausteine'],
    ['trash', 'Papierkorb'],
  ];
  if (canManageEditors) tabs.push(['editors', 'Redaktion']);
  const active = tabs.some(([key]) => key === tab) ? tab : 'issues';
  const navigation = `<nav class="settings-tabs" aria-label="Einstellungsbereiche">${tabs.map(([key, label]) => `<a href="${base}editor/settings/?tab=${key}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  const issuePanel = `<h2>Ausgaben-Mail</h2><p>Im Pilotbetrieb wird bei Veröffentlichung automatisch eine Testmail ausschließlich an Marc gesendet. Der Kollegiumsversand bleibt gesperrt.</p><form method="post" action="${base}editor/settings/save"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="settingsTab" value="issues"><p><label>Betreff<input name="mailSubject" maxlength="200" required value="${htmlEscape(settings.mailSubject)}"></label></p><p><label>Mailtext<textarea name="mailBody" rows="12" maxlength="5000" required>${htmlEscape(settings.mailBody)}</textarea></label></p><p class="meta">Platzhalter: {nummer}, {titel}, {datum}, {link}, {schuljahr}, {inhalt}. {link} muss im Text enthalten sein.</p><p><button type="submit">Mailvorlage speichern</button></p></form>`;
  const updatePanel = `<h2>Update-Mails</h2><p>Kolleginnen und Kollegen wählen selbst zwischen sofortiger E-Mail, täglicher Sammelmail um 18:00 Uhr, wöchentlicher Sammelmail montags um 07:00 Uhr und keiner Benachrichtigung.</p><form method="post" action="${base}editor/settings/save"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="settingsTab" value="updates"><p><label>Wöchentliche Sammelmail<select name="digestCadence"><option value="every_monday"${settings.digestCadence !== 'disabled' ? ' selected' : ''}>Montags um 07:00 Uhr</option><option value="disabled"${settings.digestCadence === 'disabled' ? ' selected' : ''}>Pausieren</option></select></label></p><p class="meta">Persönliche Update-Mails gehen an angemeldete Konten mit Schuladresse und aktivem Abo. Der Kollegiumsverteiler bleibt gesperrt.</p><p><button type="submit">Rhythmus speichern</button></p></form><p><a href="${base}editor/digest/">Sammelmailvorschau und Testversand an Marc →</a></p>`;
  const editorRows = editorGrants.length ? `<ul class="editor-items">${editorGrants.map((grant) => `<li class="editor-item"><strong>${htmlEscape(grant.name || grant.email)}</strong>${grant.name ? `<span class="meta">${htmlEscape(grant.email)}</span>` : ''}<span class="meta">${grant.userUuid ? 'Aktiv nach IServ-Anmeldung' : 'Wartet auf passende IServ-Anmeldung'}</span><details><summary class="delete-x"><span aria-hidden="true">×</span> Löschen</summary><form method="post" action="${base}editor/settings/editors/remove"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="email" value="${htmlEscape(grant.email)}"><label><input type="checkbox" name="confirm" value="${htmlEscape(grant.email)}" required> Redaktionsrecht für ${htmlEscape(grant.email)} entfernen</label><button type="submit" class="secondary">Entfernen bestätigen</button></form></details></li>`).join('')}</ul>` : '<p>Noch keine zusätzlichen Redakteure eingetragen.</p>';
  const editorsPanel = `<h2>Redaktion</h2><p>Zusätzliche Redakteure erhalten Zugriff auf Beiträge, Ausgaben und Textbausteine. Audit-Log und Nutzungsstatistik bleiben ausschließlich für Marc sichtbar.</p><form method="post" action="${base}editor/settings/editors/add"><input type="hidden" name="csrf" value="${csrf}"><label>IServ-E-Mail-Adresse<input type="email" name="email" required maxlength="254" placeholder="name@school.example"></label><p><button type="submit">Redakteur hinzufügen</button></p></form><h3>Zusätzliche Redakteure</h3>${editorRows}<p class="meta">Ein neues Konto wird erst nach Anmeldung mit seiner passenden IServ-Adresse und Mitgliedschaft in „Kollegium“ freigeschaltet. Bereits in der geschützten Serverkonfiguration hinterlegte Redaktionskonten bleiben unabhängig von dieser Liste bestehen.</p>`;
  const content = active === 'issues' ? issuePanel : active === 'updates' ? updatePanel : active === 'editors' ? editorsPanel : active === 'trash' ? trashContents(trash || { updates: [], issues: [], contributions: [], submissions: [] }, csrf, true, true) : templateSettingsPanel(templates, csrf);
  return page('Einstellungen', `<section class="settings-page"><p><a href="${base}">← Zur Startseite</a></p><span class="eyebrow">REDAKTION · EINSTELLUNGEN</span><h1>Einstellungen</h1>${navigation}<div class="settings-panel" id="settings-content">${content}</div></section>`, active === 'templates' ? 'editor.js' : '');
}

const actionLabels = {
  'session.login': 'Angemeldet', 'session.logout': 'Abgemeldet', 'page.view': 'Seite geöffnet',
  'auth.access_denied': 'IServ hat Anmeldung abgelehnt', 'auth.oidc_error': 'IServ-Anmeldung fehlgeschlagen', 'auth.identity_denied': 'Keine BBS-Info-Berechtigung', 'auth.session_unavailable': 'Anmeldung nicht verfügbar', 'auth.login_start_failed': 'IServ-Anmeldung nicht gestartet', 'auth.finalize_failed': 'Anmeldung nicht abgeschlossen',
  'archive.list': 'Archiv geöffnet', 'archive.search': 'Archiv durchsucht', 'archive.pdf': 'PDF geöffnet',
  'search.perform': 'Suche ausgeführt', 'issue.view': 'Ausgabe geöffnet', 'issue.pdf': 'Ausgabe als PDF geöffnet',
  'update.create': 'Update angelegt', 'update.edit': 'Entwurf bearbeitet', 'update.correct': 'Update korrigiert', 'update.published_edit': 'Update bearbeitet', 'update.publish': 'Update veröffentlicht', 'update.history': 'Versionen angesehen',
  'update.delete': 'Update in den Papierkorb verschoben', 'update.restore': 'Update wiederhergestellt', 'update.purge': 'Update endgültig entfernt',
  'issue.create': 'Ausgabe angelegt', 'issue.publish': 'Ausgabe veröffentlicht', 'issue.mail_preview': 'Mailvorschau geöffnet', 'issue.mail_test_start': 'Testmail an Marc gestartet', 'issue.mail_test': 'Testmail an Marc versendet', 'issue.mail_start': 'Mailversand gestartet', 'issue.mail_sent': 'Mail versendet', 'issue.mail_uncertain': 'Mailstatus unklar', 'digest.preview': 'Sammelmailvorschau geöffnet', 'digest.test_start': 'Sammelmail-Test an Marc gestartet', 'digest.test_sent': 'Sammelmail-Test an Marc gesendet',
  'update.mail_start': 'Persönliche Update-Mail vorbereitet', 'update.mail_sent': 'Persönliche Update-Mail beim Mailserver abgegeben', 'update.mail_uncertain': 'Status der persönlichen Update-Mail unklar',
  'issue.edit': 'Ausgabe bearbeitet', 'issue.delete': 'Ausgabe in den Papierkorb verschoben', 'issue.restore': 'Ausgabe wiederhergestellt', 'issue.purge': 'Ausgabe endgültig entfernt', 'issue.draft_delete': 'Ausgabenentwurf in den Papierkorb verschoben', 'issue.draft_restore': 'Ausgabenentwurf wiederhergestellt', 'issue.draft_purge': 'Ausgabenentwurf endgültig entfernt',
  'subscription.enable': 'Abo eingeschaltet', 'subscription.disable': 'Abo ausgeschaltet',
  'contribution.submit': 'Kollegenbeitrag eingereicht', 'contribution.edit': 'Kollegenbeitrag geändert', 'contribution.delete': 'Kollegenbeitrag in den Papierkorb verschoben', 'contribution.restore': 'Kollegenbeitrag wiederhergestellt', 'contribution.purge': 'Kollegenbeitrag endgültig entfernt', 'contribution.take_over': 'Kollegenbeitrag übernommen',
  'submission.create': 'Steckbrief hochgeladen', 'submission.replace': 'Steckbrief ersetzt', 'submission.delete': 'Steckbrief in den Papierkorb verschoben', 'submission.restore': 'Steckbrief wiederhergestellt', 'submission.purge': 'Steckbrief endgültig entfernt', 'submission.take_over': 'Steckbrief übernommen', 'submission.file': 'Steckbrief geöffnet', 'submission.published_file': 'Veröffentlichten Steckbrief geöffnet',
  'image.upload': 'Bild hochgeladen', 'image.view': 'Bild geöffnet',
  'template.create': 'Textbaustein angelegt', 'template.edit': 'Textbaustein bearbeitet', 'settings.edit': 'Einstellungen bearbeitet',
  'editor.grant': 'Redaktionsrecht vergeben', 'editor.bind': 'Redaktionsrecht an Konto gebunden', 'editor.revoke': 'Redaktionsrecht entzogen',
  'audit.export': 'Audit exportiert', 'access.denied': 'Zugriff verweigert',
};
const automaticMailActions = new Set(['update.mail_start', 'update.mail_sent', 'update.mail_uncertain']);
function auditActorName(row) {
  if (automaticMailActions.has(row.action)) return 'BBS Info';
  return row.actorUuid === null ? 'Ohne zugeordnete Person' : row.actorName || 'Name noch nicht erfasst';
}
const pageLabels = { home: 'Startseite', updates: 'Updates', issues: 'Ausgaben', contributions: 'Meine Beiträge', trash: 'Papierkorb', stats: 'Nutzungsstatistik', audit: 'Audit-Log', editor: 'Redaktion', 'editor.issues': 'Ausgaben-Redaktion', 'editor.templates': 'Textbausteine', submissions: 'Steckbriefe' };
function objectLabel(row) {
  if (row.objectType === 'auth') return 'IServ-Anmeldung';
  if (row.objectType === 'page') return pageLabels[row.objectId] || row.objectId || 'Seite';
  if (row.objectType === 'archive') return row.objectId ? `BBS Info ${row.objectId}` : 'Historisches Archiv';
  if (row.objectType === 'issue') {
    if (['issue.create', 'issue.draft_delete', 'issue.draft_restore', 'issue.draft_purge'].includes(row.action)) return row.objectTitle ? `Ausgabenentwurf: ${row.objectTitle}` : 'Ausgabenentwurf';
    return row.objectTitle ? `BBS Info ${row.objectId}: ${row.objectTitle}` : `BBS Info ${row.objectId}`;
  }
  if (row.objectType === 'update') return row.objectTitle ? `Update: ${row.objectTitle}` : 'Update';
  if (row.objectType === 'contribution') return row.objectTitle ? `Kollegenbeitrag: ${row.objectTitle}` : 'Kollegenbeitrag';
  if (row.objectType === 'submission') return row.objectTitle ? `Steckbrief: ${row.objectTitle}` : `Steckbrief ${row.objectId}`;
  if (row.objectType === 'image') return 'Redaktionsbild';
  if (row.objectType === 'template') return `Textbaustein ${row.objectId}`;
  if (row.objectType === 'editor') return row.objectTitle || 'Redaktionskonto';
  if (row.objectType === 'subscription') return automaticMailActions.has(row.action) ? row.objectTitle || 'Empfängername nicht erfasst' : 'Update-Abo';
  if (row.objectType === 'search') return 'Suche';
  return row.objectId || '';
}
function objectHref(row) {
  const id = String(row.objectId || '');
  const numericId = /^[1-9][0-9]*$/.test(id) ? id : null;
  if (row.objectType === 'archive') return row.action === 'archive.pdf' && numericId ? `${base}archive/${numericId}.pdf` : `${base}archive/`;
  if (row.objectType === 'issue') {
    if (numericId && ['issue.view', 'issue.publish', 'issue.edit', 'issue.restore', 'issue.mail_preview', 'issue.mail_test_start', 'issue.mail_test', 'issue.mail_start', 'issue.mail_sent', 'issue.mail_uncertain'].includes(row.action)) return `${base}issues/${numericId}`;
    return `${base}editor/issues/`;
  }
  if (row.objectType === 'update') {
    if (numericId && ['update.publish', 'update.correct', 'update.published_edit', 'update.view'].includes(row.action)) return `${base}updates/${numericId}`;
    return `${base}editor/`;
  }
  if (row.objectType === 'contribution') return `${base}editor/`;
  if (row.objectType === 'submission') {
    if (row.action === 'submission.delete') return `${base}submissions/`;
    if (numericId && row.action === 'submission.published_file') return `${base}media/${numericId}`;
    return numericId ? `${base}submissions/${numericId}/file` : `${base}submissions/`;
  }
  if (row.objectType === 'template') return `${base}editor/templates/`;
  if (row.objectType === 'image' && /^[0-9a-f-]{36}$/.test(row.imageName || '')) return `${base}editor-images/${row.imageName}`;
  if (row.objectType === 'page') {
    const pages = { home: '', updates: 'updates/', issues: 'issues/', stats: 'stats/', audit: 'audit/', editor: 'editor/', 'editor.issues': 'editor/issues/', 'editor.templates': 'editor/templates/', submissions: 'submissions/' };
    if (Object.hasOwn(pages, id)) return `${base}${pages[id]}`;
  }
  if (row.objectType === 'search') return `${base}search/`;
  return null;
}
function objectCell(row) {
  const label = htmlEscape(objectLabel(row));
  const href = objectHref(row);
  return href ? `<a href="${href}">${label} ↗</a>` : label;
}
function localDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value || '')) return String(value || '');
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(`${value.replace(' ', 'T')}Z`));
}
function auditHealthNotice(status) {
  if (!status) return '';
  if (status.unavailable) return '<div class="admin-health-warning" role="alert"><strong>Audit-Status nicht prüfbar</strong><p>Der private Prüfstatus konnte nicht gelesen werden. Bitte den Dienst und das Serverprotokoll prüfen.</p></div>';
  const date = typeof status.occurredAt === 'string' && Number.isFinite(Date.parse(status.occurredAt))
    ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(status.occurredAt))
    : 'Zeitpunkt unbekannt';
  const message = status.category === 'audit.capacity_warning'
    ? 'Der Speicherplatz für das Audit war knapp. Bitte die Kapazität prüfen.'
    : 'Beim Speichern eines Auditereignisses trat ein Fehler auf. Ereignisse könnten fehlen; bitte Datenbank und Serverprotokoll prüfen.';
  return `<div class="admin-health-warning" role="alert"><strong>Audit-Erfassung prüfen</strong><p>${htmlEscape(message)} Erstmals festgestellt: ${htmlEscape(date)}. Der Hinweis bleibt bis zur manuellen Prüfung bestehen.</p></div>`;
}
export function auditPage(result, filters = {}, auditHealth = null) {
  const { events, page: pageNumber, pageCount, hasMore, through } = result;
  const params = new URLSearchParams();
  for (const key of ['actor', 'action', 'object', 'from', 'to']) if (filters[key]) params.set(key, filters[key]);
  const scoped = params.toString();
  const rows = events.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Zeit (Berlin)</th><th>Vorgang</th><th>Bereich</th><th>Person</th></tr></thead><tbody>${events.map((row) => `<tr><td class="time">${htmlEscape(localDateTime(row.occurredAt))}</td><td>${htmlEscape(actionLabels[row.action] || row.action)}</td><td>${objectCell(row)}</td><td><strong>${htmlEscape(auditActorName(row))}</strong></td></tr>`).join('')}</tbody></table></div>` : '<p>Für diese Auswahl gibt es keine Ereignisse.</p>';
  const paginationLink = (number) => `${base}audit/?${scoped ? `${scoped}&` : ''}page=${number}${through ? `&through=${encodeURIComponent(through)}` : ''}`;
  const pagination = numberedPager(pageNumber, pageCount || (hasMore ? pageNumber + 1 : pageNumber), paginationLink, 'Audit-Seiten');
  const exportLink = `${base}audit/export.csv${scoped ? `?${scoped}` : ''}`;
  const options = Object.entries(actionLabels).map(([key, label]) => `<option value="${key}"${filters.action === key ? ' selected' : ''}>${htmlEscape(label)}</option>`).join('');
  return page('Audit-Log', `<section><p><a href="${base}">← Zur Startseite</a></p><span class="eyebrow">NUR ADMINISTRATION</span><h1>Audit-Log</h1><p class="admin-lead">Anmeldungen, Aufrufe und Änderungen. Zeiten werden in Berliner Ortszeit angezeigt.</p>${auditHealthNotice(auditHealth)}<form method="get" action="${base}audit/" class="filter-form"><label>Person<br><input name="actor" value="${htmlEscape(filters.actor || '')}" maxlength="100" placeholder="Name suchen"></label><label>Vorgang<br><select name="action"><option value="">Alle Vorgänge</option>${options}</select></label><label>Objekt<br><input name="object" value="${htmlEscape(filters.object || '')}" maxlength="100" placeholder="Titel oder Nummer"></label><label>Von (Berlin)<br><input type="date" name="from" value="${htmlEscape(filters.from || '')}"></label><label>Bis (Berlin)<br><input type="date" name="to" value="${htmlEscape(filters.to || '')}"></label><button type="submit">Filtern</button></form><p>${events.length} Ereignisse auf dieser Seite · <a href="${htmlEscape(exportLink)}">Bis zu 1000 als CSV exportieren</a></p>${rows}${pagination}</section>`);
}

export function auditCsv(events) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [['id', 'utc', 'iserv_name', 'iserv_uuid', 'action', 'object_type', 'object_id', 'object_title'], ...events.map((row) => [row.id, row.occurredAt, automaticMailActions.has(row.action) ? 'BBS Info' : row.actorName, row.actorUuid, row.action, row.objectType, row.objectId, row.objectTitle])];
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function statsPage(report, pageNumber = 1, auditHealth = null) {
  const rows = report.daily;
  const total = rows.reduce((sum, row) => sum + Number(row.eventCount), 0);
  const count = (...actions) => rows.filter((row) => actions.includes(row.action)).reduce((sum, row) => sum + Number(row.eventCount), 0);
  const byDay = new Map();
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) || 0) + Number(row.eventCount));
  const daily = [...byDay].slice(0, report.days);
  const pageSize = 14;
  const pageCount = Math.max(1, Math.ceil(daily.length / pageSize));
  const shown = daily.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
  const max = Math.max(...daily.map(([, value]) => value), 1);
  const chart = daily.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Tag</th><th colspan="2">Ereignisse</th></tr></thead><tbody>${shown.map(([day, value]) => `<tr><td>${htmlEscape(day)}</td><td class="chart-cell"><meter min="0" max="${max}" value="${value}" aria-label="${htmlEscape(day)}: ${value} Ereignisse">${value}</meter></td><td class="count">${value}</td></tr>`).join('')}</tbody></table></div>${numberedPager(pageNumber, pageCount, (number) => `${base}stats/?days=${report.days}&page=${number}`, 'Statistik-Seiten')}` : '<p>In diesem Zeitraum gibt es noch keine erfassten Ereignisse.</p>';
  const top = report.topContent.length ? `<ol class="admin-list">${report.topContent.map((row) => `<li><span>${objectCell(row)}</span><strong>${Number(row.eventCount)} Aufrufe</strong></li>`).join('')}</ol>` : '<p>Noch keine geöffneten Ausgaben oder Dateien.</p>';
  const topSearch = report.searchTerms?.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Suchbegriff</th><th>Anzahl</th></tr></thead><tbody>${report.searchTerms.map((row) => `<tr><td>${htmlEscape(row.term)}</td><td class="count">${Number(row.eventCount)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Noch keine Suchbegriffe erfasst.</p>';
  const peopleSearch = report.searchPeople?.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Person</th><th>Suchbegriff</th><th>Anzahl</th><th>Zuletzt (Berlin)</th></tr></thead><tbody>${report.searchPeople.map((row) => `<tr><td>${htmlEscape(row.person)}</td><td>${htmlEscape(row.term)}</td><td class="count">${Number(row.eventCount)}</td><td>${htmlEscape(publishedDateTime({ publishedAtUtc: row.lastAtUtc }))}</td></tr>`).join('')}</tbody></table></div>` : '';
  const periods = [7, 30, 90].map((days) => `<a href="${base}stats/?days=${days}"${days === report.days ? ' aria-current="page"' : ''}>${days} Tage</a>`).join('');
  return page('Nutzungsstatistik', `<section><p><a href="${base}">← Zur Startseite</a></p><span class="eyebrow">NUR ADMINISTRATION</span><h1>Nutzungsstatistik</h1><p class="admin-lead">Nutzung der vergangenen ${report.days} Tage. Ein Aufruf belegt keine tatsächliche Kenntnisnahme.</p>${auditHealthNotice(auditHealth)}<nav class="year-nav" aria-label="Zeitraum wählen">${periods}</nav><div class="admin-summary"><div><strong>${report.activeUsers}</strong><span>aktive IServ-Konten</span></div><div><strong>${count('session.login')}</strong><span>Anmeldungen</span></div><div><strong>${count('archive.pdf', 'issue.view')}</strong><span>Ausgaben geöffnet</span></div><div><strong>${count('search.perform', 'archive.search')}</strong><span>Suchvorgänge</span></div><div><strong>${report.subscriptions}</strong><span>aktive Update-Abos</span></div><div><strong>${total}</strong><span>Ereignisse insgesamt</span></div></div><h2>Verlauf</h2>${chart}<h2 class="subsection-title">Häufig geöffnete Inhalte</h2>${top}<h2 class="subsection-title">Häufigste Suchbegriffe</h2>${topSearch}<h2 class="subsection-title">Wer hat wonach gesucht?</h2><p class="meta">Personenbezogene Suchanfragen werden nach 90 Tagen gelöscht. Diese Auswertung ist nur für die Administration sichtbar.</p>${peopleSearch}</section>`);
}

export function submissionsPage(own, all, csrf, editor, contributionsAvailable = true) {
  const ownItems = own.length ? `<ul class="editor-items">${own.map((item) => editorListItem({
    title: item.title,
    href: `${base}submissions/${Number(item.id)}/file`,
    meta: `${item.createdAt || ''} Uhr · ${item.status === 'taken_over' ? 'Von der Redaktion übernommen' : 'Eingereicht'}`,
    actions: item.status === 'submitted' ? `<details><summary class="editor-edit-action">Einreichung ändern</summary><form method="post" action="${base}submissions/replace" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(item.id)}"><p><label>Titel<br><input name="title" required maxlength="200" value="${htmlEscape(item.title)}"></label></p><p><label>Anmerkung<br><textarea name="note" maxlength="1000">${htmlEscape(item.note || '')}</textarea></label></p><p><label>Neue PDF- oder Bilddatei<br><input type="file" name="file" required accept="application/pdf,image/jpeg,image/png,image/webp"></label></p><button type="submit">Änderung speichern</button></form></details>${deleteControl({ action: 'submissions/delete', field: 'id', id: item.id, title: item.title, kind: 'Steckbrief', csrf })}` : '',
  })).join('')}</ul>` : '<p>Noch keine eigenen Steckbriefe.</p>';
  const allItems = editor ? `<h2>Alle Einreichungen</h2>${all.length ? `<ol>${all.map((item) => `<li><a href="${base}submissions/${Number(item.id)}/file">${htmlEscape(item.title)}</a> · ${htmlEscape(item.ownerName || 'Name noch nicht erfasst')} · ${htmlEscape(item.createdAt || '')} Uhr · ${item.status === 'taken_over' ? 'Übernommen' : 'Eingereicht'}${item.status === 'submitted' ? `<div class="editor-row-actions"><form method="post" action="${base}submissions/take-over"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${Number(item.id)}"><button type="submit">Redaktionell übernehmen</button></form>${deleteControl({ action: 'editor/submissions/delete', field: 'id', id: item.id, title: item.title, kind: 'Steckbrief', csrf })}</div>` : ''}</li>`).join('')}</ol>` : '<p>Keine Einreichungen vorhanden.</p>'}` : '';
  return personalPage('submissions', `<p>Einreichungen sind zunächst nur für dich und die Redaktion sichtbar.</p><h2>Neuen Steckbrief einreichen</h2><form method="post" action="${base}submissions/upload" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${csrf}"><p><label>Titel<br><input name="title" required maxlength="200"></label></p><p><label>Anmerkung (optional)<br><textarea name="note" maxlength="1000" rows="3"></textarea></label></p><p><label>PDF oder Bild (JPEG, PNG, WebP; höchstens 10 MB)<br><input type="file" name="file" required accept="application/pdf,image/jpeg,image/png,image/webp"></label></p><button type="submit">Privat einreichen</button></form><h2>Eigene Einreichungen</h2>${ownItems}${allItems}`, '', contributionsAvailable, true);
}

export function archivePage(store, query, selectedYear) {
  const issues = store.list();
  const searching = query.trim().length > 0;
  const results = searching ? store.search(query) : [];
  const years = [...new Set(issues.map((issue) => issue.schoolYear || 'Ohne Jahr'))];
  const year = years.includes(selectedYear) ? selectedYear : years[0];
  const shown = issues.filter((issue) => (issue.schoolYear || 'Ohne Jahr') === year);
  const form = `<form method="get" action="${base}archive/"><label class="visually-hidden" for="query">Archiv durchsuchen</label><input id="query" name="q" maxlength="200" value="${htmlEscape(query)}" placeholder="Name oder Stichwort im Archiv"><button type="submit">Suchen</button></form>`;
  const resultsHtml = searching ? `<h2>Suchergebnisse (${results.length}${results.length === 50 ? '+' : ''})</h2>${results.length ? `<div>${results.map((row) => `<div class="archive-result"><a href="${base}archive/${Number(row.archiveId)}.pdf" target="_blank" rel="noopener noreferrer">BBS Info ${Number(row.number)}, Seite ${Number(row.page)} →</a>${row.excerpt ? `<p>${htmlEscape(row.excerpt)}</p>` : ''}</div>`).join('')}</div>` : '<p>Keine Treffer in den indizierten Texten.</p>'}<hr>` : '';
  const yearsHtml = `<nav class="year-nav" aria-label="Schuljahr wählen">${years.map((value) => `<a href="${base}archive/?year=${encodeURIComponent(value)}"${value === year ? ' aria-current="page"' : ''}>${htmlEscape(value)}</a>`).join('')}</nav>`;
  const tiles = `<div class="archive-grid">${shown.map((issue) => `<a class="archive-tile" href="${base}archive/${Number(issue.number)}.pdf" target="_blank" rel="noopener noreferrer"><span class="archive-cover"><img src="${base}archive/${Number(issue.number)}/thumbnail.webp" alt="" loading="lazy" width="260" height="370"></span><strong>BBS Info ${Number(issue.number)}</strong><small>${Number(issue.pageCount)} Seiten${issue.period ? ` · ${htmlEscape(issue.period)}` : ''}</small></a>`).join('')}</div>`;
  return page('Historisches Archiv', `<section><p><a href="${base}">← Zur Startseite</a></p><span class="eyebrow">BBS INFO · ARCHIV</span><h1>Historische Ausgaben</h1><p>Alle ${issues.length} Originalausgaben im Archiv. Die Suche berücksichtigt auch erkannte Texte aus Scans.</p><div class="archive-toolbar">${form}</div>${resultsHtml}<h2>Schuljahr ${htmlEscape(year)}</h2>${yearsHtml}${tiles}</section>`);
}
