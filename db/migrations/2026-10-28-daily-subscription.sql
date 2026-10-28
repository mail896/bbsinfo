ALTER TABLE update_subscriptions MODIFY COLUMN mode ENUM('off', 'instant', 'daily', 'weekly') NOT NULL DEFAULT 'off';
