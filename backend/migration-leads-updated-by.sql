-- Tracks which agent actually set a lead's disposition, needed for an
-- accurate per-agent "callbacks set" count in the Agent Report - without
-- this there's no way to know who did what, only when it happened.
ALTER TABLE leads ADD COLUMN updated_by INT NULL, ADD FOREIGN KEY (updated_by) REFERENCES users(id);
