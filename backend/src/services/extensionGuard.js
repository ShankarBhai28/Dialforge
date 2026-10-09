// An agent picks which extension (device) to use each shift, so any agent
// may connect to any extension - but not to one a colleague is using right
// now: the credentials would let them register over the colleague's line
// and take their calls.
//
// "Using right now" = the extension is in another agent's open status
// session AND is registered in Asterisk. Requiring both keeps a stale
// session (browser closed without logging out) from locking the extension.
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

module.exports = { findOtherActiveHolder };
