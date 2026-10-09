-- Agents always connect with the extension assigned to them (Users
-- screen), so per-team extension lists (added 2026-10-10, never used) are
-- gone. IF EXISTS: fresh installs never created the table.
DROP TABLE IF EXISTS team_extensions;
