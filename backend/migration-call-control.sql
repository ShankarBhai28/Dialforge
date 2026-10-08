-- Transfer / conference (call control).
-- agent_channel: the agent's Asterisk channel on a queue-delivered call
--   (from AMI AgentConnect) - needed to take the call over into our ARI
--   app. channel_name (the customer's channel) already exists.
-- transfer_ext: extension of an agent currently being consulted / added
--   to the call, so their screen shows the same lead before they own it.
ALTER TABLE calls
  ADD COLUMN agent_channel VARCHAR(100) NULL,
  ADD COLUMN transfer_ext VARCHAR(20) NULL;
