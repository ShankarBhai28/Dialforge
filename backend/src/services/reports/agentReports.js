// Reports about agents: Agent Performance and Agent Time Sheet.
// Status time comes from agent_status_log (available / break / acw rows;
// logging out closes the open row), cut to the report's range. Calls are
// the agent's own (calls.agent_user_id).
const { scoped, idParam, num, pct, avg, localTime, TALK_SQL, sum } = require('./common');

async function agentList(db, scope, agentId) {
  const s = scoped(scope, 'agents', 'id');
  const [rows] = await db.query(
    `SELECT id, username FROM users WHERE role = 'agent'${agentId ? ' AND id = ?' : ''}${s.sql} ORDER BY username`,
    [...(agentId ? [agentId] : []), ...s.params],
  );
  return rows;
}

// --- 2. Agent Performance ---
async function agentPerformance({ db, range, q, scope }) {
  const agentId = idParam(q.agentId);
  const campaignId = idParam(q.campaignId);
  const agents = await agentList(db, scope, agentId);
  const ids = agents.map((a) => a.id);
  if (!ids.length) return emptyPerformance();

  const clip = 'TIMESTAMPDIFF(SECOND, GREATEST(started_at, ?), LEAST(COALESCE(ended_at, NOW()), ?))';
  const [status] = await db.query(
    `SELECT user_id, status, SUM(${clip}) AS secs
     FROM agent_status_log
     WHERE user_id IN (?) AND started_at < ? AND COALESCE(ended_at, NOW()) > ?
     GROUP BY user_id, status`,
    [range.start, range.end, ids, range.end, range.start],
  );
  const [calls] = await db.query(
    `SELECT ca.agent_user_id AS user_id, SUM(ca.direction = 'outbound') AS outbound, SUM(ca.direction = 'inbound') AS inbound,
            SUM(ca.agent_connect_time IS NOT NULL) AS connected, SUM(${TALK_SQL}) AS talk,
            SUM(ca.outcome IS NOT NULL) AS outcomes, SUM(cd.is_success = 1) AS successes
     FROM calls ca
     LEFT JOIN campaign_dispositions cd ON cd.campaign_id = ca.campaign_id AND cd.code = ca.outcome
     WHERE ca.agent_user_id IN (?) AND ca.start_time >= ? AND ca.start_time < ?${campaignId ? ' AND ca.campaign_id = ?' : ''}
     GROUP BY ca.agent_user_id`,
    [ids, range.start, range.end, ...(campaignId ? [campaignId] : [])],
  );
  const [callbacks] = await db.query(
    `SELECT created_by AS user_id, COUNT(*) AS n FROM callbacks
     WHERE created_by IN (?) AND created_at >= ? AND created_at < ?${campaignId ? ' AND campaign_id = ?' : ''}
     GROUP BY created_by`,
    [ids, range.start, range.end, ...(campaignId ? [campaignId] : [])],
  );

  const st = {};
  for (const r of status) {
    st[r.user_id] = st[r.user_id] || {};
    st[r.user_id][r.status] = Math.max(num(r.secs), 0);
  }
  const callMap = Object.fromEntries(calls.map((r) => [r.user_id, r]));
  const cbMap = Object.fromEntries(callbacks.map((r) => [r.user_id, num(r.n)]));

  const rows = [];
  for (const a of agents) {
    const s = st[a.id] || {};
    const c = callMap[a.id] || {};
    const login = Object.values(s).reduce((x, y) => x + y, 0);
    const talk = num(c.talk);
    const connected = num(c.connected);
    const row = shapeAgent({
      agent: a.username,
      login,
      available: s.available || 0,
      wrap: s.acw || 0,
      brk: s.break || 0,
      talk,
      outbound: num(c.outbound),
      inbound: num(c.inbound),
      connected,
      outcomes: num(c.outcomes),
      successes: num(c.successes),
      callbacks: cbMap[a.id] || 0,
    });
    // Only agents who did something in the range.
    if (login > 0 || row.outbound + row.inbound > 0) rows.push(row);
  }
  const t = sum(rows, [
    'login_seconds',
    'ready_seconds',
    'talk_seconds',
    'wrap_seconds',
    'break_seconds',
    'outbound',
    'inbound',
    'connected',
    'outcomes',
    'successes',
    'callbacks',
  ]);
  return {
    columns: PERFORMANCE_COLUMNS,
    rows,
    totals: {
      agent: `${rows.length} agents`,
      ...t,
      avg_talk_seconds: avg(t.talk_seconds, t.connected),
      avg_handle_seconds: avg(t.talk_seconds + t.wrap_seconds, t.connected),
      occupancy: pct(t.talk_seconds + t.wrap_seconds, t.login_seconds - t.break_seconds),
      conversion: pct(t.successes, t.connected),
    },
  };
}

/** One agent's numbers. While on a call the agent's status stays "available", so ready = available - talk. */
function shapeAgent(x) {
  const ready = Math.max(x.available - x.talk, 0);
  return {
    agent: x.agent,
    login_seconds: x.login,
    ready_seconds: ready,
    talk_seconds: x.talk,
    wrap_seconds: x.wrap,
    break_seconds: x.brk,
    outbound: x.outbound,
    inbound: x.inbound,
    connected: x.connected,
    avg_talk_seconds: avg(x.talk, x.connected),
    avg_handle_seconds: avg(x.talk + x.wrap, x.connected),
    occupancy: pct(x.talk + x.wrap, x.login - x.brk),
    outcomes: x.outcomes,
    successes: x.successes,
    conversion: pct(x.successes, x.connected),
    callbacks: x.callbacks,
  };
}

const PERFORMANCE_COLUMNS = [
  { key: 'agent', label: 'Agent' },
  { key: 'login_seconds', label: 'Logged in', type: 'seconds' },
  { key: 'ready_seconds', label: 'Ready (idle)', type: 'seconds' },
  { key: 'talk_seconds', label: 'Talk', type: 'seconds' },
  { key: 'wrap_seconds', label: 'Wrap-up', type: 'seconds' },
  { key: 'break_seconds', label: 'Break', type: 'seconds' },
  { key: 'outbound', label: 'Outbound calls', type: 'number' },
  { key: 'inbound', label: 'Inbound calls', type: 'number' },
  { key: 'connected', label: 'Answered', type: 'number' },
  { key: 'avg_talk_seconds', label: 'Avg talk', type: 'seconds' },
  { key: 'avg_handle_seconds', label: 'Avg handle (talk + wrap)', type: 'seconds' },
  { key: 'occupancy', label: 'Occupancy %', type: 'percent' },
  { key: 'outcomes', label: 'Outcomes given', type: 'number' },
  { key: 'successes', label: 'Successes', type: 'number' },
  { key: 'conversion', label: 'Conversion %', type: 'percent' },
  { key: 'callbacks', label: 'Callbacks set', type: 'number' },
];

function emptyPerformance() {
  return { columns: PERFORMANCE_COLUMNS, rows: [], totals: null };
}

// --- 3. Agent Time Sheet: one row per agent per day ---
async function timeSheet({ db, range, q, scope }) {
  const agentId = idParam(q.agentId);
  const s = scoped(scope, 'agents', 'asl.user_id');
  const day = `DATE(CONVERT_TZ(asl.started_at, '+00:00', '${range.offset}'))`;
  const secs = 'GREATEST(TIMESTAMPDIFF(SECOND, asl.started_at, COALESCE(asl.ended_at, NOW())), 0)';
  const where = `WHERE asl.started_at >= ? AND asl.started_at < ?${agentId ? ' AND asl.user_id = ?' : ''}${s.sql}`;
  const params = [range.start, range.end, ...(agentId ? [agentId] : []), ...s.params];
  const [rows] = await db.query(
    `SELECT asl.user_id, u.username, DATE_FORMAT(${day}, '%Y-%m-%d') AS day,
            ${localTime('MIN(asl.started_at)', range.offset)} AS first_login,
            ${localTime('MAX(COALESCE(asl.ended_at, NOW()))', range.offset)} AS last_seen,
            SUM(asl.ended_at IS NULL) AS still_in,
            SUM(${secs}) AS login, SUM(IF(asl.status = 'break', ${secs}, 0)) AS brk,
            SUM(asl.status = 'break') AS breaks, SUM(IF(asl.status = 'acw', ${secs}, 0)) AS wrap
     FROM agent_status_log asl JOIN users u ON u.id = asl.user_id
     ${where}
     GROUP BY asl.user_id, u.username, day
     ORDER BY day DESC, u.username`,
    params,
  );
  const [reasons] = await db.query(
    `SELECT asl.user_id, DATE_FORMAT(${day}, '%Y-%m-%d') AS day, COALESCE(NULLIF(asl.reason, ''), 'Break') AS reason,
            COUNT(*) AS n, SUM(${secs}) AS secs
     FROM agent_status_log asl
     ${where} AND asl.status = 'break'
     GROUP BY asl.user_id, day, reason
     ORDER BY secs DESC`,
    params,
  );
  const detail = {};
  for (const r of reasons) {
    const k = `${r.user_id}|${r.day}`;
    (detail[k] = detail[k] || []).push(`${r.reason} x${num(r.n)} (${clock(num(r.secs))})`);
  }
  const out = rows.map((r) => ({
    day: r.day,
    agent: r.username,
    first_login: r.first_login ? r.first_login.slice(11) : null,
    last_logout: num(r.still_in) > 0 ? 'still logged in' : r.last_seen ? r.last_seen.slice(11) : null,
    login_seconds: num(r.login),
    breaks: num(r.breaks),
    break_seconds: num(r.brk),
    break_detail: (detail[`${r.user_id}|${r.day}`] || []).join(', ') || null,
    wrap_seconds: num(r.wrap),
  }));
  return {
    columns: [
      { key: 'day', label: 'Date', type: 'date' },
      { key: 'agent', label: 'Agent' },
      { key: 'first_login', label: 'First login' },
      { key: 'last_logout', label: 'Last logout' },
      { key: 'login_seconds', label: 'Logged in', type: 'seconds' },
      { key: 'breaks', label: 'Breaks', type: 'number' },
      { key: 'break_seconds', label: 'Break time', type: 'seconds' },
      { key: 'break_detail', label: 'Break reasons' },
      { key: 'wrap_seconds', label: 'Wrap-up time', type: 'seconds' },
    ],
    rows: out,
    totals: { day: 'Total', ...sum(out, ['login_seconds', 'breaks', 'break_seconds', 'wrap_seconds']) },
  };
}

/** 3725 -> '1:02:05' */
function clock(s) {
  const p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

module.exports = { agentPerformance, timeSheet, shapeAgent, clock };
