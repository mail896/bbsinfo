ALTER TABLE iserv_identities ADD COLUMN email VARCHAR(254) NULL AFTER display_name;
ALTER TABLE update_subscriptions ADD COLUMN mode ENUM('off', 'instant', 'weekly') NOT NULL DEFAULT 'off' AFTER enabled;
UPDATE update_subscriptions SET mode = IF(enabled = 1, 'weekly', 'off'), changed_at = UTC_TIMESTAMP(6);
UPDATE app_settings SET setting_value = 'every_monday' WHERE setting_key = 'digestCadence' AND setting_value = 'first_monday_monthly';

CREATE TABLE update_mail_delivery (
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id INT UNSIGNED NOT NULL,
  status ENUM('sending', 'sent', 'uncertain') NOT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  finished_at DATETIME(6) NULL,
  PRIMARY KEY (user_uuid, update_id),
  CONSTRAINT update_mail_update FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  term VARCHAR(200) NOT NULL,
  source ENUM('all', 'archive') NOT NULL,
  searched_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX search_time (searched_at, id),
  INDEX search_actor_time (actor_uuid, searched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contributions (
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

CREATE TABLE issue_contributions (
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

GRANT SELECT, INSERT, UPDATE, DELETE ON bbsinfo.contributions TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT, DELETE ON bbsinfo.issue_contributions TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT, DELETE ON bbsinfo.search_events TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT, UPDATE ON bbsinfo.update_mail_delivery TO 'bbsinfo'@'localhost';
