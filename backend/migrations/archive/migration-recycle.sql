-- Predictive-dialer work, step D9: lead recycling (redialing).

-- Automatic recycling: what the dialer does after each kind of
-- unsuccessful call. A campaign with no row for a result uses the defaults
-- in dialer-common.js (DEFAULT_RECYCLE_RULES), so new campaigns need no
-- seeding.
--   result     no_answer | busy | machine | congestion (network/failed) |
--              abandoned (answered, no agent free - or hung up waiting)
--   enabled    0 = never redial automatically after this result
--   delay_min  redial after this many minutes
--   max_tries  stop after this many calls ending this way (counted since
--              the lead was last recycled by hand)
CREATE TABLE campaign_recycle_rules (
  campaign_id INT NOT NULL,
  result VARCHAR(20) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  delay_min INT NOT NULL,
  max_tries INT NOT NULL,
  PRIMARY KEY (campaign_id, result)
);

-- Manual recycling ("reset" a list): when it last happened to a lead, so
-- max_tries counts start again from there.
ALTER TABLE leads ADD COLUMN recycled_at DATETIME NULL;

-- Counting a lead's earlier results needs this.
ALTER TABLE dial_attempts ADD KEY idx_attempts_lead (lead_id, started_at);

-- Who recycled what, and when.
CREATE TABLE recycle_log (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  list_id INT NOT NULL,
  user_id INT NULL,
  statuses VARCHAR(500) NOT NULL,
  reset_attempts TINYINT(1) NOT NULL,
  leads_recycled INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_recycle_list (list_id, created_at)
);
