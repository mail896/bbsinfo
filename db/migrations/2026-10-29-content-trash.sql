-- V1.1: 30-day recovery window for updates, issues and private submissions.
-- Apply after a private full database backup and a restore check.
ALTER TABLE updates
  ADD COLUMN deleted_at DATETIME(6) NULL,
  ADD COLUMN deleted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN mail_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD INDEX updates_deleted (deleted_at, id);

ALTER TABLE issues
  ADD COLUMN deleted_at DATETIME(6) NULL,
  ADD COLUMN deleted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD INDEX issues_deleted (deleted_at, id);

ALTER TABLE contributions
  ADD COLUMN deleted_at DATETIME(6) NULL,
  ADD COLUMN deleted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD INDEX contributions_deleted (deleted_at, id);

ALTER TABLE submissions
  ADD COLUMN deleted_at DATETIME(6) NULL,
  ADD COLUMN deleted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD INDEX submissions_deleted (deleted_at, id);
