-- 0008: live_agents - one row per agent logged in right now, so "who is
-- online and what are they doing" is one SELECT:
--   SELECT * FROM live_agents;
-- It is a snapshot the backend rewrites every few seconds (and right after a
-- status change) from the real sources: agent_status_log (status),
-- calls (current call), the agent screens' live connections (screen_open),
-- Asterisk (line), audit_log (login time). Don't edit it - an agent who
-- logged out disappears from it at the next refresh. To fix a stuck agent,
-- fix the source (Live Agents -> Force logout, or npm run db:check -- --fix).
CREATE TABLE live_agents (
  user_id INT NOT NULL PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  extension VARCHAR(50) NULL,
  -- what they're doing: logged_in (no queue picked yet) | available | break | acw | on_call
  state VARCHAR(20) NOT NULL,
  status VARCHAR(30) NULL,           -- the status row's status (available / break / acw)
  reason VARCHAR(100) NULL,          -- break reason
  status_since DATETIME NULL,
  login_at DATETIME NULL,
  queue_id INT NULL,
  queue_name VARCHAR(100) NULL,
  campaign_id INT NULL,
  campaign_name VARCHAR(100) NULL,
  call_id INT NULL,
  call_number VARCHAR(20) NULL,
  call_since DATETIME NULL,          -- connected to the customer (or started, while ringing)
  line VARCHAR(12) NOT NULL DEFAULT 'unknown',  -- registered | unregistered | unknown (Asterisk not asked)
  screen_open TINYINT(1) NOT NULL DEFAULT 0,   -- the agent screen is connected to the backend
  last_seen_at DATETIME NULL,        -- last refresh that saw their screen or line
  updated_at DATETIME NOT NULL,
  KEY live_agents_state (state)
);
