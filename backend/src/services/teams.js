// Team form rules, kept pure so they're easy to test. The route then
// checks that every id really exists (checkTeamRefs).
const pool = require('../../db');

const STATUSES = ['active', 'inactive'];

/** A list of ids from the form -> sorted unique numbers, or null if any isn't a positive whole number. */
function parseIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const ids = value.map(Number);
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) return null;
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** POST/PUT /admin/teams body -> { error } or { team }. */
function parseTeam(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name is required' };
  if (name.length > 100) return { error: 'name must be 100 characters or fewer' };
  const status = body.status || 'active';
  if (!STATUSES.includes(status)) return { error: 'status must be active or inactive' };
  const team = { name, status };
  for (const [key, label] of [
    ['memberIds', 'agents'],
    ['campaignIds', 'campaigns'],
  ]) {
    team[key] = parseIds(body[key]);
    if (!team[key]) return { error: `${label} must be a list of ids` };
  }
  return { team };
}

/** Every id must exist (and members must be agents); returns an error naming the bad ones, or null. */
async function checkTeamRefs({ memberIds, campaignIds }, deps = { pool }) {
  const checks = [
    [memberIds, "SELECT id FROM users WHERE role = 'agent' AND id IN (?)", 'agent'],
    [campaignIds, 'SELECT id FROM campaigns WHERE id IN (?)', 'campaign'],
  ];
  for (const [ids, sql, label] of checks) {
    if (!ids.length) continue;
    const [rows] = await deps.pool.query(sql, [ids]);
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) return `unknown ${label} id(s): ${missing.join(', ')} - refresh the page and try again`;
  }
  return null;
}

module.exports = { parseIds, parseTeam, checkTeamRefs };
