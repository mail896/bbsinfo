-- V1.2 photo library: apply after private backup and restore check.
ALTER TABLE editor_images ADD COLUMN source_photo_id INT UNSIGNED NULL AFTER uploaded_by;
CREATE TABLE IF NOT EXISTS photo_albums (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  event_date DATE NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  deleted_at DATETIME(6) NULL,
  deleted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  INDEX photo_albums_visible (deleted_at, event_date, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS photo_sets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(200) NOT NULL,
  event_date DATE NULL,
  status ENUM('open', 'submitted', 'reviewed') NOT NULL DEFAULT 'open',
  rights_confirmed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  submitted_at DATETIME(6) NULL,
  reviewed_at DATETIME(6) NULL,
  reviewed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  INDEX photo_sets_owner (owner_uuid, created_at),
  INDEX photo_sets_review (status, submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS photo_assets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  set_id INT UNSIGNED NOT NULL,
  album_id INT UNSIGNED NULL,
  uploader_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stored_name CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  original_name VARCHAR(255) NOT NULL,
  media_type ENUM('image/jpeg', 'image/png', 'image/webp', 'image/heic') NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  captured_date DATE NULL,
  sequence_number INT UNSIGNED NULL,
  status ENUM('private', 'published', 'rejected', 'deleted', 'purged') NOT NULL DEFAULT 'private',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  published_at DATETIME(6) NULL,
  deleted_at DATETIME(6) NULL,
  deleted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  CONSTRAINT photo_asset_set FOREIGN KEY (set_id) REFERENCES photo_sets(id) ON DELETE RESTRICT,
  CONSTRAINT photo_asset_album FOREIGN KEY (album_id) REFERENCES photo_albums(id) ON DELETE RESTRICT,
  UNIQUE KEY photo_album_sequence (album_id, sequence_number),
  INDEX photo_asset_set_status (set_id, status, id),
  INDEX photo_asset_album_status (album_id, status, sequence_number),
  INDEX photo_asset_expiry (status, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS photo_comments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  photo_id INT UNSIGNED NOT NULL,
  author_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body VARCHAR(2000) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NULL,
  deleted_at DATETIME(6) NULL,
  deleted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  CONSTRAINT photo_comment_asset FOREIGN KEY (photo_id) REFERENCES photo_assets(id) ON DELETE RESTRICT,
  INDEX photo_comments_visible (photo_id, deleted_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS photo_comment_revisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  comment_id INT UNSIGNED NOT NULL,
  body VARCHAR(2000) NOT NULL,
  changed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action ENUM('create', 'edit', 'delete') NOT NULL,
  recorded_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT photo_comment_revision_comment FOREIGN KEY (comment_id) REFERENCES photo_comments(id) ON DELETE RESTRICT,
  INDEX photo_comment_revision_order (comment_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE editor_images
  ADD CONSTRAINT editor_image_source_photo FOREIGN KEY (source_photo_id) REFERENCES photo_assets(id) ON DELETE RESTRICT;

GRANT SELECT, INSERT, UPDATE ON bbsinfo.photo_albums TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT, UPDATE ON bbsinfo.photo_sets TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT, UPDATE ON bbsinfo.photo_assets TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT, UPDATE ON bbsinfo.photo_comments TO 'bbsinfo'@'localhost';
GRANT SELECT, INSERT ON bbsinfo.photo_comment_revisions TO 'bbsinfo'@'localhost';
