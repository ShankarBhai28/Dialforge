// Account rules shared by the user routes, kept pure so they're easy to test.
const ROLES = ['admin', 'agent'];
const STATUSES = ['active', 'inactive'];
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,50}$/;
const MIN_PASSWORD = 8;

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD)
    return `password must be at least ${MIN_PASSWORD} characters`;
  return null;
}

/** POST /admin/users body -> { error } or { user } (extension existence is checked by the route). */
function parseNewUser(body) {
  const username = String(body.username || '').trim();
  if (!USERNAME_RE.test(username))
    return { error: 'username must be 3-50 letters, digits, dots, dashes or underscores' };
  const pwError = checkPassword(body.password);
  if (pwError) return { error: pwError };
  if (!ROLES.includes(body.role)) return { error: 'role must be admin or agent' };
  const extensionId = body.extensionId ? Number(body.extensionId) : null;
  if (body.role === 'agent' && !extensionId) return { error: 'agent accounts must be linked to an extension' };
  return {
    user: {
      username,
      password: body.password,
      role: body.role,
      extensionId: body.role === 'agent' ? extensionId : null,
    },
  };
}

/**
 * PUT /admin/users/:id body applied to the current row -> { error } or { changes }.
 * `activeAdmins` = number of active admins right now; `meId` = who is asking.
 */
function parseUserUpdate(body, current, { meId, activeAdmins }) {
  const role = body.role === undefined ? current.role : body.role;
  const status = body.status === undefined ? current.status : body.status;
  if (!ROLES.includes(role)) return { error: 'role must be admin or agent' };
  if (!STATUSES.includes(status)) return { error: 'status must be active or inactive' };
  let extensionId = body.extensionId === undefined ? current.extension_id : body.extensionId;
  extensionId = extensionId ? Number(extensionId) : null;
  if (role === 'agent' && !extensionId) return { error: 'agent accounts must be linked to an extension' };
  if (role === 'admin') extensionId = null;

  const losesAdmin =
    current.role === 'admin' && current.status === 'active' && (role !== 'admin' || status !== 'active');
  if (losesAdmin && current.id === meId) return { error: "you can't remove your own admin access" };
  if (losesAdmin && activeAdmins <= 1) return { error: 'there must always be at least one active admin' };

  return {
    changes: { role, status, extension_id: extensionId },
    // Anything that changes what this person may do ends their open sessions.
    revoke: role !== current.role || status !== current.status,
  };
}

module.exports = { parseNewUser, parseUserUpdate, checkPassword, MIN_PASSWORD };
