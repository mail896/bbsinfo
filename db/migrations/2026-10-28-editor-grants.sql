-- Apply after a private database backup, before deploying the matching code.
CREATE TABLE IF NOT EXISTS editor_grants (
  email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE, DELETE ON bbsinfo.editor_grants TO 'bbsinfo'@'localhost';
