-- Campaigns and queues: agents pick a queue before going Available, so we
-- know which campaign they were actually working during any given stretch.
CREATE TABLE campaigns (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT NOT NULL DEFAULT 1,
  name        VARCHAR(100) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE queues (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    INT NOT NULL DEFAULT 1,
  campaign_id  INT NOT NULL,
  name         VARCHAR(100) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

ALTER TABLE agent_status_log ADD COLUMN queue_id INT NULL, ADD FOREIGN KEY (queue_id) REFERENCES queues(id);
