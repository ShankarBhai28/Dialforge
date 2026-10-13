-- Leads become campaign-scoped instead of one flat global list - an
-- agent should only see/dial leads belonging to whichever campaign
-- they're currently working.
ALTER TABLE leads ADD COLUMN campaign_id INT NULL, ADD FOREIGN KEY (campaign_id) REFERENCES campaigns(id);
