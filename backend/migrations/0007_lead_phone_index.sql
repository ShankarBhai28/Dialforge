-- 0007: find a lead by phone number quickly. Every inbound call (and every
-- number typed on the dialpad) is matched to its lead by number, so the
-- agent sees who is calling and the customer's history.
ALTER TABLE leads ADD KEY leads_phone (phone), ADD KEY leads_alt_phone (alt_phone);
