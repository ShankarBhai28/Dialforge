-- 0019: callbacks can be edited (time, note, who takes it). Roles that could
-- cancel callbacks may now also edit them; other roles get it in Roles.
UPDATE roles
SET permissions = JSON_ARRAY_APPEND(permissions, '$.callbacks', 'edit')
WHERE JSON_TYPE(JSON_EXTRACT(permissions, '$.callbacks')) = 'ARRAY'
  AND JSON_CONTAINS(JSON_EXTRACT(permissions, '$.callbacks'), '"cancel"')
  AND NOT JSON_CONTAINS(JSON_EXTRACT(permissions, '$.callbacks'), '"edit"');
