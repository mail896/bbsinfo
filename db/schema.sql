-- BBS Info: apply inside a dedicated, empty bbsinfo database with utf8mb4.
-- The application account does not need CREATE, ALTER or DROP privileges.
-- DELETE is limited to editorial content tables; audit_events remains append-only.

CREATE TABLE IF NOT EXISTS updates (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  body_html MEDIUMTEXT NULL,
  status ENUM('draft', 'published', 'withdrawn') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  published_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  published_at DATETIME(6) NULL,
  INDEX updates_published (status, published_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS update_subscriptions (
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  mode ENUM('off', 'instant', 'daily', 'weekly') NOT NULL DEFAULT 'off',
  changed_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS update_mail_delivery (
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id INT UNSIGNED NOT NULL,
  status ENUM('sending', 'sent', 'uncertain') NOT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  finished_at DATETIME(6) NULL,
  PRIMARY KEY (user_uuid, update_id),
  CONSTRAINT update_mail_update FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS search_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  term VARCHAR(200) NOT NULL,
  source ENUM('all', 'archive') NOT NULL,
  searched_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX search_time (searched_at, id),
  INDEX search_actor_time (actor_uuid, searched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS content_templates (
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

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  actor_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_type VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
  object_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  object_title VARCHAR(200) NULL,
  INDEX audit_time (occurred_at, id),
  INDEX audit_actor_time (actor_uuid, occurred_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iserv_identities (
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  display_name VARCHAR(200) NOT NULL,
  email VARCHAR(254) NULL,
  last_seen_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX identities_name (display_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS editor_grants (
  email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_sequence (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  next_number SMALLINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO issue_sequence (id, next_number) VALUES (1, 93);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  setting_value TEXT NOT NULL,
  changed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  changed_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issues (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  number SMALLINT UNSIGNED NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  body_html MEDIUMTEXT NULL,
  school_year VARCHAR(30) NOT NULL DEFAULT '',
  period VARCHAR(100) NOT NULL DEFAULT '',
  status ENUM('draft', 'published', 'withdrawn') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  published_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  published_at DATETIME(6) NULL,
  INDEX issues_published (status, number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_mail_delivery (
  issue_id INT UNSIGNED NOT NULL PRIMARY KEY,
  status ENUM('sending', 'sent', 'uncertain') NOT NULL,
  requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  finished_at DATETIME(6) NULL,
  CONSTRAINT issue_mail_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_updates (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  issue_id INT UNSIGNED NOT NULL,
  update_id INT UNSIGNED NULL,
  position SMALLINT UNSIGNED NOT NULL,
  snapshot_title VARCHAR(200) NULL,
  snapshot_body TEXT NULL,
  snapshot_body_html MEDIUMTEXT NULL,
  UNIQUE KEY issue_update_source (issue_id, update_id),
  UNIQUE KEY issue_position (issue_id, position),
  CONSTRAINT issue_updates_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE RESTRICT,
  CONSTRAINT issue_updates_update FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contributions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  body_html MEDIUMTEXT NULL,
  status ENUM('submitted', 'taken_over') NOT NULL DEFAULT 'submitted',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX contributions_owner (owner_uuid, created_at, id),
  INDEX contributions_status (status, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_contributions (
  issue_id INT UNSIGNED NOT NULL,
  contribution_id INT UNSIGNED NULL,
  position SMALLINT UNSIGNED NOT NULL,
  snapshot_title VARCHAR(200) NOT NULL,
  snapshot_body TEXT NOT NULL,
  snapshot_body_html MEDIUMTEXT NULL,
  snapshot_author VARCHAR(200) NOT NULL,
  UNIQUE KEY issue_contribution_source (issue_id, contribution_id),
  UNIQUE KEY issue_contribution_position (issue_id, position),
  CONSTRAINT issue_contributions_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE RESTRICT,
  CONSTRAINT issue_contributions_source FOREIGN KEY (contribution_id) REFERENCES contributions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS editor_images (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stored_name CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  media_type ENUM('image/jpeg', 'image/png', 'image/webp') NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  uploaded_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  uploaded_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS submissions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(200) NOT NULL,
  note VARCHAR(1000) NOT NULL DEFAULT '',
  stored_name CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  media_type ENUM('application/pdf', 'image/jpeg', 'image/png', 'image/webp') NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  status ENUM('submitted', 'taken_over') NOT NULL DEFAULT 'submitted',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  taken_at DATETIME(6) NULL,
  taken_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  INDEX submissions_owner (owner_uuid, created_at, id),
  INDEX submissions_status (status, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS update_submissions (
  update_id INT UNSIGNED NOT NULL,
  submission_id INT UNSIGNED NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (update_id, submission_id),
  UNIQUE KEY update_submission_position (update_id, position),
  CONSTRAINT update_submission_update FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE RESTRICT,
  CONSTRAINT update_submission_file FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_submissions (
  issue_id INT UNSIGNED NOT NULL,
  submission_id INT UNSIGNED NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (issue_id, submission_id),
  UNIQUE KEY issue_submission_position (issue_id, position),
  CONSTRAINT issue_submission_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE RESTRICT,
  CONSTRAINT issue_submission_file FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_usage (
  day DATE NOT NULL,
  action VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_type VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  object_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  event_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, action, object_type, object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
