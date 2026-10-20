-- 0018: the agent's form as typed, saved automatically while they type, so
-- closing the lead, Clear, another lead or a reload loses nothing. One row
-- per agent per lead / call / blank form (draft_key: 'lead:7', 'call:55',
-- 'blank'); restored when the form opens again. A Save (form_responses)
-- marks it saved; Discard marks it discarded. Rows are kept: support can see
-- what an agent typed and when, even when it was never saved.
CREATE TABLE form_drafts (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  draft_key VARCHAR(40) NOT NULL,
  form_id INT NOT NULL,
  campaign_id INT NULL,
  lead_id INT NULL,
  call_id INT NULL,
  data JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  saved_at DATETIME NULL,
  discarded_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY form_drafts_user_key (user_id, draft_key),
  KEY form_drafts_lead (lead_id),
  CONSTRAINT form_drafts_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
);
