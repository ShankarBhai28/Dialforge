-- Predictive-dialer work, step D8: adaptive (predictive) pacing.
-- The engine's live view of each predictive campaign, shown on the Dialer
-- page. ratio_adjust is the self-tuning factor (lowered when abandons go
-- over target); it's stored so an engine restart keeps what it learned.
ALTER TABLE dialer_status
  ADD COLUMN current_ratio DECIMAL(4,2) NULL,
  ADD COLUMN answer_rate DECIMAL(5,2) NULL,
  ADD COLUMN abandon_pct DECIMAL(5,2) NULL,
  ADD COLUMN ratio_adjust DECIMAL(4,2) NULL,
  ADD COLUMN pacing_note VARCHAR(255) NULL;
