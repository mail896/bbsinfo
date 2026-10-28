# GitHub Pages aktualisieren / Refreshing GitHub Pages

Die Bilder sind **Demodaten**, die durch die echten HTML-Templates erzeugt werden. Niemals Screenshots der produktiven Instanz oder echte Beiträge hochladen. Neue reale Daten sind ein Anlass zur Aktualisierung der Demo, keine Datenquelle für die Bilder.

1. Im internen Projekt die Änderungen testen. Den öffentlichen, bereinigten Snapshot mit `python3 publication/build_public_snapshot.py .public-repo` erzeugen.
2. Im öffentlichen Repository `npm ci --ignore-scripts` und `npm test` ausführen. Für Screenshots Playwright als **lokales Dokumentationswerkzeug** bereitstellen (nicht als App-Abhängigkeit). Beispiel: `npm install --no-save --package-lock=false playwright`; Browser mit `npx playwright install chromium` installieren. Alternativ `PLAYWRIGHT_MODULE=/pfad/zu/playwright` und `CHROMIUM_PATH=/pfad/zum/chromium-headless-shell` setzen.
3. `node tools/refresh_demo.mjs` im öffentlichen Repository ausführen. Die erzeugten PNGs stehen unter `docs/screenshots/`.
4. Alle Bilder und den Git-Diff ansehen. Prüfen: sichtbarer Hinweis „DEMO · FIKTIVE DATEN“, keine echten Namen, E-Mail-Adressen, Inhalte, URLs mit Tokens oder Zugangsdaten. Die Bildliste in `docs/screenshots/manifest.json` mit der Galerie abgleichen.
5. Nur den geprüften Public-Diff committen und nach `main` pushen. Danach die veröffentlichte GitHub Page im Browser prüfen.

The screenshots use fictional fixtures and the application's real HTML templates. Never capture the production site. Repeat the checks above after each refresh; publishing the static demo does not deploy the protected application.
