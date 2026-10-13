-- Predictive-dialer work, step D7: progressive dialing.

-- Every call the dialer places, whatever happened to it. calls only gets a
-- row once a customer actually answers; this table also holds the
-- busy / no-answer / invalid-number attempts (the data Phase 11 reports
-- were missing).
--   status  dialing -> answered (customer picked up, waiting for an agent)
--           -> connected (agent took it) -> ended
--   result  final outcome: connected, no_answer, busy, congestion, invalid,
--           failed, machine, abandoned, customer_hangup
CREATE TABLE dial_attempts (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  campaign_id INT NOT NULL,
  lead_id INT NOT NULL,
  call_id INT NULL,
  phone VARCHAR(20) NOT NULL,
  channel_id VARCHAR(100) NULL,
  channel_name VARCHAR(100) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'dialing',
  result VARCHAR(20) NULL,
  hangup_cause INT NULL,
  agent_user_id INT NULL,
  ratio_at_dial DECIMAL(4,2) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at DATETIME NULL,
  connected_at DATETIME NULL,
  ended_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_attempts_active (campaign_id, status),
  KEY idx_attempts_started (campaign_id, started_at),
  KEY lead_id (lead_id),
  CONSTRAINT dial_attempts_ibfk_1 FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
  CONSTRAINT dial_attempts_ibfk_2 FOREIGN KEY (lead_id) REFERENCES leads (id),
  CONSTRAINT dial_attempts_ibfk_3 FOREIGN KEY (call_id) REFERENCES calls (id),
  CONSTRAINT dial_attempts_ibfk_4 FOREIGN KEY (agent_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Lets the backend's AMI handlers (AgentConnect / AgentComplete) find a
-- dialer call by its Asterisk channel name - the dialer engine is a
-- separate process, so the backend's in-memory channel map can't know it.
ALTER TABLE calls
  ADD COLUMN channel_name VARCHAR(100) NULL,
  ADD COLUMN dial_attempt_id INT NULL,
  ADD INDEX idx_calls_channel_name (channel_name);

-- How long an answered customer may wait for a free agent before the call
-- counts as abandoned (they hear a short message and the call ends).
ALTER TABLE campaigns ADD COLUMN abandon_wait_sec INT NOT NULL DEFAULT 5;

-- Live pacing numbers for the Dialer page.
ALTER TABLE dialer_status
  ADD COLUMN in_flight INT NOT NULL DEFAULT 0,
  ADD COLUMN active_calls INT NOT NULL DEFAULT 0;
