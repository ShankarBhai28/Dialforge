-- Predictive-dialer work, step D4: richer lead upload (.xlsx).
--   alt_phone   second number for the same lead
--   priority    higher = dialed earlier by the hopper (D5)
--   custom_data the campaign form's fields known before the call
--               ({field_key: value}), pre-filled into the agent's form
ALTER TABLE leads
  ADD COLUMN alt_phone VARCHAR(20) NULL AFTER phone,
  ADD COLUMN priority INT NOT NULL DEFAULT 0,
  ADD COLUMN custom_data JSON NULL;
