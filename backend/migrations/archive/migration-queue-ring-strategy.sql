-- Adds real Asterisk queue concepts to our queues table, adopted from
-- reviewing a reference product's Queue Management screen (Ringing
-- Strategy + Wait Timeout) rather than inventing our own field names.
ALTER TABLE queues
  ADD COLUMN ring_strategy VARCHAR(20) NOT NULL DEFAULT 'ringall',
  ADD COLUMN wait_timeout INT NOT NULL DEFAULT 30;
