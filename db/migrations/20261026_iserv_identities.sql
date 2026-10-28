-- Apply before the matching BBS Info release; no existing audit rows are changed.
CREATE TABLE IF NOT EXISTS iserv_identities (
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  display_name VARCHAR(200) NOT NULL,
  last_seen_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX identities_name (display_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE ON bbsinfo.iserv_identities TO 'bbsinfo'@'localhost';
