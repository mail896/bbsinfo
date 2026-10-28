# BBS Info · BBS Einbeck

[English](README.en.md) · [Projektseite mit Demo-Screenshots](https://mail896.github.io/bbsinfo/)

**Version 1.0** · 28. Oktober 2026 · Idee und Konzeption: Marc Schulz

BBS Info bündelt schulinterne Neuigkeiten für das Kollegium. Es verbindet kurze laufende Beiträge, nummerierte Ausgaben und ein historisches PDF-Archiv in einer geschützten Anwendung. Der Quellcode ist öffentlich; Beiträge, Steckbriefe, Archiv-PDFs, Suchprotokolle und Zugangsdaten sind es nicht.

## Funktionen

- IServ-Anmeldung mit Kollegiumsprüfung, getrennten Rollen für Lesende, Redaktion und Administration.
- Laufende Beiträge mit Entwürfen, rich-text-Editor, Bildern und frei bearbeitbaren Textbausteinen.
- Eigene Beiträge und Steckbriefe des Kollegiums mit redaktioneller Übernahme.
- Nummerierte Ausgaben aus eigenen Texten und ausgewählten Beiträgen; eingebettete Steckbriefe, Webansicht und PDF-Download.
- Volltextsuche in neuen Inhalten sowie Suche im geschützten, teilweise per OCR erschlossenen historischen PDF-Archiv.
- Persönliche Update-Mails nach Wahl: sofort, täglich, wöchentlich oder keine. Vor jedem Versand wird die aktuelle IServ-Gruppenzugehörigkeit geprüft.
- Getrennte Ausgaben-Mail mit Vorschau, bearbeitbarer Vorlage und ausdrücklicher Freigabe für einen Verteiler.
- Audit-Log, Nutzungsstatistik, Suchauswertung, Filter und CSV-Export ausschließlich für die Administration.
- Einheitliche Oberfläche für Desktop und Mobilgeräte.

## Screenshots

Die [Projektseite](https://mail896.github.io/bbsinfo/) zeigt alle wichtigen Ansichten. **Sämtliche Screenshots verwenden fiktive Demodaten.** Sie zeigen die echten HTML-Templates, aber keine Live-Inhalte und keine echte IServ-Sitzung.

![Startseite mit fiktiven Daten](docs/screenshots/startseite.png)

## Installation

[Deutsche Anleitung](INSTALLATION.md) · [English installation guide](INSTALLATION.en.md)

Kurz: Node.js 24 und npm, MariaDB, Python 3 mit den für PDF/OCR benötigten Paketen sowie einen passenden IServ-OIDC-Client bereitstellen; dann `npm ci --ignore-scripts`, Schema, private Konfiguration, Reverse Proxy und Dienst einrichten. Ein frischer Installationspfad muss mit einer eigenen IServ-Umgebung und eigenen Domains angepasst werden. Der Public-Stand verwendet neutrale `school.example`-Adressen.

```sh
npm ci --ignore-scripts
npm test
```

Das Repository enthält Beispielkonfiguration, Schema, Migrationen und Tests. Reale Konfigurationen gehören mit restriktiven Rechten außerhalb des Repositorys. Die im Beispielcode eingetragenen Mail- und IServ-Adressen sind Platzhalter.

## Aufbau und Sicherheit

- `backend/`: OIDC, Rechte, CMS, Archiv, Mail, Audit und PDF-Verarbeitung.
- `design/web/`: ausgelieferte Styles, Skripte und gestaltete Mappe mit fiktiven Porträts.
- `db/`: aktuelles Schema und additive Migrationen.
- `tests/`: synthetische Tests für Fachlogik, Rechte und Sicherheitsgrenzen.
- `docs/`: statische GitHub Pages mit fiktiven Bildschirmansichten.

Secrets, private IServ-Daten, reale Inhalte, Serverbackups und die interne Entwicklungshistorie sind **nicht** Teil dieses öffentlichen Repositorys. Der öffentliche Stand hat eine eigene Git-Historie. Auch bei einer eigenen Installation darf die Mail an einen Gesamtverteiler erst nach expliziter Freigabe beider vorhandenen Sperren aktiviert werden.

[Sicherheitsmeldungen](SECURITY.md) · [MIT-Lizenz](LICENSE)
