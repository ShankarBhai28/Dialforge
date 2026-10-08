-- Predictive-dialer work, step D2: Custom Forms.
-- An admin builds a form (a named set of fields); a campaign points at one
-- active form; the agent working that campaign fills it in per call and the
-- answers are saved as one form_responses row.
CREATE TABLE forms (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_form_name (tenant_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- field_key is the stable machine name (e.g. loan_amount): responses are
-- stored keyed by it, and in D4 it becomes the Excel column header for
-- lead upload. options holds the choices for dropdown/radio/checkbox.
CREATE TABLE form_fields (
  id INT NOT NULL AUTO_INCREMENT,
  form_id INT NOT NULL,
  field_key VARCHAR(50) NOT NULL,
  label VARCHAR(100) NOT NULL,
  field_type VARCHAR(20) NOT NULL,
  options JSON NULL,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_form_field_key (form_id, field_key),
  CONSTRAINT form_fields_ibfk_1 FOREIGN KEY (form_id) REFERENCES forms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per saved submission. data is a JSON object {field_key: value},
-- so editing a form's fields later never breaks old responses.
CREATE TABLE form_responses (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL DEFAULT 1,
  form_id INT NOT NULL,
  campaign_id INT NULL,
  lead_id INT NULL,
  call_id INT NULL,
  user_id INT NOT NULL,
  data JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY form_id (form_id),
  KEY lead_id (lead_id),
  KEY call_id (call_id),
  CONSTRAINT form_responses_ibfk_1 FOREIGN KEY (form_id) REFERENCES forms (id),
  CONSTRAINT form_responses_ibfk_2 FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
  CONSTRAINT form_responses_ibfk_3 FOREIGN KEY (lead_id) REFERENCES leads (id),
  CONSTRAINT form_responses_ibfk_4 FOREIGN KEY (call_id) REFERENCES calls (id),
  CONSTRAINT form_responses_ibfk_5 FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE campaigns
  ADD COLUMN form_id INT NULL,
  ADD CONSTRAINT campaigns_form_fk FOREIGN KEY (form_id) REFERENCES forms (id);
