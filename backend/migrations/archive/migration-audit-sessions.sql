-- 1. audit_log: one row per admin-side change and per login / logout, so
--    "who did what, when, and what was it before" is answerable from the
--    DB alone. Written by src/services/audit.js; never updated or deleted
--    by the app.
CREATE TABLE audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  user_id INT NULL,                 -- NULL = the system (e.g. automatic logout)
  username VARCHAR(50) NULL,        -- kept as text: survives a later rename
  action VARCHAR(60) NOT NULL,      -- e.g. 'campaigns.edit', 'auth.login', 'agent.force_logout'
  entity VARCHAR(30) NULL,          -- table-ish name: campaigns, users, roles, ...
  entity_id VARCHAR(40) NULL,
  status SMALLINT NULL,             -- HTTP status of the request (403 = refused, ...)
  summary VARCHAR(255) NULL,
  request_json JSON NULL,           -- what was sent (passwords hidden)
  before_json JSON NULL,            -- the row before the change
  after_json JSON NULL,             -- the row after the change
  ip VARCHAR(45) NULL,
  PRIMARY KEY (id),
  KEY audit_at (at),
  KEY audit_entity (entity, entity_id),
  KEY audit_user (user_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. sessions: logins survive a backend restart / deploy (they were held in
--    memory before, so every deploy logged everyone out). user_id lets an
--    admin end one user's sessions (deactivate, role change, force logout).
CREATE TABLE sessions (
  sid VARCHAR(128) NOT NULL,
  user_id INT NULL,
  expires DATETIME NOT NULL,
  data MEDIUMTEXT NOT NULL,
  PRIMARY KEY (sid),
  KEY sessions_user (user_id),
  KEY sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
