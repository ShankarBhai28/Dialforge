-- Adds the SIP secret for each extension so the backend can hand it to
-- an agent's browser for WebRTC registration, instead of the agent
-- needing to know/type it manually.
ALTER TABLE extensions ADD COLUMN sip_password VARCHAR(100) NULL;

UPDATE extensions SET sip_password = 'DialForge_1001_Pass!' WHERE name = '1001';
UPDATE extensions SET sip_password = 'DialForge_1002_Pass!' WHERE name = '1002';
