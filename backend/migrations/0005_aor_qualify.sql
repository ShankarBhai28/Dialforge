-- 0005: Asterisk pings every browser phone (qualify every 30 s).
-- Without it, an extension Asterisk didn't already know at its last start /
-- reload never shows as online when it registers (pjsip_options.c ignores
-- the new contact of an unknown AOR unless qualify is on): ARI says
-- "offline", the device is "Unavailable", queues skip the agent and call
-- monitoring says the line isn't connected - until someone reloads
-- Asterisk. With qualify on, a registration always brings the extension in,
-- and a browser that vanished without unregistering shows offline within
-- ~30 s instead of at expiry.

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ps_aors AS
  SELECT name AS id, 1 AS max_contacts, 'yes' AS remove_existing, 30 AS qualify_frequency
  FROM extensions
  WHERE enabled = 1 AND deleted_at IS NULL AND sip_password IS NOT NULL AND sip_password <> '';
