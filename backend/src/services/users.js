// Account rules shared by the user routes, kept pure so they're easy to test.
//
// Account types: admin (Super Admin), staff (admin login limited by a role,
// role_id) and agent (agent screen; needs an extension).
const ROLES = ['admin', 'agent', 'staff'];
const STATUSES = ['active', 'inactive'];
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,50}$/;
const MIN_PASSWORD = 8;

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD)
    return `password must be at least ${MIN_PASSWORD} characters`;
  return null;
}

/** The role-dependent fields: agents need an extension, staff a role; nothing else keeps either. */
function roleFields(role, extensionId, roleId) {
  if (role === 'agent' && !extensionId) return { error: 'agent accounts must be linked to an extension' };
  if (role === 'staff' && !roleId) return { error: 'pick the role for this admin login' };
  return {
    extensionId: role === 'agent' ? extensionId : null,
    roleId: role === 'staff' ? roleId : null,
  };
}

/** POST /admin/users body -> { error } or { user } (extension / role existence is checked by the route). */
function parseNewUser(body) {
  const username = String(body.username || '').trim();
  if (!USERNAME_RE.test(username))
    return { error: 'username must be 3-50 letters, digits, dots, dashes or underscores' };
  const pwError = checkPassword(body.password);
  if (pwError) return { error: pwError };
  if (!ROLES.includes(body.role)) return { error: 'role must be admin, staff or agent' };
  const f = roleFields(
    body.role,
    body.extensionId ? Number(body.extensionId) : null,
    body.roleId ? Number(body.roleId) : null,
  );
  if (f.error) return { error: f.error };
  return { user: { username, password: body.password, role: body.role, extensionId: f.extensionId, roleId: f.roleId } };
}

/**
 * PUT /admin/users/:id body applied to the current row -> { error } or { changes }.
 * `activeAdmins` = number of active Super Admins right now; `meId` = who is asking.
 */
function parseUserUpdate(body, current, { meId, activeAdmins }) {
  const role = body.role === undefined ? current.role : body.role;
  const status = body.status === undefined ? current.status : body.status;
  if (!ROLES.includes(role)) return { error: 'role must be admin, staff or agent' };
  if (!STATUSES.includes(status)) return { error: 'status must be active or inactive' };
  const extensionId = body.extensionId === undefined ? current.extension_id : body.extensionId;
  const roleId = body.roleId === undefined ? current.role_id : body.roleId;
  const f = roleFields(role, extensionId ? Number(extensionId) : null, roleId ? Number(roleId) : null);
  if (f.error) return { error: f.error };

  const losesAdmin =
    current.role === 'admin' && current.status === 'active' && (role !== 'admin' || status !== 'active');
  if (losesAdmin && current.id === meId) return { error: "you can't remove your own Super Admin access" };
  if (losesAdmin && activeAdmins <= 1) return { error: 'there must always be at least one active Super Admin' };

  return {
    changes: { role, status, extension_id: f.extensionId, role_id: f.roleId },
    // Anything that changes what this person may do ends their open sessions.
    revoke: role !== current.role || status !== current.status || f.roleId !== (current.role_id ?? null),
  };
}

module.exports = { parseNewUser, parseUserUpdate, checkPassword, MIN_PASSWORD, ROLES };
