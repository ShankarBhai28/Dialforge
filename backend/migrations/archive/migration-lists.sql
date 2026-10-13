-- Phase 14: named lead lists within a campaign (e.g. "Jan batch",
-- "Referral list") so a CSV import lands in a specific batch instead
-- of the campaign's flat, undifferentiated lead pool.
CREATE TABLE lists (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  campaign_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY campaign_id (campaign_id),
  CONSTRAINT lists_ibfk_1 FOREIGN KEY (campaign_id) REFERENCES campaigns (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE leads
  ADD COLUMN list_id INT DEFAULT NULL AFTER campaign_id,
  ADD CONSTRAINT leads_ibfk_4 FOREIGN KEY (list_id) REFERENCES lists (id);
