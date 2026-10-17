-- 0017: inbound campaigns with several queues.
-- campaign_queues: a campaign's queues besides its main one (campaigns.queue_id,
--   which agents always take and the dialer uses). A queue may be in several
--   campaigns; the answering agent's campaign decides form and dispositions.
-- campaigns.agents_take_all_queues: 1 = agents can't untick any of them.
-- dids.queue_id: a number now routes to a queue (a line), not a campaign;
--   existing numbers move to their campaign's main queue.
-- Dial mode 'inbound' needs no column change (dial_mode is a varchar).
CREATE TABLE campaign_queues (
  campaign_id INT NOT NULL,
  queue_id INT NOT NULL,
  PRIMARY KEY (campaign_id, queue_id),
  KEY campaign_queues_queue (queue_id),
  CONSTRAINT campaign_queues_campaign_fk FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
  CONSTRAINT campaign_queues_queue_fk FOREIGN KEY (queue_id) REFERENCES queues (id)
);

ALTER TABLE campaigns ADD COLUMN agents_take_all_queues TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE dids ADD COLUMN queue_id INT NULL,
  ADD CONSTRAINT dids_queue_fk FOREIGN KEY (queue_id) REFERENCES queues (id);
UPDATE dids d JOIN campaigns c ON c.id = d.campaign_id SET d.queue_id = c.queue_id WHERE d.queue_id IS NULL;
