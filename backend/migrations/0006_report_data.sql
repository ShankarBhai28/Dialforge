-- 0006: what the reports need on each call (docs/plans/REPORTS_PLAN.md).
-- calls.agent_user_id      the agent who took the call (until now reports
--                          guessed it from the extension + time)
-- calls.agent_connect_time when the agent and the customer were connected
--                          (queue wait = this - entering the queue)
-- calls.outcome / outcome_at  the agent's disposition for THIS call (the
--                          lead only keeps its latest status)
-- calls.did                the number an inbound caller dialed
-- campaign_dispositions.is_success  outcomes that count as a success
--                          (sale, interested) for conversion %
-- Existing calls are filled in from the status log, call events and audit log.

ALTER TABLE calls
  ADD COLUMN agent_user_id INT NULL,
  ADD COLUMN agent_connect_time DATETIME NULL,
  ADD COLUMN outcome VARCHAR(30) NULL,
  ADD COLUMN outcome_at DATETIME NULL,
  ADD COLUMN did VARCHAR(20) NULL,
  ADD KEY calls_start (start_time),
  ADD KEY calls_agent_start (agent_user_id, start_time),
  ADD CONSTRAINT calls_agent_user FOREIGN KEY (agent_user_id) REFERENCES users (id);

ALTER TABLE campaign_dispositions ADD COLUMN is_success TINYINT(1) NOT NULL DEFAULT 0;
UPDATE campaign_dispositions SET is_success = 1 WHERE code = 'interested';

-- Agent: the dialer knew it; otherwise who was on that extension at the time.
-- (JOIN users: old rows can point at users removed by hand long ago.)
UPDATE calls ca JOIN dial_attempts da ON da.id = ca.dial_attempt_id JOIN users u ON u.id = da.agent_user_id
  SET ca.agent_user_id = da.agent_user_id
  WHERE ca.agent_user_id IS NULL AND da.agent_user_id IS NOT NULL;
UPDATE calls ca JOIN agent_status_log asl
    ON asl.extension_name = ca.from_extension
   AND ca.start_time >= asl.started_at
   AND (asl.ended_at IS NULL OR ca.start_time <= asl.ended_at)
  JOIN users u ON u.id = asl.user_id
  SET ca.agent_user_id = asl.user_id
  WHERE ca.agent_user_id IS NULL AND ca.from_extension IS NOT NULL;

-- Connected: queue / dialer calls when an agent took them; click-to-call when the customer answered.
UPDATE calls ca JOIN (
    SELECT call_id, MIN(created_at) AS t FROM call_events WHERE event_type = 'agent_answered' GROUP BY call_id
  ) e ON e.call_id = ca.id
  SET ca.agent_connect_time = e.t
  WHERE ca.dial_attempt_id IS NOT NULL OR ca.direction = 'inbound';
UPDATE calls SET agent_connect_time = answer_time
  WHERE agent_connect_time IS NULL AND dial_attempt_id IS NULL AND direction = 'outbound'
    AND answer_time IS NOT NULL AND from_extension IS NOT NULL;

-- DID of inbound calls.
UPDATE calls ca JOIN call_events e ON e.call_id = ca.id AND e.event_type = 'queued'
  SET ca.did = LEFT(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.dialedNumber')), 20)
  WHERE ca.direction = 'inbound' AND JSON_EXTRACT(e.payload, '$.dialedNumber') IS NOT NULL;

-- Outcomes from the audit log ("<code>" or "<code> (call <id>)"), latest per call.
CREATE TEMPORARY TABLE tmp_outcomes AS
  SELECT a.id, CAST(a.at AS DATETIME) AS at, a.entity_id AS lead_id, SUBSTRING_INDEX(a.summary, ' ', 1) AS code,
         IF(a.summary LIKE '% (call %)',
            CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(a.summary, '(call ', -1), ')', 1) AS UNSIGNED), NULL) AS call_id
  FROM audit_log a
  WHERE a.action = 'leads.outcome' AND a.summary IS NOT NULL AND (a.status IS NULL OR a.status = 200);
UPDATE tmp_outcomes o
  SET o.call_id = (SELECT c.id FROM calls c WHERE c.lead_id = o.lead_id AND c.start_time <= o.at ORDER BY c.id DESC LIMIT 1)
  WHERE o.call_id IS NULL;
CREATE TEMPORARY TABLE tmp_latest AS
  SELECT call_id, code, at FROM (
    SELECT call_id, code, at, ROW_NUMBER() OVER (PARTITION BY call_id ORDER BY id DESC) AS n
    FROM tmp_outcomes WHERE call_id IS NOT NULL
  ) x WHERE n = 1;
UPDATE calls ca JOIN tmp_latest o ON o.call_id = ca.id
  SET ca.outcome = LEFT(o.code, 30), ca.outcome_at = o.at
  WHERE ca.outcome IS NULL;
DROP TEMPORARY TABLE tmp_latest;
DROP TEMPORARY TABLE tmp_outcomes;
