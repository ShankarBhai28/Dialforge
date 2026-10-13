-- Predictive-dialer work, step D5: dialer engine skeleton + hopper.

-- Admin's Start / Pause / Stop per campaign. The engine only works on
-- 'running' campaigns; 'paused' keeps the hopper, 'stopped' empties it.
ALTER TABLE campaigns
  ADD COLUMN dialer_state VARCHAR(20) NOT NULL DEFAULT 'stopped',
  ADD COLUMN dialer_state_changed_at DATETIME NULL,
  ADD COLUMN dialer_state_changed_by INT NULL;

-- Which lists of a campaign get dialed, and in what order.
ALTER TABLE lists
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN priority INT NOT NULL DEFAULT 0;

-- The hopper: a small, pre-sorted buffer of "next leads to dial" per
-- campaign. Scanning the whole leads table every second would be slow;
-- the engine refills this every few seconds and the pacing loop (D7)
-- only ever takes from here. lead_id is UNIQUE so a lead can never be
-- queued twice - that's the main duplicate-dial guard.
-- Pick order (copied in at fill time): due callbacks first, then list
-- priority, lead priority, fewest attempts, oldest lead.
--   status   ready = waiting; locked = taken by an agent (preview) or the
--            dialer (originating), with locked_at so stale locks expire
--   reserved_user_id  set for "only me" callbacks: only that agent may get it
CREATE TABLE dial_hopper (
  id INT NOT NULL AUTO_INCREMENT,
  campaign_id INT NOT NULL,
  lead_id INT NOT NULL,
  list_id INT NULL,
  phone VARCHAR(20) NOT NULL,
  is_callback TINYINT(1) NOT NULL DEFAULT 0,
  list_priority INT NOT NULL DEFAULT 0,
  lead_priority INT NOT NULL DEFAULT 0,
  attempts INT NOT NULL DEFAULT 0,
  reserved_user_id INT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'ready',
  locked_at DATETIME NULL,
  locked_by VARCHAR(40) NULL,
  inserted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_hopper_lead (lead_id),
  KEY idx_hopper_pick (campaign_id, status),
  CONSTRAINT dial_hopper_ibfk_1 FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT dial_hopper_ibfk_2 FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- What the engine last saw per campaign, written every tick, read by the
-- admin Dialer page. campaign_id 0 is the engine's own heartbeat row.
CREATE TABLE dialer_status (
  campaign_id INT NOT NULL,
  hopper_ready INT NOT NULL DEFAULT 0,
  hopper_locked INT NOT NULL DEFAULT 0,
  idle_agents INT NOT NULL DEFAULT 0,
  would_dial INT NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  last_tick_at DATETIME NOT NULL,
  PRIMARY KEY (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
