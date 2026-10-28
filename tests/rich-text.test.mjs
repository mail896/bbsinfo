import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRichText, plainFromHtml } from '../backend/rich-text.mjs';

test('Formatierungen bleiben erhalten und Suchtext enthält keine HTML-Tags', () => {
  const result = cleanRichText('<h2>Neue Kollegin</h2><p>Hallo &amp; <strong>willkommen</strong>.</p><ul><li>SPH</li></ul><table><tr><td>Start</td><td>Oktober</td></tr></table>');
  assert.match(result.html, /<h2>Neue Kollegin<\/h2>/);
  assert.match(result.html, /<strong>willkommen<\/strong>/);
  assert.match(result.html, /<table>/);
  assert.match(result.plain, /Hallo & willkommen/);
  assert.doesNotMatch(result.plain, /<\/?[a-z]/i);
});

test('Skripte, Ereignisattribute, fremde Bilder und gefährliche Links werden entfernt', () => {
  const result = cleanRichText('<p style="text-align:center;position:fixed" onclick="bad()">Text<script>bad()</script><img src="https://outside.invalid/a.png"><a href="javascript:bad()" onclick="bad()">Link</a><a href="https://school.example/">Schule</a></p>');
  assert.match(result.html, /text-align:center/);
  assert.match(result.html, /href="https:\/\/school\.example\/"/);
  assert.doesNotMatch(result.html, /script|onclick|position:fixed|<img|javascript:/i);
  assert.equal(result.plain, 'TextLinkSchule');
});

test('Leere Formatierung zählt nicht als Inhalt', () => {
  assert.equal(plainFromHtml('<p><br></p>'), '');
  assert.throws(() => cleanRichText('<p><br></p>'), /Text fehlt/);
});

test('Nur geschützte interne Redaktionsbilder bleiben im Text', () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const result = cleanRichText(`<p>Neue Kollegin</p><img src="/bbsinfo/editor-images/${uuid}" alt="Porträt"><img src="https://example.org/fremd.png">`);
  assert.match(result.html, new RegExp(`/bbsinfo/editor-images/${uuid}`));
  assert.match(result.html, /alt="Porträt"/);
  assert.doesNotMatch(result.html, /example\.org/);
  assert.equal(result.plain, 'Neue Kollegin');
});

test('Bildbreite bleibt nach Speichern und erneutem Rendern erhalten', () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const html = `<p>Porträt</p><img src="/bbsinfo/editor-images/${uuid}" style="width: 320px; height: 800px; position: fixed" width="320" onload="bad()">`;
  const first = cleanRichText(html);
  const rendered = cleanRichText(first.html);
  assert.match(rendered.html, /style="width:\s*320px"/);
  assert.doesNotMatch(rendered.html, /height:|position:|onload=/);
});
