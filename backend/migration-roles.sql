-- Admin roles with restricted rights (Team Leader, Supervisor, ...).
--
-- users.role stays the account type:
--   'admin' = Super Admin (everything; the only one who manages roles)
--   'agent' = takes calls on the agent screen
--   'staff' = admin login limited by users.role_id (a row here)
-- roles.permissions: { "<screen>": "none" | "view" | "manage" } - see
-- src/services/access.js for the screen list.
-- roles.scope: 'all' = every team's data, 'team' = only the teams the user
-- is a member of (Teams screen).
-- Nothing changes on deploy: no staff users or roles exist yet.
CREATE TABLE roles (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  name VARCHAR(50) NOT NULL,
  scope VARCHAR(10) NOT NULL DEFAULT 'all',
  permissions JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_role_name (tenant_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE users
  ADD COLUMN role_id INT NULL AFTER role,
  ADD CONSTRAINT users_role_fk FOREIGN KEY (role_id) REFERENCES roles (id);
