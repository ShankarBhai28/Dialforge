-- Native Queue() integration: for an inbound call routed into a real
-- Asterisk queue, we don't know which agent will answer at the moment
-- we insert the calls row (Asterisk's own queue engine decides that,
-- not us) - only once AMI's AgentConnect event tells us.
ALTER TABLE calls MODIFY from_extension VARCHAR(50) NULL;
