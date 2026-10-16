-- 0013: one name per customer. A campaign form field "name" is the lead's
-- name from now on; a lead whose name was only saved in the form (agents
-- filled the form's Name) gets it as its name.
UPDATE leads
SET name = LEFT(JSON_UNQUOTE(JSON_EXTRACT(custom_data, '$.name')), 100)
WHERE (name IS NULL OR name = '')
  AND JSON_TYPE(JSON_EXTRACT(custom_data, '$.name')) = 'STRING'
  AND JSON_UNQUOTE(JSON_EXTRACT(custom_data, '$.name')) <> '';
