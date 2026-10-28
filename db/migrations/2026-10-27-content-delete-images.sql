-- Apply once to the existing BBS Info database after a backup.
-- Every published issue_updates row must already have a text snapshot.
ALTER TABLE issue_updates DROP FOREIGN KEY issue_updates_update;
ALTER TABLE issue_updates
  DROP PRIMARY KEY,
  ADD COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST,
  MODIFY COLUMN update_id INT UNSIGNED NULL,
  ADD UNIQUE KEY issue_update_source (issue_id, update_id);
ALTER TABLE issue_updates
  ADD CONSTRAINT issue_updates_update FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE SET NULL;

-- Legacy version rows are no longer used by the application.
ALTER TABLE update_versions DROP FOREIGN KEY update_version_update;
ALTER TABLE update_versions
  ADD CONSTRAINT update_version_update FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE;

CREATE TABLE editor_images (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stored_name CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  media_type ENUM('image/jpeg', 'image/png', 'image/webp') NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  uploaded_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  uploaded_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
