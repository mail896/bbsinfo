-- Apply once to an existing bbsinfo database before deploying the matching code.
CREATE TABLE IF NOT EXISTS issue_mail_delivery (
  issue_id INT UNSIGNED NOT NULL PRIMARY KEY,
  status ENUM('sending', 'sent', 'uncertain') NOT NULL,
  requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  finished_at DATETIME(6) NULL,
  CONSTRAINT issue_mail_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
