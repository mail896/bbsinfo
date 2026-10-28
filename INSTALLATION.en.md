# Installation and operation

This guide describes the components for a **separate installation**; it is not an unattended universal installer. BBS Info 1.0 was built for BBS Einbeck and its IServ. The public source uses neutral `school.example` domains and mailboxes.

## Requirements

- Node.js 24, npm, MariaDB and Python 3.
- Python PDF packages: `pypdf`, `reportlab`, `beautifulsoup4`, `Pillow`; optionally `ocrmypdf`, Tesseract and language data for OCR, plus Ghostscript for previews.
- An HTTPS reverse proxy and an IServ OIDC client with callback `https://apps.school.example/bbsinfo/oidc/callback`.
- A read-only IServ IDM service account for current staff-group verification before personal email and the first assignment of additional editor rights.
- A dedicated MariaDB service account, private data directories and regularly tested backups.

## Setup

1. Clone the public repository, run `npm ci --ignore-scripts` and `npm test`.
2. Use `config.example.json` to create a **private** configuration file outside Git. Store the OIDC client secret and audit administrator UUID only there, with mode `0600` or `0400`.
3. Replace the fixed sample domains and email addresses in `backend/` and `design/web/` with your environment's values. The OIDC callback must exactly match the IServ registration. Keep the test fixtures consistent and rerun the tests.
4. Create a dedicated MariaDB database and account; apply `db/schema.sql` to an **empty** database. The files under `db/migrations/` upgrade older installs and must not all be blindly replayed over the current schema. Grant only the rights needed by the service.
5. Create private storage for the archive, submissions and editor images. PDFs, thumbnails, the SQLite index, uploads and MariaDB data must stay outside the web root and Git.
6. Start the service with `BBSINFO_CONFIG` or systemd credentials. The default port binds only to `127.0.0.1`; `BBSINFO_SOCKET` selects a Unix socket. Optional paths: `BBSINFO_ARCHIVE_ROOT`, `BBSINFO_SUBMISSION_ROOT`, `BBSINFO_EDITOR_IMAGE_ROOT`.
7. Configure Apache or another reverse proxy for `/bbsinfo/` and its static assets. `deploy/` provides an adapted example. Protected routes must reject anonymous requests.

## Email

Email is optional. Store SMTP settings in a private JSON file and pass it through `BBSINFO_MAIL_CONFIG`. `backend/mail.mjs` and `backend/smtp_sender.py` deliberately restrict sender and recipients to the sample environment; adapt these constants carefully while retaining the safety tests. **Staff-wide email remains disabled** until both `deliveryEnabled: true` in private configuration and `BBSINFO_COLLEGIUM_SEND_ENABLED=1` are explicitly set after local approval. Personal mail also requires the read-only IDM account and a user's own subscription.

## Before use

Run `npm test`; verify startup and anonymous HTTP 401 responses for archive, PDFs and editor pages; test IServ sign-in and roles with local test accounts; inspect an email preview; and test backup and restore. GitHub Pages is a static project site, not an instance of the web application.

