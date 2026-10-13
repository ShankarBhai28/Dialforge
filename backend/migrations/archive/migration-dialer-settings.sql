-- Predictive-dialer work, step D3: campaign dial settings, per-campaign
-- dispositions, callbacks, and a DNC list.

-- 1. Dial settings. Only stored + edited in D3 (plus the calling window,
-- which is enforced on manual trunk calls already); the dialer engine
-- (D5+) is what reads mode/ratio/attempts/channels.
ALTER TABLE campaigns
  ADD COLUMN dial_mode VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN dial_ratio DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN max_dial_ratio DECIMAL(4,2) NOT NULL DEFAULT 2.50,
  ADD COLUMN target_abandon_pct DECIMAL(4,2) NOT NULL DEFAULT 3.00,
  ADD COLUMN ring_timeout_sec INT NOT NULL DEFAULT 30,
  ADD COLUMN max_attempts INT NOT NULL DEFAULT 3,
  ADD COLUMN max_channels INT NOT NULL DEFAULT 10,
  ADD COLUMN amd_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN preview_autodial_sec INT NULL,
  ADD COLUMN wrapup_sec INT NOT NULL DEFAULT 10,
  ADD COLUMN call_window_start TIME NOT NULL DEFAULT '09:00:00',
  ADD COLUMN call_window_end TIME NOT NULL DEFAULT '21:00:00',
  ADD COLUMN timezone VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata';

-- 2. Dispositions per campaign. code is what lands in leads.status, so
-- the seeded codes are exactly the ones already in use (reports and the
-- existing DNC check keep working unchanged).
--   is_final        lead is finished - the dialer won't pick it again
--   retry_after_min dialer may retry after this many minutes
--   marks_dnc       number is added to the DNC list
--   is_callback     agent must pick a callback date/time
CREATE TABLE campaign_dispositions (
  id INT NOT NULL AUTO_INCREMENT,
  campaign_id INT NOT NULL,
  code VARCHAR(30) NOT NULL,
  label VARCHAR(60) NOT NULL,
  is_final TINYINT(1) NOT NULL DEFAULT 0,
  retry_after_min INT NULL,
  marks_dnc TINYINT(1) NOT NULL DEFAULT 0,
  is_callback TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_campaign_code (campaign_id, code),
  CONSTRAINT campaign_dispositions_ibfk_1 FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO campaign_dispositions (campaign_id, code, label, is_final, retry_after_min, marks_dnc, is_callback, sort_order)
SELECT c.id, d.code, d.label, d.is_final, d.retry_after_min, d.marks_dnc, d.is_callback, d.sort_order
FROM campaigns c
CROSS JOIN (
  SELECT 'interested' AS code, 'Interested' AS label, 1 AS is_final, NULL AS retry_after_min, 0 AS marks_dnc, 0 AS is_callback, 0 AS sort_order
  UNION ALL SELECT 'not_interested', 'Not Interested', 1, NULL, 0, 0, 1
  UNION ALL SELECT 'callback', 'Callback', 0, NULL, 0, 1, 2
  UNION ALL SELECT 'no_answer', 'No Answer', 0, 60, 0, 0, 3
  UNION ALL SELECT 'do_not_call', 'Do Not Call', 1, NULL, 1, 0, 4
) d;

-- 3. Per-lead dialing state, read by the hopper in D5.
ALTER TABLE leads
  ADD COLUMN attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN last_attempt_at DATETIME NULL,
  ADD COLUMN next_call_at DATETIME NULL,
  ADD COLUMN is_final TINYINT(1) NOT NULL DEFAULT 0,
  ADD INDEX idx_leads_dialable (campaign_id, is_final, next_call_at);

UPDATE leads SET is_final = 1 WHERE status IN ('interested', 'not_interested', 'do_not_call');

-- 4. DNC list (tenant-wide, phone stored normalised - see normalizePhone()
-- in server.js). Seeded from leads already marked Do Not Call.
CREATE TABLE dnc_numbers (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  phone VARCHAR(20) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_dnc_phone (tenant_id, phone),
  CONSTRAINT dnc_numbers_ibfk_1 FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Same rule as normalizePhone(): digits only; a 12-digit 91xxxxxxxxxx or
-- 11-digit 0xxxxxxxxxx Indian number is reduced to its last 10 digits.
INSERT IGNORE INTO dnc_numbers (tenant_id, phone, source, created_by)
SELECT 1, CASE
    WHEN LENGTH(p) = 12 AND p LIKE '91%' THEN RIGHT(p, 10)
    WHEN LENGTH(p) = 11 AND p LIKE '0%' THEN RIGHT(p, 10)
    ELSE p END,
  'disposition', updated_by
FROM (SELECT REGEXP_REPLACE(phone, '[^0-9]', '') AS p, updated_by FROM leads WHERE status = 'do_not_call') x
WHERE p <> '';

-- 5. Scheduled callbacks. user_id NULL = anyone working the campaign.
CREATE TABLE callbacks (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  lead_id INT NOT NULL,
  campaign_id INT NULL,
  user_id INT NULL,
  callback_at DATETIME NOT NULL,
  note VARCHAR(255) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_callbacks_due (status, callback_at),
  KEY lead_id (lead_id),
  CONSTRAINT callbacks_ibfk_1 FOREIGN KEY (lead_id) REFERENCES leads (id),
  CONSTRAINT callbacks_ibfk_2 FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
  CONSTRAINT callbacks_ibfk_3 FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT callbacks_ibfk_4 FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
