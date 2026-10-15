-- 0010: a lead can be given to one agent (follow-ups, VIP customers). Only
-- that agent sees it on their lead list, and the dialer leaves it to them
-- (they call it themselves). NULL = the campaign's agents share it, as before.
ALTER TABLE leads
  ADD COLUMN assigned_user_id INT NULL,
  ADD KEY leads_assigned_user (assigned_user_id),
  ADD CONSTRAINT leads_assigned_user_fk FOREIGN KEY (assigned_user_id) REFERENCES users (id);
