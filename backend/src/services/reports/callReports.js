// Reports built from the calls table: Call Detail, Hourly, Inbound, Outcomes.
const { normalizePhone } = require('../../../dialer-common');
const { scoped, idParam, num, pct, avg, localTime, TALK_SQL, sum, resultLabel, outcomeLabel } = require('./common');

/** WHERE for calls in the range + the filters every call report shares. */
function callWhere({ range, q, scope }, extra = {}) {
  const where = ['ca.start_time >= ?', 'ca.start_time < ?'];
  const params = [range.start, range.end];
  const s = scoped(scope, 'campaigns', 'ca.campaign_id');
  if (s.sql) {
    where.push(s.sql.replace(/^ AND /, ''));
    params.push(...s.params);
  }
  const add = (cond, ...p) => {
    where.push(cond);
    params.push(...p);
  };
  if (idParam(q.campaignId)) add('ca.campaign_id = ?', idParam(q.campaignId));
  if (extra.agent && idParam(q.agentId)) add('ca.agent_user_id = ?', idParam(q.agentId));
  if (extra.direction && ['inbound', 'outbound'].includes(q.direction)) add('ca.direction = ?', q.direction);
  if (extra.outcome && q.outcome) add('ca.outcome = ?', String(q.outcome));
  if (extra.number) {
    const digits = normalizePhone(q.number || '');
    if (digits) add('ca.to_number LIKE ?', `%${digits}%`);
  }
  if (extra.answered && q.answered === 'yes') add('ca.agent_connect_time IS NOT NULL');
  if (extra.answered && q.answered === 'no') add('ca.agent_connect_time IS NULL');
  return { sql: `WHERE ${where.join(' AND ')}`, params };
}

// --- 1. Call Detail (CDR): one row per call ---
const CDR_SHOW = 1000;
const CDR_EXPORT = 100000;
async function cdr(ctx) {
  const { db, range, csv } = ctx;
  const w = callWhere(ctx, { agent: true, direction: true, outcome: true, number: true, answered: true });
  const limit = csv ? CDR_EXPORT : CDR_SHOW;
  const [rows] = await db.query(
    `SELECT ca.id, ${localTime('ca.start_time', range.offset)} AS start, ca.direction,
            CONCAT(c.name, IF(c.deleted_at IS NULL, '', ' (deleted)')) AS campaign,
            u.username AS agent, ca.from_extension AS extension, ca.to_number AS number, l.name AS lead_name, ca.did,
            IF(ca.agent_connect_time IS NOT NULL AND (ca.direction = 'inbound' OR ca.dial_attempt_id IS NOT NULL),
               GREATEST(TIMESTAMPDIFF(SECOND, IF(ca.direction = 'inbound', ca.start_time, ca.answer_time), ca.agent_connect_time), 0),
               NULL) AS wait_seconds,
            ${TALK_SQL} AS talk_seconds,
            IF(ca.end_time IS NULL, NULL, TIMESTAMPDIFF(SECOND, ca.start_time, ca.end_time)) AS duration_seconds,
            ca.agent_connect_time, ca.disposition, ca.end_time IS NOT NULL AS ended,
            ca.outcome, cd.label AS outcome_label,
            EXISTS (SELECT 1 FROM call_events e WHERE e.call_id = ca.id
                    AND e.event_type IN ('transferred', 'transferred_to_queue')) AS transferred,
            ca.recording_path IS NOT NULL AS recorded
     FROM calls ca
     LEFT JOIN campaigns c ON c.id = ca.campaign_id
     LEFT JOIN users u ON u.id = ca.agent_user_id
     LEFT JOIN leads l ON l.id = ca.lead_id
     LEFT JOIN campaign_dispositions cd ON cd.campaign_id = ca.campaign_id AND cd.code = ca.outcome
     ${w.sql}
     ORDER BY ca.id DESC LIMIT ?`,
    [...w.params, limit],
  );
  const [[agg]] = await db.query(
    `SELECT COUNT(*) AS calls, SUM(ca.agent_connect_time IS NOT NULL) AS connected, SUM(${TALK_SQL}) AS talk,
            SUM(IF(ca.end_time IS NULL, 0, TIMESTAMPDIFF(SECOND, ca.start_time, ca.end_time))) AS duration
     FROM calls ca ${w.sql}`,
    w.params,
  );
  const out = rows.map((r) => ({
    id: r.id,
    start: r.start,
    direction: r.direction,
    campaign: r.campaign,
    agent: r.agent,
    extension: r.extension,
    number: r.number,
    lead: r.lead_name,
    did: r.did,
    wait_seconds: r.wait_seconds == null ? null : num(r.wait_seconds),
    talk_seconds: r.agent_connect_time ? num(r.talk_seconds) : null,
    duration_seconds: r.duration_seconds == null ? null : num(r.duration_seconds),
    result: resultLabel(r),
    outcome: r.outcome ? outcomeLabel(r.outcome, r.outcome_label) : null,
    transferred: r.transferred ? 'Yes' : null,
    // The call id: the screen plays /admin/calls/<id>/recording; the CSV says "Yes".
    recording: r.recorded ? r.id : null,
  }));
  return {
    columns: [
      { key: 'id', label: 'Call', type: 'id' },
      { key: 'start', label: 'Start', type: 'datetime' },
      { key: 'direction', label: 'Direction' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'agent', label: 'Agent' },
      { key: 'extension', label: 'Ext' },
      { key: 'number', label: 'Number' },
      { key: 'lead', label: 'Lead' },
      { key: 'did', label: 'DID' },
      { key: 'wait_seconds', label: 'Queue wait', type: 'seconds' },
      { key: 'talk_seconds', label: 'Talk', type: 'seconds' },
      { key: 'duration_seconds', label: 'Duration', type: 'seconds' },
      { key: 'result', label: 'Result' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'transferred', label: 'Transferred' },
      { key: 'recording', label: 'Recording', type: 'recording' },
    ],
    rows: out,
    totals: {
      id: `${num(agg.calls)} calls`,
      result: `${num(agg.connected)} answered`,
      talk_seconds: num(agg.talk),
      duration_seconds: num(agg.duration),
    },
    meta: { total: num(agg.calls), shown: out.length, limit },
  };
}

// --- 8. Hourly: calls per local hour of the day over the range ---
async function hourly(ctx) {
  const { db, range } = ctx;
  const w = callWhere(ctx, { direction: true });
  const [rows] = await db.query(
    `SELECT HOUR(CONVERT_TZ(ca.start_time, '+00:00', '${range.offset}')) AS hour,
            COUNT(*) AS calls, SUM(ca.direction = 'outbound') AS outbound, SUM(ca.direction = 'inbound') AS inbound,
            SUM(ca.agent_connect_time IS NOT NULL) AS connected,
            SUM(ca.disposition IN ('abandoned', 'customer_hangup')) AS abandoned,
            SUM(${TALK_SQL}) AS talk, COUNT(DISTINCT ca.agent_user_id) AS agents
     FROM calls ca ${w.sql}
     GROUP BY hour`,
    w.params,
  );
  const byHour = Object.fromEntries(rows.map((r) => [Number(r.hour), r]));
  const out = [];
  for (let h = 0; h < 24; h++) {
    const r = byHour[h] || {};
    const p = (n) => String(n).padStart(2, '0');
    const connected = num(r.connected);
    out.push({
      hour: `${p(h)}:00 - ${p((h + 1) % 24)}:00`,
      calls: num(r.calls),
      outbound: num(r.outbound),
      inbound: num(r.inbound),
      connected,
      connect_rate: pct(connected, num(r.calls)),
      abandoned: num(r.abandoned),
      talk_seconds: num(r.talk),
      avg_talk_seconds: avg(num(r.talk), connected),
      agents: num(r.agents),
    });
  }
  const t = sum(out, ['calls', 'outbound', 'inbound', 'connected', 'abandoned', 'talk_seconds']);
  return {
    columns: [
      { key: 'hour', label: 'Hour' },
      { key: 'calls', label: 'Calls', type: 'number' },
      { key: 'outbound', label: 'Outbound', type: 'number' },
      { key: 'inbound', label: 'Inbound', type: 'number' },
      { key: 'connected', label: 'Answered', type: 'number' },
      { key: 'connect_rate', label: 'Answer %', type: 'percent' },
      { key: 'abandoned', label: 'Abandoned', type: 'number' },
      { key: 'talk_seconds', label: 'Talk time', type: 'seconds' },
      { key: 'avg_talk_seconds', label: 'Avg talk', type: 'seconds' },
      { key: 'agents', label: 'Agents on calls', type: 'number' },
    ],
    rows: out,
    totals: {
      hour: 'Total',
      ...t,
      connect_rate: pct(t.connected, t.calls),
      avg_talk_seconds: avg(t.talk_seconds, t.connected),
    },
  };
}

// --- 7. Inbound / queue: offered, answered, abandoned, waits, service level ---
async function inbound(ctx) {
  const { db, q } = ctx;
  const sla = Math.min(Math.max(Number(q.slaSeconds) || 20, 1), 600);
  const byDid = q.groupBy === 'did';
  const w = callWhere(ctx);
  const wait = 'TIMESTAMPDIFF(SECOND, ca.start_time, ca.agent_connect_time)';
  const [rows] = await db.query(
    `SELECT ${byDid ? "COALESCE(ca.did, '(unknown)')" : "COALESCE(CONCAT(c.name, IF(c.deleted_at IS NULL, '', ' (deleted)')), '(no campaign)')"} AS grp,
            COUNT(*) AS offered, SUM(ca.agent_connect_time IS NOT NULL) AS answered,
            SUM(ca.agent_connect_time IS NULL AND ca.end_time IS NOT NULL) AS abandoned,
            SUM(ca.agent_connect_time IS NOT NULL AND ${wait} <= ?) AS within_sla,
            SUM(IF(ca.agent_connect_time IS NULL, 0, ${wait})) AS wait_total,
            MAX(IF(ca.agent_connect_time IS NULL, NULL, ${wait})) AS wait_max,
            SUM(IF(ca.agent_connect_time IS NULL AND ca.end_time IS NOT NULL,
                   TIMESTAMPDIFF(SECOND, ca.start_time, ca.end_time), 0)) AS abandon_wait_total,
            SUM(${TALK_SQL}) AS talk
     FROM calls ca LEFT JOIN campaigns c ON c.id = ca.campaign_id
     ${w.sql} AND ca.direction = 'inbound'
     GROUP BY grp ORDER BY offered DESC`,
    [sla, ...w.params],
  );
  const shape = (r) => {
    const offered = num(r.offered);
    const answered = num(r.answered);
    const abandoned = num(r.abandoned);
    return {
      name: r.grp,
      offered,
      answered,
      abandoned,
      abandon_rate: pct(abandoned, offered),
      service_level: pct(num(r.within_sla), offered),
      avg_wait_seconds: avg(num(r.wait_total), answered),
      max_wait_seconds: r.wait_max == null ? null : num(r.wait_max),
      avg_abandon_seconds: avg(num(r.abandon_wait_total), abandoned),
      talk_seconds: num(r.talk),
      avg_talk_seconds: avg(num(r.talk), answered),
      within_sla: num(r.within_sla),
      wait_total: num(r.wait_total),
      abandon_wait_total: num(r.abandon_wait_total),
    };
  };
  const out = rows.map(shape);
  const t = sum(out, [
    'offered',
    'answered',
    'abandoned',
    'talk_seconds',
    'within_sla',
    'wait_total',
    'abandon_wait_total',
  ]);
  const maxes = out.map((r) => r.max_wait_seconds).filter((v) => v != null);
  const strip = ({ within_sla: _a, wait_total: _b, abandon_wait_total: _c, ...r }) => r;
  return {
    columns: [
      { key: 'name', label: byDid ? 'DID (number dialed)' : 'Campaign' },
      { key: 'offered', label: 'Offered', type: 'number' },
      { key: 'answered', label: 'Answered', type: 'number' },
      { key: 'abandoned', label: 'Abandoned', type: 'number' },
      { key: 'abandon_rate', label: 'Abandon %', type: 'percent', warnAbove: 5 },
      { key: 'service_level', label: `Answered in ${sla}s %`, type: 'percent', warnBelow: 80 },
      { key: 'avg_wait_seconds', label: 'Avg wait', type: 'seconds' },
      { key: 'max_wait_seconds', label: 'Longest wait', type: 'seconds' },
      { key: 'avg_abandon_seconds', label: 'Avg wait before hang-up', type: 'seconds' },
      { key: 'talk_seconds', label: 'Talk time', type: 'seconds' },
      { key: 'avg_talk_seconds', label: 'Avg talk', type: 'seconds' },
    ],
    rows: out.map(strip),
    totals: {
      name: 'Total',
      offered: t.offered,
      answered: t.answered,
      abandoned: t.abandoned,
      abandon_rate: pct(t.abandoned, t.offered),
      service_level: pct(t.within_sla, t.offered),
      avg_wait_seconds: avg(t.wait_total, t.answered),
      max_wait_seconds: maxes.length ? Math.max(...maxes) : null,
      avg_abandon_seconds: avg(t.abandon_wait_total, t.abandoned),
      talk_seconds: t.talk_seconds,
      avg_talk_seconds: avg(t.talk_seconds, t.answered),
    },
  };
}

// --- 5. Outcomes: what agents recorded, per campaign or per agent ---
async function outcomes(ctx) {
  const { db, q } = ctx;
  const byAgent = q.groupBy === 'agent';
  const w = callWhere(ctx, { agent: true });
  const [rows] = await db.query(
    `SELECT ${byAgent ? "COALESCE(u.username, '(no agent)')" : "COALESCE(CONCAT(c.name, IF(c.deleted_at IS NULL, '', ' (deleted)')), '(no campaign)')"} AS grp,
            ca.outcome AS code, MAX(cd.label) AS label, MAX(cd.is_success) AS is_success, COUNT(*) AS n
     FROM calls ca
     LEFT JOIN campaigns c ON c.id = ca.campaign_id
     LEFT JOIN users u ON u.id = ca.agent_user_id
     LEFT JOIN campaign_dispositions cd ON cd.campaign_id = ca.campaign_id AND cd.code = ca.outcome
     ${w.sql} AND ca.outcome IS NOT NULL
     GROUP BY grp, ca.outcome
     ORDER BY grp, n DESC`,
    w.params,
  );
  const groupTotal = {};
  for (const r of rows) groupTotal[r.grp] = (groupTotal[r.grp] || 0) + num(r.n);
  const out = rows.map((r) => ({
    group: r.grp,
    outcome: outcomeLabel(r.code, r.label),
    code: r.code,
    success: num(r.is_success) || (r.is_success == null && r.code === 'interested') ? 'Yes' : null,
    calls: num(r.n),
    share: pct(num(r.n), groupTotal[r.grp]),
  }));
  const total = out.reduce((s, r) => s + r.calls, 0);
  const successes = out.filter((r) => r.success).reduce((s, r) => s + r.calls, 0);
  return {
    columns: [
      { key: 'group', label: byAgent ? 'Agent' : 'Campaign' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'code', label: 'Code' },
      { key: 'success', label: 'Success' },
      { key: 'calls', label: 'Calls', type: 'number' },
      { key: 'share', label: `% of ${byAgent ? 'agent' : 'campaign'}`, type: 'percent' },
    ],
    rows: out,
    totals: { group: 'Total', calls: total, success: `${successes} (${pct(successes, total) ?? 0}%)` },
  };
}

module.exports = { cdr, hourly, inbound, outcomes, callWhere, CDR_SHOW, CDR_EXPORT };
