import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createCmsStore } from '../backend/cms-store.mjs';
import { createApp } from '../backend/server.mjs';
import { issueEditPage, issueEditorPage } from '../backend/web-pages.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reader = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const settings = { clientId: 'test', clientSecret: 'test', auditOwnerUuid: owner, readerGroupName: 'Kollegium' };

test('Ausgabenquellen werden je Gruppe gesucht und auf 30 Treffer pro Seite begrenzt', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return Array.from({ length: 31 }, (_, index) => ({ id: index + 1, title: `Treffer ${index + 1}` }));
    },
  };
  const store = createCmsStore(pool);
  for (const [method, table] of [
    ['listIssueUpdates', 'updates'],
    ['listIssueContributions', 'contributions'],
    ['listIssueSubmissions', 'submissions'],
  ]) {
    const result = await store[method]({ query: "Lena%' OR 1=1 --", used: true, page: 2 });
    assert.equal(result.items.length, 30);
    assert.equal(result.hasMore, true);
    const call = calls.at(-1);
    assert.match(call.sql, new RegExp(`FROM ${table}\\b`));
    assert.match(call.sql, /LIMIT \? OFFSET \?/);
    if (table === 'contributions') assert.match(call.sql, /c[.]status = 'submitted' OR EXISTS/);
    assert.doesNotMatch(call.sql, /Lena|1=1/);
    assert.ok(call.params.includes("Lena%' OR 1=1 --"));
    assert.deepEqual(call.params.slice(-2), [31, 30]);
  }
  const before = calls.length;
  await assert.rejects(store.listIssueUpdates({ query: 'x'.repeat(101), used: false, page: 1 }), /Ungültige/);
  await assert.rejects(store.listIssueSubmissions({ query: '', used: false, page: 0 }), /Ungültige/);
  assert.equal(calls.length, before);
});

async function fixture(account) {
  const calls = [];
  const auth = {
    async begin() { return { verifier: 'v', state: 's', nonce: 'n', url: 'https://school.example/authorize?state=s' }; },
    async complete() { return { subject: 'test', info: account, accessToken: 'token', expires: Date.now() + 300000 }; },
    async refresh() { return account; },
  };
  const cmsStore = {
    async rememberIdentity() {}, async recordAudit() {},
    async listIssueUpdates(options) { calls.push({ kind: 'updates', ...options }); return { items: [{ id: 7, title: '<img onerror=alert(1)>', publishedAtUtc: '2026-10-28 10:00:00', usedInIssues: null }], hasMore: false }; },
    async listIssueContributions(options) { calls.push({ kind: 'contributions', ...options }); return { items: [], hasMore: false }; },
    async listIssueSubmissions(options) { calls.push({ kind: 'submissions', ...options }); return { items: [], hasMore: false }; },
  };
  const app = createApp({ settings, getProvider: async () => auth, cmsStore });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const start = await fetch(`${base}/bbsinfo/oidc/login`, { redirect: 'manual' });
  const transaction = start.headers.getSetCookie()[0].split(';')[0];
  const callback = await fetch(`${base}/bbsinfo/oidc/callback?code=ok&state=s`, { redirect: 'manual', headers: { cookie: transaction } });
  const cookie = callback.headers.getSetCookie().find((value) => value.startsWith('__Secure-bbsinfo-session=')).split(';')[0];
  return { app, base, cookie, calls };
}

test('Quellen-JSON ist nur für angemeldete Redaktion erreichbar und prüft Parameter', async () => {
  const account = { 'iserv:uuid': owner, 'iserv:groups': [{ name: 'Kollegium' }], name: 'Marc' };
  const run = await fixture(account);
  try {
    const path = '/bbsinfo/editor/issue-sources?kind=updates&used=0&page=2&q=Lea';
    const noSession = await fetch(run.base + path);
    assert.equal(noSession.status, 401);
    const response = await fetch(run.base + path, { headers: { cookie: run.cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const data = await response.json();
    assert.equal(data.items[0].title, '<img onerror=alert(1)>');
    assert.deepEqual(run.calls.at(-1), { kind: 'updates', query: 'Lea', used: false, page: 2 });
    for (const bad of ['kind=unknown&used=0&page=1', 'kind=updates&used=2&page=1', 'kind=updates&used=0&page=0', `kind=updates&used=0&page=1&q=${'x'.repeat(101)}`]) {
      const denied = await fetch(`${run.base}/bbsinfo/editor/issue-sources?${bad}`, { headers: { cookie: run.cookie } });
      assert.equal(denied.status, 400);
    }
  } finally { await new Promise((resolve) => run.app.close(resolve)); }

  const colleague = await fixture({ 'iserv:uuid': reader, 'iserv:groups': [{ name: 'Kollegium' }], name: 'Test' });
  try {
    const denied = await fetch(`${colleague.base}/bbsinfo/editor/issue-sources?kind=updates&used=0&page=1`, { headers: { cookie: colleague.cookie } });
    assert.equal(denied.status, 403);
    assert.equal(colleague.calls.length, 0);
  } finally { await new Promise((resolve) => colleague.app.close(resolve)); }
});

test('Ausgabenformular behält ausgewählte Quellen trotz begrenzter Trefferliste', () => {
  const empty = { items: [], hasMore: false };
  const groups = { fresh: empty, used: empty };
  const issue = {
    number: 95, title: 'Herbst', body: 'Einleitung', bodyHtml: null, schoolYear: '2026/27', period: '',
    updates: [{ updateId: 901, title: 'Schon ausgewählt', body: 'Text' }],
    contributions: [{ contributionId: 902, title: 'Bericht', author: 'Lea', body: 'Text' }],
    attachments: [{ id: 903, title: 'Steckbrief' }],
  };
  const html = issueEditPage(issue, groups, groups, [], 'csrf', null, groups);
  assert.match(html, /name="updateId" value="901" checked/);
  assert.match(html, /name="contributionId" value="902" checked/);
  assert.match(html, /name="submissionId" value="903" checked/);
  assert.match(html, /data-issue-source-row="901" data-source-used="1"/);
  assert.match(html, /name="bodyHtml"[^>]*data-rich-editor/);
  assert.match(html, /data-issue-source="updates"/);
  assert.match(html, /data-issue-source-search/);
  const create = issueEditorPage([], groups, [], groups, [], 'csrf', '2026/27', {}, groups);
  assert.match(create, /data-issue-source="submissions"/);
  assert.match(create, /data-issue-source="contributions"/);
});

test('Bereits ausgewählte Steckbriefe zeigen beim Bearbeiten den IServ-Namen', async () => {
  const statements = [];
  const conn = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('FROM issues WHERE status =')) return [{ number: 95, title: 'Herbst', body: '', schoolYear: '2026/27', period: '' }];
      if (sql.includes('FROM issue_submissions isu')) return [{ id: 903, title: 'Steckbrief', ownerName: 'Lea Test' }];
      return [];
    },
    async commit() {}, async rollback() {}, release() {},
  };
  const issue = await createCmsStore({ async getConnection() { return conn; } }).getPublishedIssue(95);
  const attachmentSql = statements.find((sql) => sql.includes('FROM issue_submissions isu'));
  assert.match(attachmentSql, /LEFT JOIN iserv_identities p ON p[.]user_uuid = s[.]owner_uuid/);
  assert.match(attachmentSql, /p[.]display_name AS ownerName/);
  const empty = { fresh: { items: [], hasMore: false }, used: { items: [], hasMore: false } };
  const html = issueEditPage(issue, empty, empty, [], 'csrf', null, empty);
  assert.match(html, /Steckbrief · Lea Test/);
});

test('Suchen und Nachladen im Browser erhalten die bereits gewählten Quellen', async () => {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = false; this.open = false; this.disabled = false; this.value = ''; }
    append(...parts) { for (const part of parts) { part.remove?.(); part.parentElement = this; this.children.push(part); } }
    prepend(...parts) { for (const part of parts.reverse()) { part.remove?.(); part.parentElement = this; this.children.unshift(part); } }
    replaceChildren(...parts) { this.children = []; this.append(...parts); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((part) => part !== this); this.parentElement = null; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === '.issue-source-row' && node.className === 'issue-source-row') return node;
        if (selector === '[data-issue-source-results="used"]' && node.dataset?.issueSourceResults === 'used') return node;
      }
      return null;
    }
    querySelector(selector) {
      if (selector === '.issue-source-reference') return this.children.find((part) => part.className === 'issue-source-reference') || null;
      if (selector === '.issue-source-row') return this.children.find((part) => part.className === 'issue-source-row') || null;
      if (selector === '[data-issue-source-empty]') return this.children.find((part) => Object.hasOwn(part.dataset || {}, 'issueSourceEmpty')) || null;
      return null;
    }
    get textContent() { return this._textContent ?? this.children.map((part) => part.textContent || '').join(''); }
    set textContent(value) { this._textContent = String(value); this.children = []; }
  }
  class Input extends Element { constructor() { super('input'); this.type = ''; this.name = ''; this.checked = false; } }
  const root = new Element();
  root.dataset.issueSource = 'updates';
  const search = new Element('input');
  const selectedArea = new Element();
  const usedDetails = new Element('details');
  const status = new Element('p');
  const fresh = new Element(); fresh.dataset.issueSourceResults = 'fresh';
  const used = new Element(); used.dataset.issueSourceResults = 'used';
  const freshMore = new Element('button'); freshMore.hidden = true;
  const usedMore = new Element('button'); usedMore.hidden = true;
  const initial = new Element(); initial.className = 'issue-source-row'; initial.dataset.issueSourceRow = '901'; initial.dataset.sourceUsed = '1';
  const checked = new Input(); checked.type = 'checkbox'; checked.name = 'updateId'; checked.value = '901'; checked.checked = true;
  initial.append(checked); selectedArea.append(initial);
  selectedArea.querySelectorAll = () => [checked];
  const controls = new Map([
    ['[data-issue-source-search]', search], ['[data-issue-source-selected]', selectedArea], ['.issue-source-used', usedDetails],
    ['[data-issue-source-status]', status], ['[data-issue-source-results="fresh"]', fresh], ['[data-issue-source-results="used"]', used],
    ['[data-issue-source-more="fresh"]', freshMore], ['[data-issue-source-more="used"]', usedMore],
  ]);
  root.querySelector = (selector) => controls.get(selector);
  const requests = [];
  const document = {
    querySelectorAll(selector) { return selector === '[data-issue-source]' ? [root] : []; },
    createElement(tag) { return tag === 'input' ? new Input() : new Element(tag); },
    createTextNode(value) { return { textContent: String(value) }; },
  };
  const script = readFileSync(new URL('../design/web/editor.js', import.meta.url), 'utf8');
  runInNewContext(script, {
    document, HTMLInputElement: Input, URLSearchParams, Intl, Date, setTimeout, clearTimeout,
    fetch: async (url) => {
      const params = new URL(url, 'https://apps.school.example').searchParams;
      requests.push({ q: params.get('q'), used: params.get('used'), page: params.get('page') });
      if (params.get('q') === 'Fehler' && params.get('used') === '1') return { ok: false };
      if (params.get('q') === 'Fehler') await new Promise((resolve) => setTimeout(resolve, 10));
      if (params.get('used') === '1' && (params.get('q') === 'Nur gebraucht' || params.get('q') === '')) return { ok: true, async json() { return { items: [{ id: 120, title: 'Nur gebraucht', usedInIssues: '93' }], hasMore: params.get('q') === 'Nur gebraucht' }; } };
      if (params.get('q') === 'Nur gebraucht') return { ok: true, async json() { return { items: [], hasMore: false }; } };
      return { ok: true, async json() { return {
        items: params.get('used') === '1' ? [] : [{ id: params.get('page') === '2' ? 99 : 901, title: 'Neuer Treffer', publishedAtUtc: '2026-10-28 10:00:00', usedInIssues: null }],
        hasMore: params.get('used') === '0' && params.get('page') === '1',
      }; } };
    },
  });
  search.value = 'Neuer';
  let prevented = false;
  search.listeners.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(checked.checked, true);
  assert.ok(selectedArea.children.includes(initial));
  assert.deepEqual(requests.map((item) => item.used), ['0', '1']);
  assert.equal(freshMore.hidden, false);
  assert.equal(fresh.children[0].tag, 'p');
  freshMore.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fresh.children.some((item) => item.dataset?.issueSourceRow === '99'));
  assert.equal(fresh.children.some((item) => item.tag === 'p'), false);
  assert.equal(freshMore.hidden, true);
  assert.ok(requests.some((item) => item.page === '2' && item.q === 'Neuer'));
  const added = fresh.children.find((item) => item.dataset?.issueSourceRow === '99');
  const input = added.children[0].children[0];
  input.checked = true;
  root.listeners.change({ target: input });
  assert.ok(selectedArea.children.includes(added));
  search.value = 'Nochmals';
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(selectedArea.children.includes(initial));
  assert.ok(selectedArea.children.includes(added));
  assert.equal(input.checked, true);
  search.value = '';
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  checked.checked = false;
  root.listeners.change({ target: checked });
  assert.ok(used.children.includes(initial));
  assert.equal(usedDetails.hidden, false);
  search.value = 'Nur gebraucht';
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(used.children.some((item) => item.dataset?.issueSourceRow === '120'));
  assert.equal(usedDetails.hidden, false);
  assert.equal(usedDetails.open, true);
  assert.equal(usedMore.hidden, false);
  search.value = 'Fehler';
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(status.textContent, /nicht verfügbar/);
  assert.equal(used.children.some((item) => item.dataset?.issueSourceRow === '120'), false);
  assert.equal(usedMore.hidden, true);
  search.value = '';
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(usedDetails.open, false);
});
