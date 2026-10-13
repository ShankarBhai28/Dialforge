-- Adds login accounts with role-based access (admin vs agent).
-- An agent account is linked to exactly one extension (the one they
-- answer calls on); an admin account has no extension.

CREATE TABLE users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT NOT NULL,
  username       VARCHAR(50) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  role           VARCHAR(20) NOT NULL,
  extension_id   INT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (extension_id) REFERENCES extensions(id)
);
