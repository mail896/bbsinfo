import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../design/web/theme.js', import.meta.url), 'utf8');

function browser(initial, systemDark = false, storageAllowed = true) {
  const listeners = new Map();
  const stored = new Map(initial ? [['bbsinfo-theme', initial]] : []);
  const select = { value: '', addEventListener(name, handler) { this[name] = handler; } };
  const root = {
    dataset: {},
    removeAttribute(name) { if (name === 'data-theme') delete this.dataset.theme; },
  };
  const document = {
    documentElement: root,
    addEventListener(name, handler) { listeners.set(name, handler); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
    querySelector(selector) { return selector === '[data-theme-choice]' ? select : null; },
  };
  const media = { matches: systemDark, addEventListener(name, handler) { this[name] = handler; } };
  const window = { matchMedia: () => media };
  const localStorage = {
    getItem(key) { if (!storageAllowed) throw new Error('denied'); return stored.get(key) ?? null; },
    setItem(key, value) { if (!storageAllowed) throw new Error('denied'); stored.set(key, value); },
    removeItem(key) { if (!storageAllowed) throw new Error('denied'); stored.delete(key); },
  };
  runInNewContext(script, { document, window, localStorage, CustomEvent: class { constructor(type) { this.type = type; } } });
  return { root, document, select, media, stored, window, ready: () => listeners.get('DOMContentLoaded')() };
}

test('Gespeicherter Modus gilt vor DOMContentLoaded und bleibt beim Wechsel erhalten', () => {
  const page = browser('dark');
  assert.equal(page.root.dataset.theme, 'dark');
  page.ready();
  assert.equal(page.select.value, 'dark');
  page.select.value = 'light';
  page.select.change();
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.stored.get('bbsinfo-theme'), 'light');
  assert.equal(page.window.bbsInfoTheme.isDark(), false);
  page.select.value = 'system';
  page.select.change();
  assert.equal(page.root.dataset.theme, undefined);
  assert.equal(page.stored.has('bbsinfo-theme'), false);
});

test('Systemmodus folgt Gerätewechseln und bleibt bei gesperrtem Speicher nutzbar', () => {
  const page = browser(null, true, false);
  assert.equal(page.root.dataset.theme, undefined);
  assert.equal(page.window.bbsInfoTheme.isDark(), true);
  page.ready();
  assert.equal(page.select.value, 'system');
  page.select.value = 'light';
  page.select.change();
  assert.equal(page.root.dataset.theme, 'light');
  page.select.value = 'system';
  page.select.change();
  page.media.matches = false;
  page.media.change();
  assert.equal(page.window.bbsInfoTheme.isDark(), false);
});
