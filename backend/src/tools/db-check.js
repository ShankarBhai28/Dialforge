// Database health check - read-only, nothing is written.
// Does the DB agree with itself? Each check prints OK, or CHECK with up to 5
// of the rows that look wrong. Run on the server:
//   cd ~/dialforge-backend && npm run db:check
// Exit code 1 when something needs a look (usable from cron / monitoring).
require('dotenv').config();
const pool = require('../../db');

const CHECKS = [
  // --- agents ---
  [
    'Agent with more than one open status',
    `SELECT user_id, COUNT(*) n FROM agent_status_log WHERE ended_at IS NULL GROUP BY user_id HAVING n > 1`,
  ],
  [
    'Open status older than 12 h (stuck)',
    `SELECT asl.id, u.username, asl.status, asl.started_at FROM agent_status_log asl JOIN users u ON u.id = asl.user_id WHERE asl.ended_at IS NULL AND asl.started_at < NOW() - INTERVAL 12 HOUR`,
  ],
  [
    'Open status of an inactive / non-agent user',
    `SELECT asl.id, u.username, u.role, u.status FROM agent_status_log asl JOIN users u ON u.id = asl.user_id WHERE asl.ended_at IS NULL AND (u.status <> 'active' OR u.role <> 'agent')`,
  ],
  ['Status row ended before it started', `SELECT id FROM agent_status_log WHERE ended_at < started_at`],
  ['Agent without an extension', `SELECT id, username FROM users WHERE role = 'agent' AND extension_id IS NULL`],
  [
    'Extension shared by several agents',
    `SELECT e.name, GROUP_CONCAT(u.username) users FROM users u JOIN extensions e ON e.id = u.extension_id WHERE u.role = 'agent' GROUP BY e.name HAVING COUNT(*) > 1`,
  ],
  ['Staff login without a role', `SELECT id, username FROM users WHERE role = 'staff' AND role_id IS NULL`],
  ['Role on a non-staff user', `SELECT id, username, role FROM users WHERE role <> 'staff' AND role_id IS NOT NULL`],
  [
    'No active Super Admin',
    `SELECT 'none' AS problem FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND status = 'active')`,
  ],
  // --- calls ---
  [
    'Call still open after 2 h (stuck)',
    `SELECT id, from_extension, to_number, start_time FROM calls WHERE end_time IS NULL AND start_time < NOW() - INTERVAL 2 HOUR`,
  ],
  [
    'Call answered before it started / ended before answered',
    `SELECT id FROM calls WHERE answer_time < start_time OR end_time < answer_time`,
  ],
  [
    'Ended call without an outcome (disposition)',
    `SELECT id, direction, start_time FROM calls WHERE end_time IS NOT NULL AND disposition IS NULL`,
  ],
  [
    'Call pointing at a missing lead',
    `SELECT c.id, c.lead_id FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.lead_id IS NOT NULL AND l.id IS NULL`,
  ],
  [
    'Call without any call_events (no audit trail)',
    `SELECT c.id, c.start_time FROM calls c WHERE NOT EXISTS (SELECT 1 FROM call_events e WHERE e.call_id = c.id)`,
  ],
  [
    'Answered call without an outcome on its lead (agent never saved one)',
    `SELECT c.id, c.lead_id, l.status FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.answer_time IS NOT NULL AND l.status = 'new' AND c.end_time < NOW() - INTERVAL 10 MINUTE`,
  ],
  // --- dialer ---
  [
    'Dial attempt still open after 2 h',
    `SELECT id, campaign_id, lead_id, started_at FROM dial_attempts WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL 2 HOUR`,
  ],
  [
    'Hopper row locked for more than 10 min',
    `SELECT id, campaign_id, lead_id, locked_at FROM dial_hopper WHERE status = 'locked' AND locked_at < NOW() - INTERVAL 10 MINUTE`,
  ],
  [
    'Hopper row for a lead that is final / gone',
    `SELECT h.id, h.lead_id FROM dial_hopper h LEFT JOIN leads l ON l.id = h.lead_id WHERE l.id IS NULL OR l.is_final = 1`,
  ],
  [
    'Dialer running on a manual / paused campaign',
    `SELECT id, name, dial_mode, status, dialer_state FROM campaigns WHERE dialer_state = 'running' AND (dial_mode = 'manual' OR status <> 'active')`,
  ],
  // --- leads, lists, callbacks ---
  [
    'Lead whose list is in another campaign',
    `SELECT l.id, l.campaign_id, ls.campaign_id list_campaign FROM leads l JOIN lists ls ON ls.id = l.list_id WHERE NOT (ls.campaign_id <=> l.campaign_id)`,
  ],
  [
    'Lead status that is not a disposition of its campaign',
    `SELECT l.id, l.status, l.campaign_id FROM leads l WHERE l.status <> 'new' AND l.campaign_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campaign_dispositions d WHERE d.campaign_id = l.campaign_id AND d.code = l.status)`,
  ],
  [
    'Same phone twice in one campaign',
    `SELECT campaign_id, phone, COUNT(*) n FROM leads GROUP BY campaign_id, phone HAVING n > 1`,
  ],
  [
    'Lead on the DNC list but still dialable',
    `SELECT l.id, l.phone FROM leads l JOIN dnc_numbers d ON d.phone = l.phone WHERE l.is_final = 0`,
  ],
  [
    'Pending callback overdue by more than 1 day',
    `SELECT id, lead_id, callback_at FROM callbacks WHERE status = 'pending' AND callback_at < NOW() - INTERVAL 1 DAY`,
  ],
  [
    'Pending callback for a final lead',
    `SELECT cb.id, cb.lead_id FROM callbacks cb JOIN leads l ON l.id = cb.lead_id WHERE cb.status = 'pending' AND l.is_final = 1`,
  ],
  [
    'Form response without user / form',
    `SELECT r.id FROM form_responses r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN forms f ON f.id = r.form_id WHERE u.id IS NULL OR f.id IS NULL`,
  ],
  // --- setup ---
  ['Campaign without a queue', `SELECT id, name FROM campaigns WHERE queue_id IS NULL`],
  [
    'Campaign without dispositions',
    `SELECT c.id, c.name FROM campaigns c WHERE NOT EXISTS (SELECT 1 FROM campaign_dispositions d WHERE d.campaign_id = c.id)`,
  ],
  [
    'Campaign in no team (no agent can work it)',
    `SELECT c.id, c.name FROM campaigns c WHERE NOT EXISTS (SELECT 1 FROM team_campaigns tc WHERE tc.campaign_id = c.id)`,
  ],
  [
    'Active agent in no team (sees no campaign)',
    `SELECT u.id, u.username FROM users u WHERE u.role = 'agent' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id)`,
  ],
  [
    'DID pointing at a missing campaign',
    `SELECT d.id, d.number FROM dids d LEFT JOIN campaigns c ON c.id = d.campaign_id WHERE d.campaign_id IS NOT NULL AND c.id IS NULL`,
  ],
  [
    'Extension without a SIP password',
    `SELECT id, name FROM extensions WHERE sip_password IS NULL OR sip_password = ''`,
  ],
  // --- logins ---
  [
    'Expired login sessions not cleaned up (older than 1 day)',
    `SELECT COUNT(*) n FROM sessions WHERE expires < NOW() - INTERVAL 1 DAY HAVING n > 0`,
  ],
];

(async () => {
  let problems = 0;
  for (const [title, sql] of CHECKS) {
    try {
      const [rows] = await pool.query(sql);
      if (!rows.length) console.log(`OK    ${title}`);
      else {
        problems++;
        console.log(`CHECK ${title}: ${rows.length}`);
        for (const r of rows.slice(0, 5)) console.log('        ', JSON.stringify(r));
      }
    } catch (err) {
      console.log(`ERR   ${title}: ${err.message}`);
    }
  }
  console.log(`\n${problems} check(s) need a look, ${CHECKS.length - problems} OK`);
  await pool.end();
  process.exitCode = problems ? 1 : 0;
})();
