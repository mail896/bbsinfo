import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaLimiter } from '../backend/media-jobs.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('Medienjobs starten höchstens zwei Prozesse und begrenzen die Warteschlange', async () => {
  const run = createMediaLimiter({ maxActive: 2, maxQueued: 1, maxWaitMs: 1000 });
  const first = deferred();
  const second = deferred();
  let started = 0;
  const a = run(() => { started++; return first.promise; });
  const b = run(() => { started++; return second.promise; });
  const c = run(() => { started++; return 'dritter'; });
  const rejected = assert.rejects(run(() => { started++; return 'vierter'; }), /ausgelastet/);
  assert.equal(started, 2);
  await rejected;
  assert.equal(started, 2);
  first.resolve('erster');
  assert.equal(await a, 'erster');
  assert.equal(await c, 'dritter');
  assert.equal(started, 3);
  second.resolve('zweiter');
  assert.equal(await b, 'zweiter');
});

test('Wartende Medienjobs laufen nach Frist nicht verspätet an', async () => {
  const run = createMediaLimiter({ maxActive: 1, maxQueued: 1, maxWaitMs: 20 });
  const running = deferred();
  let queuedStarted = false;
  const first = run(() => running.promise);
  const queued = assert.rejects(run(() => { queuedStarted = true; }), /ausgelastet/);
  await queued;
  running.resolve('fertig');
  assert.equal(await first, 'fertig');
  assert.equal(queuedStarted, false);
});

test('Fehlgeschlagene Medienjobs geben den Platz für den nächsten Job frei', async () => {
  const run = createMediaLimiter({ maxActive: 1, maxQueued: 1, maxWaitMs: 1000 });
  const running = deferred();
  const first = assert.rejects(run(() => running.promise), /Prozessfehler/);
  const second = run(() => 'danach');
  running.reject(new Error('Prozessfehler'));
  await first;
  assert.equal(await second, 'danach');
});
