-- Users can be deactivated (no delete: calls, status history, form answers
-- and callbacks point at them). An inactive user can't log in.
ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';
