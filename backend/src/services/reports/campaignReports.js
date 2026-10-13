// Reports about campaigns: Campaign Performance, Predictive Dialer, List
// Penetration, Callbacks.
const { scoped, idParam, num, pct, avg, TALK_SQL, sum } = require('./common');

const CAMPAIGN_NAME = "CONCAT(c.name, IF(c.deleted_at IS NULL, '', ' (deleted)'))";

// --- 4. Campaign Performance ---
async function campaignPerformance({ db, range, q, scope }) {
  const campaignId = idParam(q.campaignId);
  const s = scoped(scope, 'campaigns', 'c.id');
  const only = campaignId ? ' AND c.id = ?' : '';
  const onlyP = campaignId ? [campaignId] : [];
  const [camps] = await db.query(
    `SELECT c.id, ${CAMPAIGN_NAME} AS name FROM campaigns c
     WHERE (c.deleted_at IS NULL OR EXISTS (SELECT 1 FROM calls x WHERE x.campaign_id = c.id AND x.start_time >= ? AND x.start_time < ?))${only}${s.sql}
     ORDER BY c.deleted_at IS NULL DESC, c.id DESC`,
    [range.start, range.end, ...onlyP, ...s.params],
  );
  const ids = camps.map((c) => c.id);
  if (!ids.length) return { columns: CAMPAIGN_COLUMNS, rows: [], totals: null };
  const [leads] = await db.query(
    `SELECT campaign_id, COUNT(*) AS total, SUM(attempts > 0) AS dialed
     FROM leads WHERE campaign_id IN (?) AND deleted_at IS NULL GROUP BY campaign_id`,
    [ids],
  );
  const [calls] = await db.query(
    `SELECT ca.campaign_id, COUNT(*) AS calls,
            SUM(ca.answer_time IS NOT NULL AND COALESCE(ca.disposition, '') <> 'machine') AS answered,
            SUM(ca.agent_connect_time IS NOT NULL) AS connected,
            SUM(ca.disposition IN ('abandoned', 'customer_hangup')) AS abandoned,
            SUM(ca.disposition = 'machine') AS machine,
            SUM(${TALK_SQL}) AS talk, SUM(ca.outcome IS NOT NULL) AS outcomes, SUM(cd.is_success = 1) AS successes
     FROM calls ca
     LEFT JOIN campaign_dispositions cd ON cd.campaign_id = ca.campaign_id AND cd.code = ca.outcome
     WHERE ca.campaign_id IN (?) AND ca.start_time >= ? AND ca.start_time < ?
     GROUP BY ca.campaign_id`,
    [ids, range.start, range.end],
  );
  const leadMap = Object.fromEntries(leads.map((r) => [r.campaign_id, r]));
  const callMap = Object.fromEntries(calls.map((r) => [r.campaign_id, r]));
  const rows = camps.map((c) => {
    const l = leadMap[c.id] || {};
    const x = callMap[c.id] || {};
    return shapeCampaign({
      campaign: c.name,
      leads: num(l.total),
      dialed: num(l.dialed),
      calls: num(x.calls),
      answered: num(x.answered),
      connected: num(x.connected),
      abandoned: num(x.abandoned),
      machine: num(x.machine),
      talk: num(x.talk),
      outcomes: num(x.outcomes),
      successes: num(x.successes),
    });
  });
  const t = sum(rows, [
    'leads',
    'dialed_leads',
    'calls',
    'answered',
    'connected',
    'abandoned',
    'machine',
    'talk_seconds',
    'outcomes',
    'successes',
  ]);
  return {
    columns: CAMPAIGN_COLUMNS,
    rows,
    totals: {
      campaign: 'Total',
      ...t,
      penetration: pct(t.dialed_leads, t.leads),
      contact_rate: pct(t.answered, t.calls),
      abandon_rate: pct(t.abandoned, t.answered),
      avg_talk_seconds: avg(t.talk_seconds, t.connected),
      conversion: pct(t.successes, t.connected),
    },
  };
}

function shapeCampaign(x) {
  return {
    campaign: x.campaign,
    leads: x.leads,
    dialed_leads: x.dialed,
    penetration: pct(x.dialed, x.leads),
    calls: x.calls,
    answered: x.answered,
    contact_rate: pct(x.answered, x.calls),
    connected: x.connected,
    abandoned: x.abandoned,
    abandon_rate: pct(x.abandoned, x.answered),
    machine: x.machine,
    talk_seconds: x.talk,
    avg_talk_seconds: avg(x.talk, x.connected),
    outcomes: x.outcomes,
    successes: x.successes,
    conversion: pct(x.successes, x.connected),
  };
}

const CAMPAIGN_COLUMNS = [
  { key: 'campaign', label: 'Campaign' },
  { key: 'leads', label: 'Leads', type: 'number' },
  { key: 'dialed_leads', label: 'Leads dialed', type: 'number' },
  { key: 'penetration', label: 'Penetration %', type: 'percent' },
  { key: 'calls', label: 'Calls', type: 'number' },
  { key: 'answered', label: 'Answered (human)', type: 'number' },
  { key: 'contact_rate', label: 'Contact %', type: 'percent' },
  { key: 'connected', label: 'Talked to agent', type: 'number' },
  { key: 'abandoned', label: 'Abandoned', type: 'number' },
  { key: 'abandon_rate', label: 'Abandon %', type: 'percent', warnAbove: 3 },
  { key: 'machine', label: 'Machines', type: 'number' },
  { key: 'talk_seconds', label: 'Talk time', type: 'seconds' },
  { key: 'avg_talk_seconds', label: 'Avg talk', type: 'seconds' },
  { key: 'outcomes', label: 'Outcomes', type: 'number' },
  { key: 'successes', label: 'Successes', type: 'number' },
  { key: 'conversion', label: 'Conversion %', type: 'percent' },
];

// --- 6. Predictive Dialer: pacing and drop rate, per campaign or per hour ---
async function predictive({ db, range, q, scope }) {
  const campaignId = idParam(q.campaignId);
  const byHour = q.groupBy === 'hour';
  const s = scoped(scope, 'campaigns', 'da.campaign_id');
  const key = byHour ? `HOUR(CONVERT_TZ(da.started_at, '+00:00', '${range.offset}'))` : `${CAMPAIGN_NAME}`;
  const [rows] = await db.query(
    `SELECT ${key} AS k, COUNT(*) AS attempts,
            SUM(da.answered_at IS NOT NULL) AS answered, SUM(da.result = 'machine') AS machine,
            SUM(da.connected_at IS NOT NULL) AS connected,
            SUM(da.result = 'abandoned') AS dropped, SUM(da.result = 'customer_hangup') AS hung_up,
            SUM(da.result = 'no_answer') AS no_answer, SUM(da.result = 'busy') AS busy,
            SUM(da.result IN ('congestion', 'failed', 'network_error', 'invalid')) AS failed,
            AVG(da.ratio_at_dial) AS ratio,
            AVG(IF(da.answered_at IS NULL, NULL, TIMESTAMPDIFF(SECOND, da.started_at, da.answered_at))) AS ring,
            AVG(IF(da.connected_at IS NULL, NULL, TIMESTAMPDIFF(SECOND, da.answered_at, da.connected_at))) AS wait,
            COUNT(DISTINCT da.agent_user_id) AS agents
     FROM dial_attempts da JOIN campaigns c ON c.id = da.campaign_id
     WHERE da.started_at >= ? AND da.started_at < ?${campaignId ? ' AND da.campaign_id = ?' : ''}${s.sql}
     GROUP BY k ORDER BY ${byHour ? 'k' : 'attempts DESC'}`,
    [range.start, range.end, ...(campaignId ? [campaignId] : []), ...s.params],
  );
  const p = (n) => String(n).padStart(2, '0');
  const out = rows.map((r) => {
    const answered = num(r.answered);
    const human = answered - num(r.machine);
    const drops = num(r.dropped) + num(r.hung_up);
    return {
      name: byHour ? `${p(Number(r.k))}:00 - ${p((Number(r.k) + 1) % 24)}:00` : r.k,
      attempts: num(r.attempts),
      no_answer: num(r.no_answer),
      busy: num(r.busy),
      failed: num(r.failed),
      machine: num(r.machine),
      human,
      connected: num(r.connected),
      dropped: num(r.dropped),
      hung_up: num(r.hung_up),
      drop_rate: pct(drops, human),
      answer_rate: pct(answered, num(r.attempts)),
      avg_ratio: r.ratio == null ? null : Math.round(Number(r.ratio) * 100) / 100,
      avg_ring_seconds: r.ring == null ? null : Math.round(Number(r.ring)),
      avg_wait_seconds: r.wait == null ? null : Math.round(Number(r.wait)),
      agents: num(r.agents),
    };
  });
  const t = sum(out, [
    'attempts',
    'no_answer',
    'busy',
    'failed',
    'machine',
    'human',
    'connected',
    'dropped',
    'hung_up',
  ]);
  return {
    columns: [
      { key: 'name', label: byHour ? 'Hour' : 'Campaign' },
      { key: 'attempts', label: 'Dial attempts', type: 'number' },
      { key: 'no_answer', label: 'No answer', type: 'number' },
      { key: 'busy', label: 'Busy', type: 'number' },
      { key: 'failed', label: 'Failed / network', type: 'number' },
      { key: 'answer_rate', label: 'Answer %', type: 'percent' },
      { key: 'machine', label: 'Machine (AMD)', type: 'number' },
      { key: 'human', label: 'Human answered', type: 'number' },
      { key: 'connected', label: 'Connected to agent', type: 'number' },
      { key: 'dropped', label: 'Dropped (no agent)', type: 'number' },
      { key: 'hung_up', label: 'Hung up waiting', type: 'number' },
      { key: 'drop_rate', label: 'Drop %', type: 'percent', warnAbove: 3 },
      { key: 'avg_ratio', label: 'Avg dial ratio', type: 'decimal' },
      { key: 'avg_ring_seconds', label: 'Avg ring', type: 'seconds' },
      { key: 'avg_wait_seconds', label: 'Avg wait for agent', type: 'seconds' },
      { key: 'agents', label: 'Agents', type: 'number' },
    ],
    rows: out,
    totals: {
      name: 'Total',
      ...t,
      answer_rate: pct(t.human + t.machine, t.attempts),
      drop_rate: pct(t.dropped + t.hung_up, t.human),
    },
    notes: [
      'Drop % = (dropped + hung up waiting) / human answered. Keep it under 3 % (the usual legal limit for predictive dialing): lower the dial ratio or add agents if it is red.',
    ],
  };
}

// --- 9. List Penetration (current state of each list; the date range is not used) ---
async function listPenetration({ db, q, scope }) {
  const campaignId = idParam(q.campaignId);
  const s = scoped(scope, 'campaigns', 'li.campaign_id');
  const [rows] = await db.query(
    `SELECT li.id, li.name, ${CAMPAIGN_NAME} AS campaign, li.is_active,
            COUNT(l.id) AS leads, SUM(l.attempts = 0) AS never, SUM(l.attempts > 0) AS called,
            SUM(ct.lead_id IS NOT NULL) AS contacted, SUM(l.is_final = 1) AS final,
            SUM(l.is_final = 0 AND l.next_call_at IS NOT NULL) AS waiting,
            SUM(l.status = 'do_not_call') AS dnc, AVG(l.attempts) AS avg_attempts
     FROM lists li
     JOIN campaigns c ON c.id = li.campaign_id
     LEFT JOIN leads l ON l.list_id = li.id AND l.deleted_at IS NULL
     LEFT JOIN (SELECT DISTINCT lead_id FROM calls WHERE agent_connect_time IS NOT NULL AND lead_id IS NOT NULL) ct
       ON ct.lead_id = l.id
     WHERE li.deleted_at IS NULL${campaignId ? ' AND li.campaign_id = ?' : ''}${s.sql}
     GROUP BY li.id, li.name, campaign, li.is_active
     ORDER BY li.id DESC`,
    [...(campaignId ? [campaignId] : []), ...s.params],
  );
  const out = rows.map((r) => ({
    list: r.name,
    campaign: r.campaign,
    active: r.is_active ? 'Yes' : 'No',
    leads: num(r.leads),
    never_called: num(r.never),
    called: num(r.called),
    penetration: pct(num(r.called), num(r.leads)),
    contacted: num(r.contacted),
    contact_rate: pct(num(r.contacted), num(r.called)),
    final: num(r.final),
    waiting: num(r.waiting),
    dnc: num(r.dnc),
    avg_attempts: r.avg_attempts == null ? null : Math.round(Number(r.avg_attempts) * 10) / 10,
  }));
  const t = sum(out, ['leads', 'never_called', 'called', 'contacted', 'final', 'waiting', 'dnc']);
  return {
    columns: [
      { key: 'list', label: 'List' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'active', label: 'Active' },
      { key: 'leads', label: 'Leads', type: 'number' },
      { key: 'never_called', label: 'Never called', type: 'number' },
      { key: 'called', label: 'Called', type: 'number' },
      { key: 'penetration', label: 'Penetration %', type: 'percent' },
      { key: 'contacted', label: 'Reached a person', type: 'number' },
      { key: 'contact_rate', label: 'Contact %', type: 'percent' },
      { key: 'final', label: 'Done (final)', type: 'number' },
      { key: 'waiting', label: 'Waiting retry / callback', type: 'number' },
      { key: 'dnc', label: 'Do Not Call', type: 'number' },
      { key: 'avg_attempts', label: 'Avg attempts', type: 'decimal' },
    ],
    rows: out,
    totals: {
      list: 'Total',
      ...t,
      penetration: pct(t.called, t.leads),
      contact_rate: pct(t.contacted, t.called),
    },
    notes: ['Shows each list as it is now - the date range is not used.'],
  };
}

// --- 10. Callbacks: due in the range, per agent ---
async function callbacks({ db, range, q, scope }) {
  const campaignId = idParam(q.campaignId);
  const agentId = idParam(q.agentId);
  const s = scoped(scope, 'campaigns', 'cb.campaign_id');
  const [rows] = await db.query(
    `SELECT COALESCE(u.username, '(any agent - shared)') AS owner,
            COUNT(*) AS scheduled, SUM(cb.status = 'done') AS done, SUM(cb.status = 'cancelled') AS cancelled,
            SUM(cb.status = 'pending' AND cb.callback_at >= NOW()) AS upcoming,
            SUM(cb.status = 'pending' AND cb.callback_at < NOW()) AS overdue
     FROM callbacks cb LEFT JOIN users u ON u.id = cb.user_id
     WHERE cb.callback_at >= ? AND cb.callback_at < ?${campaignId ? ' AND cb.campaign_id = ?' : ''}${agentId ? ' AND cb.user_id = ?' : ''}${s.sql}
     GROUP BY owner ORDER BY overdue DESC, scheduled DESC`,
    [range.start, range.end, ...(campaignId ? [campaignId] : []), ...(agentId ? [agentId] : []), ...s.params],
  );
  const out = rows.map((r) => ({
    agent: r.owner,
    scheduled: num(r.scheduled),
    done: num(r.done),
    upcoming: num(r.upcoming),
    overdue: num(r.overdue),
    cancelled: num(r.cancelled),
    done_rate: pct(num(r.done), num(r.scheduled) - num(r.upcoming) - num(r.cancelled)),
  }));
  const t = sum(out, ['scheduled', 'done', 'upcoming', 'overdue', 'cancelled']);
  return {
    columns: [
      { key: 'agent', label: 'Agent' },
      { key: 'scheduled', label: 'Due in range', type: 'number' },
      { key: 'done', label: 'Done', type: 'number' },
      { key: 'upcoming', label: 'Still to come', type: 'number' },
      { key: 'overdue', label: 'Overdue', type: 'number', warnAbove: 0 },
      { key: 'cancelled', label: 'Cancelled', type: 'number' },
      { key: 'done_rate', label: 'Done % (of due so far)', type: 'percent' },
    ],
    rows: out,
    totals: {
      agent: 'Total',
      ...t,
      done_rate: pct(t.done, t.scheduled - t.upcoming - t.cancelled),
    },
  };
}

module.exports = { campaignPerformance, shapeCampaign, predictive, listPenetration, callbacks };
