-- Restructures queue/campaign relationship to match how real dialer
-- software (reviewed reference product) actually models it: Queue is a
-- standalone, reusable entity (its own ring/timeout/retry config); a
-- Campaign references one queue, not the other way around. Also adds
-- real fields Campaign needs for what DialForge actually does today:
-- which CLI to present outbound, and whether inbound calls on this
-- campaign auto-answer or show the agent an Accept/Reject popup.

ALTER TABLE queues DROP FOREIGN KEY queues_ibfk_1;
ALTER TABLE queues DROP COLUMN campaign_id;
ALTER TABLE queues
  ADD COLUMN announce VARCHAR(10) NOT NULL DEFAULT 'no',
  ADD COLUMN retry INT NOT NULL DEFAULT 1,
  ADD COLUMN timeout_restart VARCHAR(10) NOT NULL DEFAULT 'yes';

ALTER TABLE campaigns
  ADD COLUMN queue_id INT NULL,
  ADD COLUMN outbound_caller_id VARCHAR(20) NULL,
  ADD COLUMN auto_answer TINYINT(1) NOT NULL DEFAULT 0,
  ADD FOREIGN KEY (queue_id) REFERENCES queues(id);

-- So an inbound call's ring behavior (and later, reporting) can be tied
-- back to the campaign it belongs to.
ALTER TABLE calls
  ADD COLUMN campaign_id INT NULL,
  ADD COLUMN auto_answer TINYINT(1) NULL,
  ADD FOREIGN KEY (campaign_id) REFERENCES campaigns(id);
