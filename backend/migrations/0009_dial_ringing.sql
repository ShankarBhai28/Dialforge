-- 0009: when the customer's phone started ringing (SIP 180 from the trunk),
-- for the Dialer screen's live calls. Stays NULL when the trunk only sends
-- early media (183) - those calls show "Dialing" until answered.
ALTER TABLE dial_attempts ADD COLUMN ringing_at DATETIME NULL;
