-- 0011: spacing across campaigns. A campaign can skip a number that another
-- campaign called (or that called in) within the last N hours, so a customer
-- in two campaigns isn't rung by both back to back. 0 = off (as before).
ALTER TABLE campaigns ADD COLUMN number_gap_hours INT NOT NULL DEFAULT 0;
