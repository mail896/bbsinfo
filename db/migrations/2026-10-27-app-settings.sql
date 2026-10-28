CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  setting_value TEXT NOT NULL,
  changed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  changed_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
