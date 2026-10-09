// Who may do what on the admin side.
//
// Account types (users.role):
//   admin - Super Admin: everything, everywhere. Only they manage roles and
//           staff accounts.
//   staff - an admin login limited by a role (users.role_id -> roles): per
//           screen none / view / manage, and a data scope:
//             all  - every team's data on the screens they may open
//             team - only the campaigns and agents of the teams they are a
//                    member of (Teams screen)
//   agent - the agent screen only; never the admin side.
//
// view = open the screen and read it; manage = also create / edit / delete
// and the screen's actions (e.g. start the dialer).
const pool = require('../../db');

const SCREENS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'live', label: 'Live Agents' },
  { key: 'dialer', label: 'Dialer' },
  { key: 'calls', label: 'Call Log' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'leads', label: 'Leads & Lists' },
  { key: 'forms', label: 'Forms' },
  { key: 'callbacks', label: 'Callbacks' },
  { key: 'dnc', label: 'DNC List' },
  { key: 'queues', label: 'Queues' },
  { key: 'numbers', label: 'DID Numbers' },
  { key: 'users', label: 'Users' },
  { key: 'teams', label: 'Teams' },
  { key: 'reports', label: 'Reports' },
];
const SCREEN_KEYS = SCREENS.map((s) => s.key);
const LEVELS = ['none', 'view', 'manage'];
const SCOPES = ['all', 'team'];
const rank = (level) => Math.max(0, LEVELS.indexOf(level));

/** POST/PUT /admin/roles body -> { error } or { role } (every screen present, unknown keys refused). */
function parseRole(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name is required' };
  if (name.length > 50) return { error: 'name must be 50 characters or fewer' };
  if (/^(super ?admin|admin|agent)$/i.test(name))
    return { error: `"${name}" is a built-in account type - pick another name` };
  const scope = body.scope || 'all';
  if (!SCOPES.includes(scope)) return { error: 'scope must be all or team' };
  const input = body.permissions || {};
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'permissions must be an object' };
  const unknown = Object.keys(input).filter((k) => !SCREEN_KEYS.includes(k));
  if (unknown.length) return { error: `unknown screen: ${unknown[0]}` };
  const permissions = {};
  for (const key of SCREEN_KEYS) {
    const level = input[key] || 'none';
    if (!LEVELS.includes(level)) return { error: `${key}: level must be none, view or manage` };
    permissions[key] = level;
  }
  if (!Object.values(permissions).some((l) => l !== 'none')) return { error: 'give the role at least one screen' };
  return { role: { name, scope, permissions } };
}

// --- Roles, cached (read on every staff request; changed rarely) ---
const roleCache = new Map();

function toRole(row) {
  const permissions = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions;
  return { id: row.id, name: row.name, scope: row.scope, permissions: permissions || {} };
}

async function getRole(id, deps = { pool }) {
  if (!id) return null;
  if (roleCache.has(id)) return roleCache.get(id);
  const [rows] = await deps.pool.query('SELECT id, name, scope, permissions FROM roles WHERE id = ?', [id]);
  const role = rows[0] ? toRole(rows[0]) : null;
  if (role) roleCache.set(id, role);
  return role;
}

/** After a role is saved or deleted - every staff user's next request uses the new rights. */
function forgetRoles() {
  roleCache.clear();
}

/** A team-scoped user's campaigns and agents: those of the active teams they belong to. */
async function teamScope(userId, deps = { pool }) {
  const [campaigns] = await deps.pool.query(
    `SELECT DISTINCT tc.campaign_id AS id FROM team_members tm
     JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
     JOIN team_campaigns tc ON tc.team_id = t.id
     WHERE tm.user_id = ?`,
    [userId],
  );
  const [agents] = await deps.pool.query(
    `SELECT DISTINCT a.user_id AS id FROM team_members tm
     JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
     JOIN team_members a ON a.team_id = t.id
     JOIN users u ON u.id = a.user_id AND u.role = 'agent'
     WHERE tm.user_id = ?`,
    [userId],
  );
  const [teams] = await deps.pool.query(
    `SELECT tm.team_id AS id FROM team_members tm JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
     WHERE tm.user_id = ?`,
    [userId],
  );
  return {
    campaignIds: campaigns.map((r) => r.id),
    agentIds: agents.map((r) => r.id),
    teamIds: teams.map((r) => r.id),
  };
}

/**
 * What this user may do on the admin side: { level(screen), scope }.
 * scope is null for "all data", else { campaignIds, agentIds, teamIds }.
 * Returns null for anyone without admin-side access.
 */
async function accessFor(user, deps = { pool }) {
  if (!user) return null;
  if (user.role === 'admin') return { superAdmin: true, role: null, level: () => 'manage', scope: null };
  if (user.role !== 'staff') return null;
  const role = await getRole(user.roleId, deps);
  if (!role) return null;
  return {
    superAdmin: false,
    role,
    level: (screen) => role.permissions[screen] || 'none',
    scope: role.scope === 'team' ? await teamScope(user.id, deps) : null,
  };
}

const can = (access, screen, level) => !!access && rank(access.level(screen)) >= rank(level);

/** SQL condition limiting `column` to the scope's ids ('' = no limit). For whereClause(). */
function scopeCondition(scope, kind, column) {
  if (!scope) return ['', []];
  const ids = kind === 'agents' ? scope.agentIds : scope.campaignIds;
  return [`${column} IN (?)`, [ids.length ? ids : [-1]]];
}

/** Is this campaign inside the scope (always true for "all")? */
const campaignInScope = (scope, campaignId) => !scope || scope.campaignIds.includes(Number(campaignId));

module.exports = {
  SCREENS,
  SCREEN_KEYS,
  LEVELS,
  SCOPES,
  parseRole,
  getRole,
  forgetRoles,
  teamScope,
  accessFor,
  can,
  scopeCondition,
  campaignInScope,
  toRole,
};
