export const defaultAppSettings = Object.freeze({
  mailSubject: 'BBS Info {nummer}: {titel}',
  mailBody: 'Liebe Kolleginnen und Kollegen,\n\ndie neue BBS-Info-Ausgabe ist erschienen.\n\nIn dieser Ausgabe:\n{inhalt}\n\n{link}\n\nDie Ausgabe ist nach Anmeldung mit IServ lesbar.\n',
  digestCadence: 'every_monday',
});

const allowedCadences = new Set(['first_monday_monthly', 'every_monday', 'disabled']);
const placeholders = new Set(['nummer', 'titel', 'datum', 'link', 'schuljahr', 'inhalt']);

export function validateAppSettings(input) {
  const mailSubject = input?.mailSubject;
  const mailBody = input?.mailBody;
  const digestCadence = input?.digestCadence;
  if (typeof mailSubject !== 'string' || !mailSubject.trim() || mailSubject.length > 200 || /[\r\n]/.test(mailSubject) || typeof mailBody !== 'string' || !mailBody.trim() || mailBody.length > 5000 || !mailBody.includes('{link}') || !allowedCadences.has(digestCadence)) throw new Error('Ungültige Einstellungen.');
  for (const text of [mailSubject, mailBody]) {
    for (const match of text.matchAll(/\{([^{}]+)\}/g)) if (!placeholders.has(match[1])) throw new Error('Unbekannter Platzhalter.');
  }
  return { mailSubject: mailSubject.trim(), mailBody, digestCadence };
}

export function renderMailTemplate(template, issue) {
  const topics = [...(issue.updates || []), ...(issue.contributions || [])].map((item) => `• ${String(item.title || '').replace(/[\r\n\t]+/g, ' ').trim()}`).filter((item) => item !== '• ');
  const replacements = {
    nummer: String(issue.number),
    titel: String(issue.title || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(),
    datum: String(issue.publishedAt || ''),
    link: `https://apps.school.example/bbsinfo/issues/${Number(issue.number)}`,
    schuljahr: String(issue.schoolYear || ''),
    inhalt: topics.join('\n') || 'Weitere Informationen in der Ausgabe',
  };
  return template.replace(/\{(nummer|titel|datum|link|schuljahr|inhalt)\}/g, (_, key) => replacements[key]);
}
