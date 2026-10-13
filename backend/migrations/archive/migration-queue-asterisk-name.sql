-- The exact Asterisk queues.conf section name for each queue (a URL/config
-- -safe slug derived from the human-readable name), so AMI actions and the
-- config file always reference the same identifier.
ALTER TABLE queues ADD COLUMN asterisk_name VARCHAR(50) NULL;
