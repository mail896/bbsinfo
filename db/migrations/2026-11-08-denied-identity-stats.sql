-- Apply after a private backup and restore test, before deploying the matching code.
-- Existing audit events remain unchanged; names become available only for future verified denials.
CREATE TABLE IF NOT EXISTS auth_denied_identities (
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  display_name VARCHAR(200) NOT NULL,
  first_seen_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  last_seen_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX denied_identity_expiry (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE, DELETE ON bbsinfo.auth_denied_identities TO 'bbsinfo'@'localhost';
