-- 0001 (platform database, Cloud edition - docs/plans/TENANTS_PLAN.md).
-- tenants:  the customers. code = what people type at login; db_name = the
--           customer's own database (same tables as a single install).
-- sessions: every customer's logins (read before we know whose they are),
--           with the customer in tenant_code - the same table as in a
--           customer database plus that column.
CREATE TABLE tenants (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL,
  db_name VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY tenants_code (code),
  UNIQUE KEY tenants_db (db_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (
  sid VARCHAR(128) NOT NULL,
  user_id INT DEFAULT NULL,
  tenant_code VARCHAR(30) NOT NULL DEFAULT '',
  expires DATETIME NOT NULL,
  data MEDIUMTEXT NOT NULL,
  PRIMARY KEY (sid),
  KEY sessions_user (tenant_code, user_id),
  KEY sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
