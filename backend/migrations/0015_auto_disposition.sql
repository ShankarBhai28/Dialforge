-- 0015: auto disposition. A campaign can save a disposition by itself when
-- the agent gives none within N seconds after the call (0 = off). Every
-- campaign gets a "No Disposition" (not final, redialled after 60 min) to
-- choose for it, so the customer isn't lost.
ALTER TABLE campaigns
  ADD COLUMN auto_dispo_sec INT NOT NULL DEFAULT 0,
  ADD COLUMN auto_dispo_code VARCHAR(30) NULL;

INSERT IGNORE INTO campaign_dispositions (campaign_id, code, label, is_final, retry_after_min, marks_dnc, is_callback, is_success, sort_order)
SELECT id, 'no_dispo', 'No Disposition', 0, 60, 0, 0, 0, 99 FROM campaigns;
