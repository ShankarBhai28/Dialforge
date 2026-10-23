// Team form rules, kept pure so they're easy to test. The route then
// checks that every id really exists (checkTeamRefs) and that the parent
// team fits the tree (parentProblem).
//
// Hierarchy: a team may sit under another (TL teams under a manager's team
// under the head's team). An own-teams login sees its teams and every team
// below them (subtree); agents still work only their own teams' campaigns.
const pool = require('../../db');

const STATUSES = ['active', 'inactive'];
/** Levels in the tree, top included - head / manager / TL / sub-team and some room. */
const MAX_DEPTH = 6;

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
  const team = { name, status, parentId: null };
  if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') {
    const parentId = Number(body.parentId);
    if (!Number.isInteger(parentId) || parentId <= 0) return { error: 'parent team must be a team id' };
    team.parentId = parentId;
  }
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
    [memberIds, "SELECT id FROM users WHERE role IN ('agent', 'staff') AND id IN (?)", 'member'],
    [campaignIds, 'SELECT id FROM campaigns WHERE id IN (?) AND deleted_at IS NULL', 'campaign'],
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

/** Teams [{ id, parent_id }] -> Map parent id -> child ids. */
function childrenOf(teams) {
  const kids = new Map();
  for (const t of teams) {
    if (t.parent_id == null) continue;
    if (!kids.has(t.parent_id)) kids.set(t.parent_id, []);
    kids.get(t.parent_id).push(t.id);
  }
  return kids;
}

/** The given teams and every team below them (ids; a loop in bad data can't hang it). */
function subtree(teams, startIds) {
  const kids = childrenOf(teams);
  const seen = new Set();
  const todo = [...startIds];
  while (todo.length) {
    const id = todo.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    todo.push(...(kids.get(id) || []));
  }
  return seen;
}

/** How many levels a team and its sub-teams take (1 = no sub-teams). */
function height(teams, id) {
  const kids = childrenOf(teams);
  const walk = (tid, seen) => {
    if (seen.has(tid)) return 0;
    seen.add(tid);
    return 1 + Math.max(0, ...(kids.get(tid) || []).map((k) => walk(k, seen)));
  };
  return walk(id, new Set());
}

/** Levels from the top down to this team (1 = top level). */
function depth(teams, id) {
  const byId = new Map(teams.map((t) => [t.id, t]));
  let n = 0;
  for (let t = byId.get(id), seen = new Set(); t && !seen.has(t.id); t = byId.get(t.parent_id)) {
    seen.add(t.id);
    n++;
  }
  return n;
}

/**
 * Can team `teamId` (null = a new team) go under `parentId`? An error message, or null.
 * Not under itself or one of its own sub-teams (a loop), and the tree stays within MAX_DEPTH.
 */
function parentProblem(teams, teamId, parentId) {
  if (parentId == null) return null;
  if (!teams.some((t) => t.id === parentId))
    return `unknown parent team id: ${parentId} - refresh the page and try again`;
  if (teamId != null && subtree(teams, [teamId]).has(parentId))
    return parentId === teamId
      ? 'a team cannot be its own parent'
      : "the parent team is one of this team's own sub-teams";
  const levels = depth(teams, parentId) + (teamId == null ? 1 : height(teams, teamId));
  if (levels > MAX_DEPTH) return `too many levels: teams can be at most ${MAX_DEPTH} levels deep`;
  return null;
}

/** parentProblem with the teams read from the database. */
async function checkParent(teamId, parentId, deps = { pool }) {
  if (parentId == null) return null;
  const [teams] = await deps.pool.query('SELECT id, parent_id FROM teams');
  return parentProblem(teams, teamId, parentId);
}

module.exports = { MAX_DEPTH, parseIds, parseTeam, checkTeamRefs, subtree, parentProblem, checkParent };
