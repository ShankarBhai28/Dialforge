-- Which extensions (desk phones) a team's agents may connect with.
-- A team with no rows here doesn't restrict anything, so this changes
-- nothing on deploy: agents keep picking any free extension until an
-- admin ticks extensions on one of their teams (Teams screen).
-- See services/extensionGuard.js for the full rule.
CREATE TABLE team_extensions (
  team_id INT NOT NULL,
  extension_id INT NOT NULL,
  PRIMARY KEY (team_id, extension_id),
  KEY extension_id (extension_id),
  CONSTRAINT team_extensions_ibfk_1 FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT team_extensions_ibfk_2 FOREIGN KEY (extension_id) REFERENCES extensions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
