import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultAppSettings, validateAppSettings } from '../backend/app-settings.mjs';
import { issueNotice } from '../backend/mail.mjs';
import { renderIssuePdf } from '../backend/issue-pdf.mjs';
import { countPdfPages, renderPdfPage } from '../backend/submission-preview.mjs';

test('Mailvorlage wird ersetzt und Kopfzeilen bleiben einzeilig', () => {
  const settings = validateAppSettings({ ...defaultAppSettings, mailSubject: 'Ausgabe {nummer}: {titel}', mailBody: 'Hier lesen: {link}' });
  const notice = issueNotice({ number: 93, title: 'Neue\nKollegin', publishedAt: '27.10.2026' }, settings);
  assert.equal(notice.subject, 'Ausgabe 93: Neue Kollegin');
  assert.match(notice.body, /https:\/\/apps\.school\.example\/bbsinfo\/issues\/93/);
  assert.throws(() => validateAppSettings({ ...settings, mailSubject: 'A\nB' }));
  assert.throws(() => validateAppSettings({ ...settings, mailBody: 'Ohne Link' }));
});

test('Ausgaben-Mail zeigt editierbare Vorlage, Themen und Leselink jeweils nur einmal', () => {
  const notice = issueNotice({ number: 94, title: 'Herbst', publishedAt: '28.10.2026', updates: [{ title: 'Personalrat' }] });
  assert.equal((notice.html.match(/Personalrat/g) || []).length, 1);
  assert.equal((notice.html.match(/In dieser Ausgabe:/g) || []).length, 1);
  assert.equal((notice.html.match(/Ausgabe lesen/g) || []).length, 1);
  assert.doesNotMatch(notice.html, /Die Ausgabe steht hier bereit/);
  const custom = issueNotice({ number: 94, title: 'Herbst', updates: [{ title: 'Personalrat' }] }, { ...defaultAppSettings, mailBody: 'Hallo Team,\n\n{inhalt}\n\nBitte hier lesen: {link}' });
  assert.match(custom.html, /Hallo Team/);
  assert.match(custom.html, /Bitte hier lesen:/);
  assert.equal((custom.html.match(/Personalrat/g) || []).length, 1);
});

test('Veröffentlichte Ausgabe wird als eigenständiges PDF erzeugt', async () => {
  const pdf = await renderIssuePdf({ number: 93, title: 'Neue Kollegin', publishedAt: '27.10.2026', schoolYear: '2026/27', bodyHtml: '<p>Willkommen <strong>im Kollegium</strong>.</p><table><tr><th>Name</th><th>Abteilung</th></tr><tr><td>Bittner</td><td>SPH</td></tr></table>', updates: [{ title: 'Personalrat', bodyHtml: '<p>Neue Informationen.</p>' }], attachments: [] }, null);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 2000);
});

test('Kollegenbeitrag erscheint namentlich in Mail und PDF der Ausgabe', async () => {
  const issue = { number: 93, title: 'Berichte', body: '', updates: [], contributions: [{ title: 'Projektwoche', body: 'Bericht aus der Klasse', author: 'Lea Test' }], attachments: [] };
  const notice = issueNotice(issue, defaultAppSettings);
  assert.match(notice.body, /Projektwoche/);
  assert.match(notice.html, /Projektwoche/);
  const pdf = await renderIssuePdf(issue, null);
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-author-'));
  try {
    const file = join(root, 'issue.pdf');
    writeFileSync(file, pdf);
    const extracted = spawnSync('/usr/bin/python3', ['-I', '-c', 'from pypdf import PdfReader; import sys; print(" ".join(p.extract_text() or "" for p in PdfReader(sys.argv[1]).pages))', file], { encoding: 'utf8' });
    assert.equal(extracted.status, 0);
    assert.match(extracted.stdout, /Projektwoche/);
    assert.match(extracted.stdout, /von Lea Test/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PDF- und Bild-Steckbriefe sind echte Seiten der Ausgabe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-embedded-'));
  const pdfName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const imageName = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    const portrait = await renderIssuePdf({ number: 1, title: 'Steckbrief', updates: [], attachments: [], body: 'Ich stelle mich vor.' }, null);
    writeFileSync(join(root, pdfName), portrait, { mode: 0o600 });
    writeFileSync(join(root, imageName), readFileSync(new URL('../design/web/logo-mappe.png', import.meta.url)), { mode: 0o600 });
    const issue = { number: 93, title: 'Kollegium', updates: [], attachments: [
      { title: 'Steckbrief als PDF', mediaType: 'application/pdf', storedName: pdfName },
      { title: 'Steckbrief als Bild', mediaType: 'image/png', storedName: imageName },
    ] };
    const combined = await renderIssuePdf(issue, null, root);
    const output = join(root, 'ausgabe.pdf');
    writeFileSync(output, combined);
    assert.equal(await countPdfPages(output), 3);
    const preview = await renderPdfPage(join(root, pdfName), 1);
    assert.equal(preview.subarray(0, 4).toString(), 'RIFF');
    assert.equal(preview.subarray(8, 12).toString(), 'WEBP');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Großes Redaktionsbild bläht die Ausgaben-PDF nicht unnötig auf', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bbsinfo-image-pdf-'));
  const name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  try {
    const generated = spawnSync('/usr/bin/python3', ['-I', '-c', 'from PIL import Image; import sys; Image.effect_noise((2400, 2400), 30).convert("RGB").save(sys.argv[1], format="JPEG", quality=85)', join(root, name)]);
    assert.equal(generated.status, 0);
    const pdf = await renderIssuePdf({ number: 93, title: 'Bildtest', updates: [], attachments: [], bodyHtml: `<p><img src="/bbsinfo/editor-images/${name}" style="width:420px"></p>` }, root);
    assert.ok(pdf.length < 3 * 1024 * 1024, `Ausgaben-PDF ist ${pdf.length} Byte groß`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
