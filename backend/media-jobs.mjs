const overloaded = () => new Error('Medienverarbeitung vorübergehend ausgelastet.');

export function createMediaLimiter({ maxActive = 2, maxQueued = 16, maxWaitMs = 10000 } = {}) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1) {
    throw new TypeError('Ungültige Medienjob-Begrenzung.');
  }

  let active = 0;
  const waiting = [];

  const start = (entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    active++;
    let result;
    try { result = entry.job(); }
    catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(
      (value) => { active--; entry.resolve(value); drain(); },
      (error) => { active--; entry.reject(error); drain(); }
    );
  };

  const drain = () => {
    while (active < maxActive && waiting.length) start(waiting.shift());
  };

  return (job) => {
    if (typeof job !== 'function') return Promise.reject(new TypeError('Medienjob muss eine Funktion sein.'));
    return new Promise((resolve, reject) => {
      const entry = { job, resolve, reject, timer: null };
      if (active < maxActive && waiting.length === 0) return start(entry);
      if (waiting.length >= maxQueued) return reject(overloaded());
      entry.timer = setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        reject(overloaded());
      }, maxWaitMs);
      waiting.push(entry);
      drain();
    });
  };
}

// All Python media processes in this service share this one bound.
export const runMediaJob = createMediaLimiter();
