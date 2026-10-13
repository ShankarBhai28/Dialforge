-- Records which extension an agent was ACTUALLY using at the time of
-- each status row, not their login account's assigned extension -
-- those two can differ (picking a device is a per-shift choice), and
-- "who is currently on extension X" needs to be resolvable correctly
-- from this table, not from users.extension_id which is static.
ALTER TABLE agent_status_log ADD COLUMN extension_name VARCHAR(50) NULL;
