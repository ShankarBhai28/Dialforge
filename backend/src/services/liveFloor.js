// Live Agents (supervisor wallboard): each agent with their campaign, team,
// line, login time, current call (lead, direction, call type, timer) and today's
// numbers; plus the floor summary - callers waiting for an agent now, and
// today's totals. "Today" = the report time zone's day (REPORT_TIMEZONE).
const pool = require('../../db');
const { scopeCondition } = require('./access');
const { localMidnight, localToday, sqlUtc } = require('./reports/time');

const TALK = `IF(agent_connect_time IS NULL, 0,
  GREATEST(TIMESTAMPDIFF(SECOND, agent_connect_time, COALESCE(end_time, NOW())), 0))`;

const todayStart = (now = new Date()) => sqlUtc(localMidnight(localToday(now)));

/**
 * What kind of call the agent is on, for the Live Agents "Call type" column:
 * transfer (handed to this agent by someone else), inbound, callback (the lead
 * had a callback due when the call started), the dialer's mode (predictive /
 * progressive), preview (agent dialled a lead of a preview campaign), else manual.
 */
function callType(call, a) {
  if (call.transfer_ext && call.transfer_ext === a.extension_name && call.from_extension !== a.extension_name)
    return 'transfer';
  if (call.direction === 'inbound') return 'inbound';
  if (Number(call.callback_due)) return 'callback';
  if (call.dial_attempt_id) return call.dial_mode === 'progressive' ? 'progressive' : 'predictive';
  if (call.dial_mode === 'preview' && call.lead_id) return 'preview';
  return 'manual';
}

/** The open call an agent is on (their extension, or a transfer to it), or null. */
function callFor(calls, a) {
  return (
    calls.find(
      (c) => a.extension_name && (c.from_extension === a.extension_name || c.transfer_ext === a.extension_name),
    ) ||
    calls.find((c) => c.agent_user_id === a.id) ||
    null
  );
}

async function liveAgents(scope, deps = { pool }, now = new Date()) {
  const db = deps.pool;
  const [cond, params] = scopeCondition(scope, 'agents', 'u.id');
  const [agents] = await db.query(
    `SELECT u.id, u.username, e.name AS extension_name,
       asl.status, asl.reason, asl.started_at,
       q.name AS queue_name,
       cmp.name AS campaign_name, cmp.wrapup_sec, cmp.break_warn_min, cmp.break_alert_min, cmp.acw_warn_sec,
       (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ', ') FROM team_members tm JOIN teams t ON t.id = tm.team_id
         WHERE tm.user_id = u.id) AS teams,
       (SELECT GROUP_CONCAT(xq.name ORDER BY xq.name SEPARATOR ', ') FROM agent_extra_queues x JOIN queues xq ON xq.id = x.queue_id
         WHERE x.user_id = u.id) AS extra_queues,
       la.line, la.login_at
     FROM users u
     LEFT JOIN extensions e ON u.extension_id = e.id
     LEFT JOIN agent_status_log asl ON asl.user_id = u.id AND asl.ended_at IS NULL
     LEFT JOIN queues q ON q.id = asl.queue_id
     LEFT JOIN campaigns cmp ON cmp.id =
       (SELECT c.id FROM campaigns c WHERE c.queue_id = q.id AND c.deleted_at IS NULL ORDER BY c.id LIMIT 1)
     LEFT JOIN live_agents la ON la.user_id = u.id
     WHERE u.role = 'agent'${cond ? ` AND ${cond}` : ''}
     ORDER BY u.username`,
    params,
  );
  if (!agents.length) return [];
  const ids = agents.map((a) => a.id);
  const [calls] = await db.query(
    `SELECT ca.id, ca.from_extension, ca.transfer_ext, ca.agent_user_id, ca.to_number, ca.direction, ca.dial_attempt_id,
            ca.start_time, ca.agent_connect_time, ca.lead_id, l.name AS lead_name, cmp.dial_mode,
            EXISTS (SELECT 1 FROM callbacks cb WHERE cb.lead_id = ca.lead_id AND cb.status = 'pending'
                      AND cb.callback_at <= ca.start_time + INTERVAL 30 MINUTE) AS callback_due
     FROM calls ca LEFT JOIN leads l ON l.id = ca.lead_id
     LEFT JOIN dial_attempts da ON da.id = ca.dial_attempt_id
     LEFT JOIN campaigns cmp ON cmp.id = COALESCE(ca.campaign_id, da.campaign_id)
     WHERE ca.end_time IS NULL AND ca.start_time > NOW() - INTERVAL 3 HOUR ORDER BY ca.id DESC`,
  );
  const since = todayStart(now);
  const [today] = await db.query(
    `SELECT agent_user_id AS id, COUNT(*) AS calls, SUM(agent_connect_time IS NOT NULL) AS connected, SUM(${TALK}) AS talk
     FROM calls WHERE agent_user_id IN (?) AND start_time >= ? GROUP BY agent_user_id`,
    [ids, since],
  );
  // Wrap-up rows that reach into today: still open, or ended since midnight -
  // two halves so each reads index asl_open (ended_at, user_id). As one
  // "COALESCE(ended_at, NOW()) >= ?" it read every agent's whole history.
  const [wrap] = await db.query(
    `SELECT user_id AS id, SUM(GREATEST(TIMESTAMPDIFF(SECOND, GREATEST(started_at, ?), COALESCE(ended_at, NOW())), 0)) AS acw
     FROM (SELECT user_id, started_at, ended_at FROM agent_status_log
           WHERE ended_at IS NULL AND status = 'acw' AND user_id IN (?)
           UNION ALL
           SELECT user_id, started_at, ended_at FROM agent_status_log
           WHERE ended_at >= ? AND status = 'acw' AND user_id IN (?)) w
     GROUP BY user_id`,
    [since, ids, since, ids],
  );
  const todayBy = new Map(today.map((r) => [r.id, r]));
  const wrapBy = new Map(wrap.map((r) => [r.id, Number(r.acw || 0)]));
  return agents.map((a) => {
    const call = callFor(calls, a);
    const t = todayBy.get(a.id) || { calls: 0, connected: 0, talk: 0 };
    const connected = Number(t.connected || 0);
    const talk = Number(t.talk || 0);
    return {
      id: a.id,
      username: a.username,
      extension_name: a.extension_name,
      status: a.status,
      reason: a.reason,
      started_at: a.started_at,
      queue_name: a.queue_name,
      /** Blended: the extra queues this agent also takes calls from. */
      extra_queues: a.extra_queues || null,
      campaign_name: a.campaign_name || null,
      wrapup_sec: a.wrapup_sec == null ? null : Number(a.wrapup_sec),
      /** The campaign's warning times (null = no campaign: the screen's defaults). */
      warn:
        a.break_warn_min == null
          ? null
          : {
              breakWarnMin: Number(a.break_warn_min),
              breakAlertMin: Number(a.break_alert_min),
              acwWarnSec: Number(a.acw_warn_sec),
            },
      teams: a.teams || null,
      /** registered | unregistered | unknown (Asterisk not asked) | null = not logged in */
      line: a.status || a.login_at ? a.line || 'unknown' : null,
      login_at: a.login_at || null,
      // Kept for older screens (Dashboard).
      active_call_number: call ? call.to_number : null,
      call: call
        ? {
            id: call.id,
            number: call.to_number,
            leadName: call.lead_name || null,
            kind: call.direction === 'inbound' ? 'inbound' : call.dial_attempt_id ? 'dialer' : 'outbound',
            type: callType(call, a),
            startedAt: call.start_time,
            connectedAt: call.agent_connect_time || null,
          }
        : null,
      today: {
        calls: Number(t.calls || 0),
        connected,
        talkSeconds: talk,
        // Average handle time: talk + wrap-up per connected call.
        avgHandleSeconds: connected ? Math.round((talk + (wrapBy.get(a.id) || 0)) / connected) : null,
      },
    };
  });
}

/** Callers waiting for an agent right now, and today's totals (within the role's teams). */
async function floorSummary(scope, deps = { pool }, now = new Date()) {
  const db = deps.pool;
  const [cond, params] = scopeCondition(scope, 'campaigns', 'campaign_id');
  const and = cond ? ` AND ${cond}` : '';
  // Inbound callers in the queue (not answered by an agent yet) + dialer calls a customer answered, waiting for an agent.
  const [[inbound]] = await db.query(
    `SELECT COUNT(*) AS n, MIN(start_time) AS oldest FROM calls
     WHERE direction = 'inbound' AND end_time IS NULL AND agent_connect_time IS NULL
       AND start_time > NOW() - INTERVAL 1 HOUR${and}`,
    params,
  );
  const [[dialer]] = await db.query(
    `SELECT COUNT(*) AS n, MIN(answered_at) AS oldest FROM dial_attempts WHERE status = 'answered'${and}`,
    params,
  );
  const since = todayStart(now);
  const [[t]] = await db.query(
    `SELECT COUNT(*) AS calls, SUM(agent_connect_time IS NOT NULL) AS connected, SUM(${TALK}) AS talk
     FROM calls WHERE start_time >= ?${and}`,
    [since, ...params],
  );
  const oldest = [inbound.oldest, dialer.oldest].filter(Boolean).map((d) => new Date(d).getTime());
  return {
    waiting: Number(inbound.n || 0) + Number(dialer.n || 0),
    waitingInbound: Number(inbound.n || 0),
    waitingDialer: Number(dialer.n || 0),
    longestWaitSeconds: oldest.length ? Math.max(0, Math.round((now.getTime() - Math.min(...oldest)) / 1000)) : null,
    today: { calls: Number(t.calls || 0), connected: Number(t.connected || 0), talkSeconds: Number(t.talk || 0) },
  };
}

module.exports = { liveAgents, floorSummary, callFor, callType, todayStart };
