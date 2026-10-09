// Which extensions an agent may connect with, and who is using one now.
//
// An agent picks which extension (device) to use each shift. Two rules
// decide what they may pick:
//
// 1. Allowed: if any of the agent's active teams lists extensions
//    (Teams screen), the agent may use those plus their own assigned
//    extension. If none of their teams lists any, every extension is
//    allowed - the behaviour before team extensions existed.
// 2. Free: never one a colleague is using right now - the credentials
//    would let them register over the colleague's line and take their
//    calls. "Using right now" = the extension is in another agent's open
//    status session AND is registered in Asterisk. Requiring both keeps a
//    stale session (browser closed without logging out) from locking it.
//
// Admins aren't restricted by rule 1.
const pool = require('../../db');
const ari = require('../../ari');

async function findOtherActiveHolder(extensionName, userId, deps = { pool, ari }) {
  const [rows] = await deps.pool.query(
    `SELECT u.username FROM agent_status_log asl JOIN users u ON u.id = asl.user_id
     WHERE asl.extension_name = ? AND asl.ended_at IS NULL AND asl.user_id <> ?
     ORDER BY asl.id DESC LIMIT 1`,
    [extensionName, userId],
  );
  if (!rows[0]) return null;
  return (await deps.ari.isEndpointOnline(`PJSIP/${extensionName}`)) ? rows[0].username : null;
}

/** Team extensions + own extension -> sorted names, or null = any extension. */
function combineAllowed(teamExtensions, ownExtension) {
  if (!teamExtensions.length) return null;
  const names = new Set(teamExtensions);
  if (ownExtension) names.add(ownExtension);
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Extension names this user may connect with, or null = any. */
async function allowedExtensions(user, deps = { pool }) {
  if (user.role === 'admin') return null;
  const [teamRows] = await deps.pool.query(
    `SELECT DISTINCT e.name FROM team_members tm
     JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
     JOIN team_extensions te ON te.team_id = t.id
     JOIN extensions e ON e.id = te.extension_id
     WHERE tm.user_id = ?`,
    [user.id],
  );
  const [ownRows] = await deps.pool.query(
    'SELECT e.name FROM users u JOIN extensions e ON e.id = u.extension_id WHERE u.id = ?',
    [user.id],
  );
  return combineAllowed(
    teamRows.map((r) => r.name),
    ownRows[0]?.name,
  );
}

module.exports = { findOtherActiveHolder, allowedExtensions, combineAllowed };
