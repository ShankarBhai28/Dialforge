// Who may do what on the admin side.
//
// Account types (users.role):
//   admin - Super Admin: everything, everywhere. Only they manage roles and
//           staff accounts.
//   staff - an admin login limited by a role (users.role_id -> roles): per
//           screen, the actions ticked (view, create, edit, delete, and a
//           few screen-specific ones), and a data scope:
//             all  - every team's data on the screens they may open
//             team - only the campaigns and agents of the teams they are a
//                    member of (Teams screen)
//   agent - the agent screen only; never the admin side.
//
// Any action implies view. A team-scoped role can't have the actions that
// reach outside its teams (TEAM_SCOPE_BLOCKED).
const pool = require('../../db');

const ACTION_LABELS = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  control: 'Start / Pause / Stop',
  import: 'Import',
  recycle: 'Recycle',
  cancel: 'Cancel',
  password: 'Reset password',
  export: 'Export CSV',
};

const CRUD = ['view', 'create', 'edit', 'delete'];
const SCREENS = [
  { key: 'dashboard', label: 'Dashboard', actions: ['view'] },
  { key: 'live', label: 'Live Agents', actions: ['view'] },
  { key: 'dialer', label: 'Dialer', actions: ['view', 'control'] },
  { key: 'calls', label: 'Call Log', actions: ['view'] },
  { key: 'campaigns', label: 'Campaigns', actions: CRUD },
  { key: 'leads', label: 'Leads & Lists', actions: [...CRUD, 'import', 'recycle'] },
  { key: 'forms', label: 'Forms', actions: CRUD },
  { key: 'callbacks', label: 'Callbacks', actions: ['view', 'cancel'] },
  { key: 'dnc', label: 'DNC List', actions: ['view', 'create', 'delete'] },
  { key: 'queues', label: 'Queues', actions: CRUD },
  { key: 'numbers', label: 'DID Numbers', actions: CRUD },
  { key: 'users', label: 'Users', actions: ['view', 'create', 'edit', 'password'] },
  { key: 'teams', label: 'Teams', actions: CRUD },
  { key: 'reports', label: 'Reports', actions: ['view', 'export'] },
];
const SCREEN_KEYS = SCREENS.map((s) => s.key);
const SCREEN_ACTIONS = Object.fromEntries(SCREENS.map((s) => [s.key, s.actions]));
const SCOPES = ['all', 'team'];

/** Actions an own-teams role can't have: they would reach outside its teams. */
const TEAM_SCOPE_BLOCKED = {
  campaigns: ['create', 'delete'],
  users: ['create', 'edit', 'password'],
  teams: ['create', 'edit', 'delete'],
};

/** Stored rights -> { screen: [actions] }. Also reads the first format ('none' | 'view' | 'manage'). */
function normalizePermissions(raw) {
  const out = {};
  for (const key of SCREEN_KEYS) {
    const v = raw && raw[key];
    if (Array.isArray(v)) out[key] = SCREEN_ACTIONS[key].filter((a) => v.includes(a));
    else if (v === 'manage') out[key] = [...SCREEN_ACTIONS[key]];
    else if (v === 'view') out[key] = ['view'];
    else out[key] = [];
  }
  return out;
}

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
  for (const screen of SCREENS) {
    const given = input[screen.key] ?? [];
    if (!Array.isArray(given)) return { error: `${screen.label}: rights must be a list of actions` };
    const bad = given.find((a) => !screen.actions.includes(a));
    if (bad) return { error: `${screen.label} has no "${bad}" action` };
    const blocked = scope === 'team' ? (TEAM_SCOPE_BLOCKED[screen.key] || []).find((a) => given.includes(a)) : null;
    if (blocked) {
      return {
        error: `${screen.label}: ${ACTION_LABELS[blocked]} needs a role that sees all teams (an own-teams role would reach outside its teams)`,
      };
    }
    // Any action needs the screen itself.
    const actions = screen.actions.filter((a) => given.includes(a) || (a === 'view' && given.length > 0));
    permissions[screen.key] = actions;
  }
  if (!Object.values(permissions).some((a) => a.length)) return { error: 'give the role at least one screen' };
  return { role: { name, scope, permissions } };
}

// --- Roles, cached (read on every staff request; changed rarely) ---
const roleCache = new Map();

function toRole(row) {
  const raw = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions;
  const permissions = normalizePermissions(raw);
  // Never report an action an own-teams role can't use (older roles were saved before this rule).
  if (row.scope === 'team') {
    for (const [screen, blocked] of Object.entries(TEAM_SCOPE_BLOCKED)) {
      permissions[screen] = permissions[screen].filter((a) => !blocked.includes(a));
    }
  }
  return { id: row.id, name: row.name, scope: row.scope, permissions };
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
 * What this user may do on the admin side: { actions(screen), scope }.
 * scope is null for "all data", else { campaignIds, agentIds, teamIds }.
 * Returns null for anyone without admin-side access.
 */
async function accessFor(user, deps = { pool }) {
  if (!user) return null;
  if (user.role === 'admin') {
    return { superAdmin: true, role: null, actions: (screen) => SCREEN_ACTIONS[screen] || [], scope: null };
  }
  if (user.role !== 'staff') return null;
  const role = await getRole(user.roleId, deps);
  if (!role) return null;
  return {
    superAdmin: false,
    role,
    actions: (screen) => role.permissions[screen] || [],
    scope: role.scope === 'team' ? await teamScope(user.id, deps) : null,
  };
}

/** May this access do `action` (view, create, edit, ...) on `screen`? */
const can = (access, screen, action) => !!access && access.actions(screen).includes(action);

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
  SCREEN_ACTIONS,
  ACTION_LABELS,
  TEAM_SCOPE_BLOCKED,
  SCOPES,
  normalizePermissions,
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
