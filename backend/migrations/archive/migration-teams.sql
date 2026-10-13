-- Predictive-dialer work, step D1: Teams.
-- A team is a group of agents; a team is mapped to the campaigns its
-- agents may work. An agent only sees (and can only go Available on)
-- queues of campaigns mapped to one of their teams.
-- Both link tables cascade on delete: removing a team, campaign, or user
-- only removes the grouping, never any call/lead data.
CREATE TABLE teams (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_team_name (tenant_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE team_members (
  team_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (team_id, user_id),
  KEY user_id (user_id),
  CONSTRAINT team_members_ibfk_1 FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT team_members_ibfk_2 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE team_campaigns (
  team_id INT NOT NULL,
  campaign_id INT NOT NULL,
  PRIMARY KEY (team_id, campaign_id),
  KEY campaign_id (campaign_id),
  CONSTRAINT team_campaigns_ibfk_1 FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT team_campaigns_ibfk_2 FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Zero-behaviour-change seed: before this migration every agent saw every
-- active campaign. Put all existing agents and campaigns into one
-- "Default Team" so nothing disappears for anyone on deploy; split into
-- real teams afterwards from the admin panel.
INSERT INTO teams (tenant_id, name) VALUES (1, 'Default Team');
SET @default_team = LAST_INSERT_ID();
INSERT INTO team_members (team_id, user_id) SELECT @default_team, id FROM users WHERE role = 'agent';
INSERT INTO team_campaigns (team_id, campaign_id) SELECT @default_team, id FROM campaigns;
