-- Apply after a private database backup, before deploying the matching code.
-- No existing audit rows are changed.
ALTER TABLE audit_events MODIFY COLUMN actor_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
