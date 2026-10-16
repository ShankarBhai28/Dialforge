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
-- become the lead's current values. Per field, the latest answer that isn't
-- empty wins; an empty answer never wipes a value (JSON_MERGE_PATCH would
-- delete a key for a null, so empties are left out before merging).
UPDATE leads l
JOIN (
  SELECT t.lead_id, JSON_OBJECTAGG(t.k, t.v) AS vals
  FROM (
    SELECT r.lead_id, jt.k, JSON_EXTRACT(r.data, CONCAT('$."', jt.k, '"')) AS v,
           ROW_NUMBER() OVER (PARTITION BY r.lead_id, jt.k ORDER BY r.id DESC) AS rn
    FROM form_responses r,
         JSON_TABLE(JSON_KEYS(r.data), '$[*]' COLUMNS (k VARCHAR(64) PATH '$')) jt
    WHERE r.lead_id IS NOT NULL
      AND JSON_TYPE(JSON_EXTRACT(r.data, CONCAT('$."', jt.k, '"'))) <> 'NULL'
      AND JSON_UNQUOTE(JSON_EXTRACT(r.data, CONCAT('$."', jt.k, '"'))) <> ''
      AND NOT (JSON_TYPE(JSON_EXTRACT(r.data, CONCAT('$."', jt.k, '"'))) = 'ARRAY'
               AND JSON_LENGTH(JSON_EXTRACT(r.data, CONCAT('$."', jt.k, '"'))) = 0)
  ) t
  WHERE t.rn = 1
  GROUP BY t.lead_id
) x ON x.lead_id = l.id
SET l.custom_data = JSON_MERGE_PATCH(COALESCE(l.custom_data, JSON_OBJECT()), x.vals);
