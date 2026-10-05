-- Tracks agent status transitions (available / break / acw) with a reason
-- for breaks. This is what the dashboard's Login/Talk/Break/Handle/ACW
-- time tiles are actually computed from - not just cosmetic timers.
CREATE TABLE agent_status_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  status      VARCHAR(30) NOT NULL,  -- 'available', 'break', 'acw'
  reason      VARCHAR(100) NULL,     -- e.g. 'Lunch', 'Tea Break', 'Meeting' (only for status='break')
  started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at    DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_agent_status_user_time ON agent_status_log(user_id, started_at);
