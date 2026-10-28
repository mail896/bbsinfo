# Installation und Betrieb

Diese Anleitung beschreibt die Bausteine für eine **eigene, isolierte Installation**. Sie ist kein unbeaufsichtigter Universalinstaller. BBS Info 1.0 wurde für die BBS Einbeck und deren IServ vorbereitet; im Public-Stand sind Domains und Mailadressen auf `school.example` neutralisiert.

## Voraussetzungen

- Node.js 24, npm, MariaDB und Python 3.
- Python-Pakete für PDF-Verarbeitung: `pypdf`, `reportlab`, `beautifulsoup4`, `Pillow`; für OCR zusätzlich `ocrmypdf`, Tesseract und passende Sprachdaten; für PDF-Vorschauen Ghostscript.
- HTTPS-Reverse-Proxy und ein IServ-OIDC-Client mit Callback `https://apps.school.example/bbsinfo/oidc/callback`.
- Ein lesender IServ-IDM-Dienstzugang für die aktuelle Kollegiumsprüfung vor persönlichen Mails und bei der ersten Bindung zusätzlicher Redaktionsrechte.
- Ein eigenes MariaDB-Dienstkonto, private Datenverzeichnisse und regelmäßige, geprüfte Backups.

## Vorbereitung

1. Public-Repository in ein Codeverzeichnis klonen. `npm ci --ignore-scripts` und `npm test` ausführen.
2. `config.example.json` als Vorlage für eine **private** Konfigurationsdatei außerhalb des Repositorys verwenden. Client-ID, Client-Secret und die UUID der Audit-Administration werden nur dort hinterlegt. Datei auf `0600` oder `0400` begrenzen.
3. Die festen Beispiel-Domains und Mailadressen in `backend/` sowie `design/web/` auf die eigene Umgebung anpassen. Der OIDC-Callback muss mit der IServ-Registrierung exakt übereinstimmen. Danach alle Tests erneut ausführen; Test-Fixtures bei einer Domänenanpassung konsistent anpassen.
4. MariaDB-Datenbank und eigenes Dienstkonto anlegen und `db/schema.sql` auf eine **leere** Datenbank anwenden. Die Dateien unter `db/migrations/` dienen Upgrades älterer Stände; sie nicht pauschal zusätzlich auf das aktuelle Schema anwenden. Dem Dienstkonto nur die für die Tabellen benötigten Rechte geben.
5. Private Verzeichnisse für Archiv, Einreichungen und Redaktionsbilder anlegen. Original-PDFs, Vorschaubilder, SQLite-Index, Uploads und MariaDB-Dateien gehören nicht in den Webroot oder nach Git.
6. Den Dienst mit `BBSINFO_CONFIG` oder systemd-Credentials starten. Der Standard-Port bindet nur an `127.0.0.1`; `BBSINFO_SOCKET` wählt einen Unix-Socket. Optional: `BBSINFO_ARCHIVE_ROOT`, `BBSINFO_SUBMISSION_ROOT`, `BBSINFO_EDITOR_IMAGE_ROOT`.
7. Apache oder einen anderen Reverse Proxy für `/bbsinfo/` und die statischen Assets einrichten. `deploy/` enthält ein angepasstes Beispielprofil. Geschützte Routen müssen ohne IServ-Sitzung abgewiesen werden.

## Mail

Mail ist optional. Die SMTP-Konfiguration liegt in einer privaten JSON-Datei und wird mit `BBSINFO_MAIL_CONFIG` übergeben. `backend/mail.mjs` und `backend/smtp_sender.py` begrenzen Absender und Empfänger bewusst auf die konfigurierte Beispielumgebung; diese Konstanten für die eigene Installation sorgfältig ändern und die Sperrtests erhalten. **Ein Gesamtverteiler bleibt gesperrt**, solange nicht sowohl `deliveryEnabled: true` in der privaten Konfiguration als auch `BBSINFO_COLLEGIUM_SEND_ENABLED=1` ausdrücklich gesetzt sind. Diese Freigabe erst nach eigener Abnahme erteilen. Persönliche Mails brauchen den lesenden IDM-Zugang und ein eigenes Abo des Kontos.

## Prüfung vor Betrieb

`npm test` ausführen, Start ohne und mit Konfiguration prüfen, anonymen Zugriff auf Archiv/PDF/Redaktion mit HTTP 401 bestätigen, IServ-Login und Rollen mit eigenen Testkonten prüfen, eine sichere Mailvorschau ansehen sowie Backup und Rücksicherung testen. Die GitHub Pages sind nur statische Produktdokumentation und betreiben keine Webapp.

