-- Apply once to the existing bbsinfo database before deploying the matching code.
-- Existing plain-text content remains untouched; new HTML fields are optional.
ALTER TABLE bbsinfo.updates ADD COLUMN IF NOT EXISTS body_html MEDIUMTEXT NULL AFTER body;
ALTER TABLE bbsinfo.update_versions ADD COLUMN IF NOT EXISTS body_html MEDIUMTEXT NULL AFTER body;
ALTER TABLE bbsinfo.issues ADD COLUMN IF NOT EXISTS body_html MEDIUMTEXT NULL AFTER body;
ALTER TABLE bbsinfo.issue_updates ADD COLUMN IF NOT EXISTS snapshot_body_html MEDIUMTEXT NULL AFTER snapshot_body;

CREATE TABLE IF NOT EXISTS bbsinfo.content_templates (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  body TEXT NOT NULL,
  body_html MEDIUMTEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX templates_enabled (enabled, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE ON bbsinfo.content_templates TO 'bbsinfo'@'localhost';
