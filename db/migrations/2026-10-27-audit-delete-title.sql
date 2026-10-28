-- Keep only the title in the immutable audit when editorial content is deleted.
ALTER TABLE audit_events ADD COLUMN object_title VARCHAR(200) NULL AFTER object_id;
