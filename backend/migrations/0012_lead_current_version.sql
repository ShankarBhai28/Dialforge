-- 0012: the lead holds the CURRENT version of its form fields (custom_data);
-- every save is kept as history. A form save keeps its full answers (data)
-- and, from now on, what it changed (changes: [{key, from, to}]).
ALTER TABLE form_responses ADD COLUMN changes JSON NULL;

-- Answers saved during a first call, before the lead existed, belong to the
-- lead that call was later linked to.
UPDATE form_responses r JOIN calls c ON c.id = r.call_id
SET r.lead_id = c.lead_id
WHERE r.lead_id IS NULL AND c.lead_id IS NOT NULL;

-- Until now the agent's latest answers lived only in form_responses: they
-- become the lead's current values (empty answers don't wipe a value).
UPDATE leads l
JOIN (
  SELECT r.lead_id, r.data FROM form_responses r
  JOIN (SELECT lead_id, MAX(id) AS id FROM form_responses WHERE lead_id IS NOT NULL GROUP BY lead_id) m ON m.id = r.id
) x ON x.lead_id = l.id
SET l.custom_data = JSON_MERGE_PATCH(COALESCE(l.custom_data, JSON_OBJECT()), x.data);
