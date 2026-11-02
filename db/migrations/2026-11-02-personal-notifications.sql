-- V1.3: preserve existing update subscriptions; albums require a new opt-in.
-- Apply after a private database backup and restore check.
ALTER TABLE update_subscriptions
  ADD COLUMN notify_updates BOOLEAN NOT NULL DEFAULT TRUE AFTER mode,
  ADD COLUMN notify_albums BOOLEAN NOT NULL DEFAULT FALSE AFTER notify_updates,
  ADD COLUMN albums_since DATETIME(6) NULL AFTER changed_at;

CREATE TABLE IF NOT EXISTS photo_album_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  album_id INT UNSIGNED NOT NULL,
  set_id INT UNSIGNED NOT NULL UNIQUE,
  kind ENUM('new', 'expanded') NOT NULL,
  photo_count SMALLINT UNSIGNED NOT NULL,
  album_title VARCHAR(200) NOT NULL,
  published_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT photo_notice_album FOREIGN KEY (album_id) REFERENCES photo_albums(id) ON DELETE RESTRICT,
  CONSTRAINT photo_notice_set FOREIGN KEY (set_id) REFERENCES photo_sets(id) ON DELETE RESTRICT,
  INDEX photo_notice_time (published_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS photo_album_mail_delivery (
  user_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  status ENUM('sending', 'sent', 'uncertain') NOT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  finished_at DATETIME(6) NULL,
  PRIMARY KEY (user_uuid, event_id),
  CONSTRAINT photo_mail_event FOREIGN KEY (event_id) REFERENCES photo_album_notifications(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT ON bbsinfo.photo_album_notifications TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON bbsinfo.photo_album_mail_delivery TO 'bbsinfo'@'localhost';
