-- 0021: indexes the load test showed missing. With 90 days of 200 agents
-- (4.8 M status rows, 7.5 M attempts) each of these queries read the whole
-- table - 15 s to 5 min each, and the dashboard never loaded:
--   agent_status_log  "who is in which status now" (ended_at IS NULL: Live
--                     Agents, presence, the dashboard) and "this agent's
--                     latest queue" (ORDER BY id DESC, all of an agent's rows
--                     when none has a queue - an admin's, every request)
--   dial_attempts     the stale-attempt check (status <> 'ended', every few
--                     seconds) and today's figures over all campaigns
--                     (started_at; the old index starts with campaign_id)
-- Building them on a big table takes minutes (about 10 for the above);
-- MySQL keeps the tables usable meanwhile.
ALTER TABLE agent_status_log
  ADD KEY asl_open (ended_at, user_id),
  ADD KEY asl_user_latest (user_id, id);
ALTER TABLE dial_attempts
  ADD KEY attempts_status (status),
  ADD KEY attempts_started_at (started_at);
