-- 0002: Asterisk reads agent extensions and queues from this database
-- (docs/plans/ASTERISK_REALTIME_PLAN.md). Our own tables stay the single
-- source of truth; these views only present them in the shape Asterisk's
-- realtime (ODBC) expects. Asterisk's MySQL login may read these 4 views
-- and nothing else.
--
-- Shared settings of every agent extension (WebRTC softphone in the
-- browser): context `internal`, codecs ulaw + opus, one registered device.
-- A disabled extension disappears from Asterisk (can't register).

ALTER TABLE extensions ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER sip_password;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ps_endpoints AS
  SELECT name AS id, name AS aors, name AS auth, 'internal' AS context,
         'all' AS disallow, 'ulaw,opus' AS allow, 'yes' AS webrtc
  FROM extensions
  WHERE enabled = 1 AND sip_password IS NOT NULL AND sip_password <> '';

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ps_auths AS
  SELECT name AS id, 'userpass' AS auth_type, name AS username, sip_password AS password
  FROM extensions
  WHERE enabled = 1 AND sip_password IS NOT NULL AND sip_password <> '';

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ps_aors AS
  SELECT name AS id, 1 AS max_contacts, 'yes' AS remove_existing
  FROM extensions
  WHERE enabled = 1 AND sip_password IS NOT NULL AND sip_password <> '';

-- Queue options: Asterisk turns '_' into '-' (announce_frequency ->
-- announce-frequency). Members are not here: the app adds / pauses /
-- removes them over AMI as agents change status.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW ast_queues AS
  SELECT asterisk_name AS name, ring_strategy AS strategy, wait_timeout AS timeout, retry,
         timeout_restart AS timeoutrestart,
         CASE WHEN announce = 'yes' THEN 30 ELSE 0 END AS announce_frequency,
         'no' AS ringinuse
  FROM queues
  WHERE asterisk_name IS NOT NULL AND asterisk_name <> '';
