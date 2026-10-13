-- Maps a real DID (the number a caller actually dialed) to a campaign,
-- so inbound routing can pick the correct campaign/queue instead of
-- always guessing "whichever active campaign has the lowest id".
CREATE TABLE dids (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT NOT NULL DEFAULT 1,
  number      VARCHAR(20) NOT NULL UNIQUE,
  campaign_id INT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

-- Our one real, currently-live DID, mapped to the campaign it's already
-- been routing to in practice ("Support Inbound").
INSERT INTO dids (tenant_id, number, campaign_id) VALUES (1, '8065098690', 3);
