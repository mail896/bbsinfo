const gallery = document.getElementById('gallery');
const cards = [
  ['anmeldung','Anmeldung','Landing page'],['startseite','Startseite: Redaktion','Home: editors'],['startseite-kollegium','Startseite: Kollegium','Home: staff'],
  ['suche','Suche','Search'],['updates','Laufende Updates','Updates'],['beitrag','Einzelner Beitrag','Single update'],
  ['meine-beitraege','Meine Beiträge','My contributions'],['meine-steckbriefe','Meine Steckbriefe','My profiles'],['redaktion','Redaktion','Editorial desk'],
  ['ausgaben','Neue Ausgaben','Editions'],['ausgabe','Ausgabe lesen','Read an edition'],['ausgaben-bearbeiten','Ausgaben bearbeiten','Edit editions'],
  ['ausgabe-korrigieren','Ausgabe korrigieren','Revise edition'],['mailvorschau','Ausgaben-Mailvorschau','Edition mail preview'],['update-mailvorschau','Update-Mailvorschau','Update mail preview'],
  ['einstellungen-ausgaben','Einstellungen: Ausgaben-Mail','Settings: edition mail'],['einstellungen-updates','Einstellungen: Update-Mails','Settings: update mail'],
  ['einstellungen-textbausteine','Einstellungen: Textbausteine','Settings: text blocks'],['einstellungen-redaktion','Einstellungen: Redaktion','Settings: editors'],
  ['historisches-archiv','Historisches Archiv','Historical archive'],['archiv-suche','Archivsuche','Archive search'],['audit-log','Audit-Log','Audit log'],['nutzungsstatistik','Nutzungsstatistik','Usage statistics'],
];
for (const [file, de, en] of cards) {
  const card = document.createElement('a'); card.className = 'gallery-card'; card.href = `screenshots/${file}.png`; card.target = '_blank'; card.rel = 'noopener noreferrer';
  card.innerHTML = `<span class="preview"><img src="screenshots/${file}.png" alt="${de} · fiktive Demodaten" loading="lazy"></span><span class="caption"><strong>${de}</strong><small lang="en">${en} ↗</small></span>`;
  gallery.append(card);
}
