-- 0022: Live Agents warning times per campaign. A break turns amber after
-- break_warn_min and red after break_alert_min minutes; a wrap-up turns red
-- when it runs acw_warn_sec seconds past the campaign's wrap-up time.
-- The defaults keep the earlier fixed limits (break 15 min, wrap-up + 60 s)
-- and add the amber step at 10 minutes.
ALTER TABLE campaigns
  ADD COLUMN break_warn_min INT NOT NULL DEFAULT 10,
  ADD COLUMN break_alert_min INT NOT NULL DEFAULT 15,
  ADD COLUMN acw_warn_sec INT NOT NULL DEFAULT 60;
