import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlEscape } from '../backend/html-escape.mjs';

test('Gemeinsames HTML-Escaping kodiert die fünf Sonderzeichen unverändert', () => {
  assert.equal(htmlEscape('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(htmlEscape('bereits &amp;'), 'bereits &amp;amp;');
  assert.equal(htmlEscape(null), 'null');
});
