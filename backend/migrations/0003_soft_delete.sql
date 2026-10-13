-- 0003: "Delete" always works, history is kept.
-- Campaigns, queues, lists, leads, forms and extensions are referenced by
-- calls, call history and reports, so deleting one marks it (deleted_at /
-- deleted_by) instead of removing the row: it disappears from every screen,
-- dropdown, the dialer and Asterisk, while past calls and reports still show
-- it. What still pointed at it is unlinked by the delete itself (see the
-- DELETE routes). A deleted item's name can be used again.

ALTER TABLE campaigns ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN deleted_by INT NULL, ADD KEY campaigns_deleted (deleted_at);
ALTER TABLE queues ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN deleted_by INT NULL, ADD KEY queues_deleted (deleted_at);
ALTER TABLE lists ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN deleted_by INT NULL, ADD KEY lists_deleted (deleted_at);
ALTER TABLE leads ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN deleted_by INT NULL, ADD KEY leads_deleted (deleted_at);
ALTER TABLE forms ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN deleted_by INT NULL, ADD KEY forms_deleted (deleted_at);
ALTER TABLE extensions ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN deleted_by INT NULL, ADD KEY extensions_deleted (deleted_at);

-- Names must be unique only among items that aren't deleted: `alive` is 1
-- for a live row and NULL for a deleted one (NULLs never clash in a unique key).
ALTER TABLE forms ADD COLUMN alive TINYINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED;
ALTER TABLE forms ADD UNIQUE KEY uniq_form_name_alive (tenant_id, name, alive);
ALTER TABLE forms DROP INDEX uniq_form_name;

ALTER TABLE extensions ADD COLUMN alive TINYINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED;
ALTER TABLE extensions ADD UNIQUE KEY uniq_extension_alive (tenant_id, name, alive);
ALTER TABLE extensions DROP INDEX tenant_id;

-- Asterisk never sees a deleted extension or queue.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW ps_endpoints AS
  SELECT name AS id, name AS aors, name AS auth, 'internal' AS context,
         'all' AS disallow, 'ulaw,opus' AS allow, 'yes' AS webrtc
  FROM extensions
  WHERE enabled = 1 AND deleted_at IS NULL AND sip_password IS NOT NULL AND sip_password <> '';

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ps_auths AS
  SELECT name AS id, 'userpass' AS auth_type, name AS username, sip_password AS password
  FROM extensions
  WHERE enabled = 1 AND deleted_at IS NULL AND sip_password IS NOT NULL AND sip_password <> '';

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ps_aors AS
  SELECT name AS id, 1 AS max_contacts, 'yes' AS remove_existing
  FROM extensions
  WHERE enabled = 1 AND deleted_at IS NULL AND sip_password IS NOT NULL AND sip_password <> '';

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ast_queues AS
  SELECT asterisk_name AS name, ring_strategy AS strategy, wait_timeout AS timeout, retry,
         timeout_restart AS timeoutrestart,
         CASE WHEN announce = 'yes' THEN 30 ELSE 0 END AS announce_frequency,
         'no' AS ringinuse
  FROM queues
  WHERE asterisk_name IS NOT NULL AND asterisk_name <> '' AND deleted_at IS NULL;
