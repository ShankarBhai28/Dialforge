// Database health check. Does the DB agree with itself? Each check prints
// OK, or CHECK with up to 5 of the rows that look wrong. Run on the server:
//   cd ~/dialforge-backend && npm run db:check            (read-only)
//   cd ~/dialforge-backend && npm run db:check -- --fix   (repair what's safe)
// --fix first backs up the tables it will touch (~/backups/db-fix-<time>.sql),
// then repairs only the problems with an obvious, safe fix (stuck statuses,
// calls, dial attempts, hopper locks, old sessions...), then checks again.
// Problems that need a person's decision (duplicate leads, DNC leads, a
// dialer marked running) are only reported.
// Exit code 1 when something still needs a look (usable from cron / monitoring).
//
// What a DB fix can't do: things that live in Asterisk (a hung channel, a
// line still in a queue) - use Live Agents -> Force logout or Hang up; the
// app also cleans those itself (stale-agent cleanup, live_agents refresh).
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Each check: title, the SQL that finds problem rows, and optionally the
// fix: the tables it writes (backed up first) and the statements.
const CHECKS = [
  // --- agents ---
  {
    title: 'Agent with more than one open status',
    sql: `SELECT user_id, COUNT(*) n FROM agent_status_log WHERE ended_at IS NULL GROUP BY user_id HAVING n > 1`,
    fix: {
      tables: ['agent_status_log'],
      note: "keeps each agent's newest open status, closes the older ones",
      sql: [
        `UPDATE agent_status_log a JOIN (SELECT user_id, MAX(id) AS keep_id FROM agent_status_log WHERE ended_at IS NULL GROUP BY user_id HAVING COUNT(*) > 1) k ON k.user_id = a.user_id
         SET a.ended_at = NOW() WHERE a.ended_at IS NULL AND a.id <> k.keep_id`,
      ],
    },
  },
  {
    title: 'Open status older than 12 h (stuck)',
    sql: `SELECT asl.id, u.username, asl.status, asl.started_at FROM agent_status_log asl JOIN users u ON u.id = asl.user_id WHERE asl.ended_at IS NULL AND asl.started_at < NOW() - INTERVAL 12 HOUR`,
    fix: {
      tables: ['agent_status_log'],
      note: 'closes it (the agent logs in again; if their line still rings, Live Agents -> Force logout)',
      sql: [
        `UPDATE agent_status_log SET ended_at = NOW() WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL 12 HOUR`,
      ],
    },
  },
  {
    title: 'Open status of an inactive / non-agent user',
    sql: `SELECT asl.id, u.username, u.role, u.status FROM agent_status_log asl JOIN users u ON u.id = asl.user_id WHERE asl.ended_at IS NULL AND (u.status <> 'active' OR u.role <> 'agent')`,
    fix: {
      tables: ['agent_status_log'],
      note: 'closes it',
      sql: [
        `UPDATE agent_status_log asl JOIN users u ON u.id = asl.user_id SET asl.ended_at = NOW()
         WHERE asl.ended_at IS NULL AND (u.status <> 'active' OR u.role <> 'agent')`,
      ],
    },
  },
  {
    title: 'Status row ended before it started',
    sql: `SELECT id FROM agent_status_log WHERE ended_at < started_at`,
    fix: {
      tables: ['agent_status_log'],
      note: 'sets the end to the start',
      sql: [`UPDATE agent_status_log SET ended_at = started_at WHERE ended_at < started_at`],
    },
  },
  {
    title: 'Agent without an extension',
    sql: `SELECT id, username FROM users WHERE role = 'agent' AND extension_id IS NULL AND status = 'active'`,
  },
  {
    title: 'Extension shared by several agents',
    sql: `SELECT e.name, GROUP_CONCAT(u.username) users FROM users u JOIN extensions e ON e.id = u.extension_id WHERE u.role = 'agent' GROUP BY e.name HAVING COUNT(*) > 1`,
  },
  {
    title: 'Staff login without a role',
    sql: `SELECT id, username FROM users WHERE role = 'staff' AND role_id IS NULL`,
  },
  {
    title: 'Role on a non-staff user',
    sql: `SELECT id, username, role FROM users WHERE role <> 'staff' AND role_id IS NOT NULL`,
  },
  {
    title: 'No active Super Admin',
    sql: `SELECT 'none' AS problem FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND status = 'active')`,
  },
  {
    title: 'live_agents not refreshed for 2 min (is the backend running?)',
    sql: `SELECT user_id, username, updated_at FROM live_agents WHERE updated_at < NOW() - INTERVAL 2 MINUTE`,
  },
  // --- calls ---
  {
    title: 'Call still open after 2 h (stuck)',
    sql: `SELECT id, from_extension, to_number, start_time FROM calls WHERE end_time IS NULL AND start_time < NOW() - INTERVAL 2 HOUR`,
    fix: {
      tables: ['calls'],
      note: 'closes it (end = when it was answered / started - the real end is unknown)',
      sql: [
        `UPDATE calls SET end_time = COALESCE(agent_connect_time, answer_time, start_time),
           disposition = COALESCE(disposition, IF(COALESCE(agent_connect_time, answer_time) IS NULL, 'no_answer', 'ended'))
         WHERE end_time IS NULL AND start_time < NOW() - INTERVAL 2 HOUR`,
      ],
    },
  },
  {
    title: 'Call answered before it started / ended before answered',
    sql: `SELECT id FROM calls WHERE answer_time < start_time OR end_time < answer_time`,
  },
  {
    title: 'Ended call without a result (disposition)',
    sql: `SELECT id, direction, start_time FROM calls WHERE end_time IS NOT NULL AND disposition IS NULL`,
    fix: {
      tables: ['calls'],
      note: "sets 'ended' if someone talked, else 'no_answer'",
      sql: [
        `UPDATE calls SET disposition = IF(COALESCE(agent_connect_time, answer_time) IS NULL, 'no_answer', 'ended')
         WHERE end_time IS NOT NULL AND disposition IS NULL`,
      ],
    },
  },
  {
    title: 'Call pointing at a missing lead',
    sql: `SELECT c.id, c.lead_id FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.lead_id IS NOT NULL AND l.id IS NULL`,
  },
  {
    title: 'Call without any call_events (no audit trail)',
    sql: `SELECT c.id, c.start_time FROM calls c WHERE NOT EXISTS (SELECT 1 FROM call_events e WHERE e.call_id = c.id)`,
  },
  {
    title: 'Answered call with no outcome from the agent (older than 10 min)',
    sql: `SELECT id, lead_id, agent_user_id, start_time FROM calls WHERE agent_connect_time IS NOT NULL AND outcome IS NULL AND end_time < NOW() - INTERVAL 10 MINUTE`,
  },
  // --- dialer ---
  {
    title: 'Dial attempt still open after 2 h',
    sql: `SELECT id, campaign_id, lead_id, started_at FROM dial_attempts WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL 2 HOUR`,
    fix: {
      tables: ['dial_attempts'],
      note: "ends it (result 'failed' if it had none)",
      sql: [
        `UPDATE dial_attempts SET status = 'ended', ended_at = NOW(), result = COALESCE(result, 'failed')
         WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL 2 HOUR`,
      ],
    },
  },
  {
    title: 'Hopper row locked for more than 10 min',
    sql: `SELECT id, campaign_id, lead_id, locked_at FROM dial_hopper WHERE status = 'locked' AND locked_at < NOW() - INTERVAL 10 MINUTE`,
    fix: {
      tables: ['dial_hopper'],
      note: 'unlocks it (back to ready)',
      sql: [
        `UPDATE dial_hopper SET status = 'ready', locked_at = NULL, locked_by = NULL
         WHERE status = 'locked' AND locked_at < NOW() - INTERVAL 10 MINUTE`,
      ],
    },
  },
  {
    title: 'Hopper row for a lead that is final / deleted / gone',
    sql: `SELECT h.id, h.lead_id FROM dial_hopper h LEFT JOIN leads l ON l.id = h.lead_id WHERE l.id IS NULL OR l.is_final = 1 OR l.deleted_at IS NOT NULL`,
    fix: {
      tables: ['dial_hopper'],
      note: 'removes it from the hopper',
      sql: [
        `DELETE h FROM dial_hopper h LEFT JOIN leads l ON l.id = h.lead_id
         WHERE l.id IS NULL OR l.is_final = 1 OR l.deleted_at IS NOT NULL`,
      ],
    },
  },
  {
    title: 'Dialer marked running on a manual / paused / deleted campaign (stop it in Dialer)',
    sql: `SELECT id, name, dial_mode, status, dialer_state FROM campaigns WHERE dialer_state = 'running' AND (dial_mode = 'manual' OR status <> 'active' OR deleted_at IS NOT NULL)`,
  },
  // --- leads, lists, callbacks ---
  {
    title: 'Lead whose list is in another campaign',
    sql: `SELECT l.id, l.campaign_id, ls.campaign_id list_campaign FROM leads l JOIN lists ls ON ls.id = l.list_id WHERE l.deleted_at IS NULL AND NOT (ls.campaign_id <=> l.campaign_id)`,
  },
  {
    title: 'Lead status that is not a disposition of its campaign',
    sql: `SELECT l.id, l.status, l.campaign_id FROM leads l WHERE l.deleted_at IS NULL AND l.status <> 'new' AND l.campaign_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campaign_dispositions d WHERE d.campaign_id = l.campaign_id AND d.code = l.status)`,
  },
  {
    title: 'Same phone twice in one campaign',
    sql: `SELECT campaign_id, phone, COUNT(*) n FROM leads WHERE deleted_at IS NULL GROUP BY campaign_id, phone HAVING n > 1`,
  },
  {
    title: 'Lead on the DNC list but still dialable',
    sql: `SELECT l.id, l.phone FROM leads l JOIN dnc_numbers d ON d.phone = l.phone WHERE l.is_final = 0 AND l.deleted_at IS NULL`,
  },
  {
    title: 'Pending callback overdue by more than 1 day',
    sql: `SELECT id, lead_id, callback_at FROM callbacks WHERE status = 'pending' AND callback_at < NOW() - INTERVAL 1 DAY`,
  },
  {
    title: 'Pending callback for a final / deleted lead',
    sql: `SELECT cb.id, cb.lead_id FROM callbacks cb JOIN leads l ON l.id = cb.lead_id WHERE cb.status = 'pending' AND (l.is_final = 1 OR l.deleted_at IS NOT NULL)`,
    fix: {
      tables: ['callbacks'],
      note: 'cancels it',
      sql: [
        `UPDATE callbacks cb JOIN leads l ON l.id = cb.lead_id SET cb.status = 'cancelled'
         WHERE cb.status = 'pending' AND (l.is_final = 1 OR l.deleted_at IS NOT NULL)`,
      ],
    },
  },
  {
    title: 'Form response without user / form',
    sql: `SELECT r.id FROM form_responses r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN forms f ON f.id = r.form_id WHERE u.id IS NULL OR f.id IS NULL`,
  },
  // --- setup ---
  {
    title: 'Campaign without a queue',
    sql: `SELECT id, name FROM campaigns WHERE queue_id IS NULL AND deleted_at IS NULL`,
  },
  {
    title: 'Campaign without dispositions',
    sql: `SELECT c.id, c.name FROM campaigns c WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM campaign_dispositions d WHERE d.campaign_id = c.id)`,
  },
  {
    title: 'Campaign in no team (no agent can work it)',
    sql: `SELECT c.id, c.name FROM campaigns c WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM team_campaigns tc WHERE tc.campaign_id = c.id)`,
  },
  {
    title: 'Active agent in no team (sees no campaign)',
    sql: `SELECT u.id, u.username FROM users u WHERE u.role = 'agent' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id)`,
  },
  {
    title: 'DID pointing at a missing / deleted campaign',
    sql: `SELECT d.id, d.number FROM dids d LEFT JOIN campaigns c ON c.id = d.campaign_id WHERE d.campaign_id IS NOT NULL AND (c.id IS NULL OR c.deleted_at IS NOT NULL)`,
  },
  {
    title: 'Extension without a SIP password',
    sql: `SELECT id, name FROM extensions WHERE deleted_at IS NULL AND (sip_password IS NULL OR sip_password = '')`,
  },
  // --- logins ---
  {
    title: 'Expired login sessions not cleaned up (older than 1 day)',
    sql: `SELECT COUNT(*) n FROM sessions WHERE expires < NOW() - INTERVAL 1 DAY HAVING n > 0`,
    fix: {
      tables: ['sessions'],
      note: 'deletes them',
      sql: [`DELETE FROM sessions WHERE expires < NOW() - INTERVAL 1 DAY`],
    },
  },
];

/** Runs every check; returns [{ check, rows }] for the ones that found something (or failed). */
async function findProblems(db, log = console.log) {
  const found = [];
  for (const check of CHECKS) {
    try {
      const [rows] = await db.query(check.sql);
      if (!rows.length) log(`OK    ${check.title}`);
      else {
        found.push({ check, rows });
        log(`CHECK ${check.title}: ${rows.length}${check.fix ? '   [--fix: ' + check.fix.note + ']' : ''}`);
        for (const r of rows.slice(0, 5)) log('        ', JSON.stringify(r));
      }
    } catch (err) {
      found.push({ check, rows: [], error: err.message });
      log(`ERR   ${check.title}: ${err.message}`);
    }
  }
  return found;
}

/** mysqldump of these tables into ~/backups/db-fix-<time>.sql (owner-only). Returns the file. */
function backupTables(tables, env = process.env) {
  const dir = path.join(os.homedir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `db-fix-${stamp}.sql`);
  const dump = execFileSync(
    'mysqldump',
    [
      '--single-transaction',
      '--no-tablespaces',
      '-u',
      env.DB_USER || 'dialforge',
      env.DB_NAME || 'dialforge_dev',
      ...tables,
    ],
    { env: { ...env, MYSQL_PWD: env.DB_PASSWORD || '' }, maxBuffer: 1024 * 1024 * 1024 },
  );
  fs.writeFileSync(file, dump, { mode: 0o600 });
  return file;
}

/** Applies the fixes of the problems found (after a backup). Returns how many rows each changed. */
async function applyFixes(db, found, { backup = backupTables, log = console.log } = {}) {
  const fixable = found.filter((f) => f.check.fix && f.rows.length);
  if (!fixable.length) {
    log('\nNothing that --fix can repair.');
    return [];
  }
  const tables = [...new Set(fixable.flatMap((f) => f.check.fix.tables))];
  const file = backup(tables);
  log(`\nBackup of ${tables.join(', ')}: ${file}`);
  log(`(undo: mysql -u <user> -p <database> < ${file})\n`);
  const done = [];
  for (const { check } of fixable) {
    let changed = 0;
    for (const sql of check.fix.sql) {
      const [r] = await db.query(sql);
      changed += r.affectedRows || 0;
    }
    done.push({ title: check.title, changed });
    log(`FIXED ${check.title}: ${changed} row(s) - ${check.fix.note}`);
  }
  return done;
}

module.exports = { CHECKS, findProblems, applyFixes, backupTables };

if (require.main === module) {
  const pool = require('../../db');
  (async () => {
    const fix = process.argv.includes('--fix');
    let found = await findProblems(pool);
    if (fix) {
      await applyFixes(pool, found);
      console.log('\n--- checking again ---');
      found = await findProblems(pool);
    }
    const left = found.length;
    console.log(`\n${left} check(s) need a look, ${CHECKS.length - left} OK`);
    if (!fix && found.some((f) => f.check.fix)) console.log('Some can be repaired with: npm run db:check -- --fix');
    await pool.end();
    process.exitCode = left ? 1 : 0;
  })().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}
