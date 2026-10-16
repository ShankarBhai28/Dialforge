// Leads -> Export: the leads matching the Leads filters as an Excel file,
// streamed in batches so a big list never sits in memory. One column per
// form field (the campaign's form labels when a campaign is filtered,
// otherwise every key the leads carry).
const ExcelJS = require('exceljs');
const pool = require('../../db');
const { leadWhere } = require('./leadFilters');
const { getCampaignFormFields } = require('./leadImport');
const { RESULT_LABELS } = require('./reports/common');
const { NAME_KEY } = require('./leadData');

const MAX_ROWS = 200000;
const BATCH = 5000;

const BASE = [
  ['ID', 'id', 9],
  ['Name', 'name', 24],
  ['Phone', 'phone', 15],
  ['Alt phone', 'alt_phone', 15],
  ['Campaign', 'campaign_name', 20],
  ['List', 'list_name', 20],
  ['Status', 'status_label', 18],
  ['Attempts', 'attempts', 9],
  ['Last call', 'last_attempt_at', 18],
  ['Next call', 'next_call_at', 18],
  ['Done (no more calls)', 'is_final', 10],
  ['Given to agent', 'assigned_to', 16],
  ['Priority', 'priority', 9],
  ['Created', 'created_at', 18],
  // How the lead was worked (from its calls, outcomes and callbacks).
  ['Last agent', 'last_agent', 14],
  ['Last call result', 'last_result', 18],
  ['Calls', 'calls', 7],
  ['Connected', 'connected', 10],
  ['Talk time (seconds)', 'talk_seconds', 12],
  ['Last note', 'last_note', 30],
  ['Callback due', 'callback_due', 18],
];

/** A call's result in words (the same words as the Call log and reports). */
function resultOf(c) {
  if (c.agent_connect_time) return 'Answered';
  if (c.disposition) return RESULT_LABELS[c.disposition] || c.disposition;
  return c.end_time ? 'Not answered' : 'In progress';
}

/**
 * The form columns: [header, key], with the form's LABELS (not its internal
 * keys) in the form's order, every field included even when empty. The form
 * of the campaign being exported (campaign filter, or the list's campaign);
 * otherwise the forms of the campaigns the leads are in, then any saved key
 * no form has. The form's "name" field is the lead's Name column (one name
 * per customer), so it isn't repeated. A label equal to a fixed column gets
 * "(form)" so no two headers are the same.
 */
async function formColumns(db, query, where, deps) {
  let campaignId = query.campaignId && query.campaignId !== 'none' ? Number(query.campaignId) : null;
  if (!campaignId && query.listId) {
    const [[list]] = await db.query('SELECT campaign_id FROM lists WHERE id = ?', [Number(query.listId)]);
    campaignId = list ? list.campaign_id : null;
  }
  let fields = [];
  if (campaignId) {
    fields = (await deps.getCampaignFormFields(campaignId)).map((x) => [x.label, x.field_key]);
  } else {
    const [rows] = await db.query(
      `SELECT ff.field_key, ff.label FROM form_fields ff JOIN campaigns c ON c.form_id = ff.form_id
       WHERE c.id IN (SELECT DISTINCT l.campaign_id FROM leads l ${where.sql}) ORDER BY c.id, ff.sort_order, ff.id`,
      where.params,
    );
    fields = rows.map((r) => [r.label, r.field_key]);
  }
  const known = new Set(fields.map(([, k]) => k));
  const [keys] = await db.query(
    `SELECT DISTINCT jt.k FROM leads l, JSON_TABLE(JSON_KEYS(COALESCE(l.custom_data, JSON_OBJECT())), '$[*]' COLUMNS (k VARCHAR(64) PATH '$')) jt
     ${where.sql} LIMIT 200`,
    where.params,
  );
  for (const { k } of keys) if (!known.has(k)) fields.push([k, k]); // saved, but on no current form
  const fixed = new Set(BASE.map(([h]) => h.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const [label, key] of fields) {
    if (key === NAME_KEY || seen.has(key)) continue;
    seen.add(key);
    const header = fixed.has(String(label).toLowerCase()) ? `${label} (form)` : label;
    out.push([header, key]);
  }
  return out;
}

/** For one batch of leads: { leadId: { last_agent, last_result, calls, connected, talk_seconds, last_note, callback_due } }. */
async function workedDetails(db, ids) {
  const out = Object.fromEntries(ids.map((id) => [id, { calls: 0, connected: 0, talk_seconds: 0 }]));
  if (!ids.length) return out;
  const [agg] = await db.query(
    `SELECT lead_id, COUNT(*) AS calls, SUM(agent_connect_time IS NOT NULL) AS connected,
       SUM(IF(agent_connect_time IS NULL, 0,
           GREATEST(TIMESTAMPDIFF(SECOND, agent_connect_time, COALESCE(end_time, agent_connect_time)), 0))) AS talk
     FROM calls WHERE lead_id IN (?) GROUP BY lead_id`,
    [ids],
  );
  for (const r of agg)
    Object.assign(out[r.lead_id], {
      calls: Number(r.calls),
      connected: Number(r.connected || 0),
      talk_seconds: Number(r.talk || 0),
    });
  // The latest call (its result) and the latest call an agent took (who handled the customer last).
  const [last] = await db.query(
    `SELECT ca.lead_id, ca.agent_connect_time, ca.disposition, ca.end_time FROM calls ca
     JOIN (SELECT lead_id, MAX(id) AS id FROM calls WHERE lead_id IN (?) GROUP BY lead_id) m ON m.id = ca.id`,
    [ids],
  );
  for (const r of last) out[r.lead_id].last_result = resultOf(r);
  const [talked] = await db.query(
    `SELECT ca.lead_id, COALESCE(u.username, CONCAT('ext ', ca.from_extension)) AS agent FROM calls ca
     JOIN (SELECT lead_id, MAX(id) AS id FROM calls WHERE lead_id IN (?) AND agent_connect_time IS NOT NULL GROUP BY lead_id) m
       ON m.id = ca.id
     LEFT JOIN users u ON u.id = ca.agent_user_id`,
    [ids],
  );
  for (const r of talked) out[r.lead_id].last_agent = r.agent;
  // The latest outcome that came with a note.
  const [notes] = await db.query(
    `SELECT a.entity_id AS lead_id, JSON_UNQUOTE(JSON_EXTRACT(a.request_json, '$.note')) AS note FROM audit_log a
     JOIN (SELECT entity_id, MAX(id) AS id FROM audit_log
           WHERE action = 'leads.outcome' AND entity = 'leads' AND entity_id IN (?) AND (status IS NULL OR status = 200)
             AND JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.note')) <> ''
           GROUP BY entity_id) m ON m.id = a.id`,
    [ids],
  );
  for (const r of notes) if (out[r.lead_id]) out[r.lead_id].last_note = r.note;
  const [cbs] = await db.query(
    "SELECT lead_id, MIN(callback_at) AS due FROM callbacks WHERE status = 'pending' AND lead_id IN (?) GROUP BY lead_id",
    [ids],
  );
  for (const r of cbs) out[r.lead_id].callback_due = r.due;
  return out;
}

/** Plain text for a cell: dates as "2026-10-15 14:05", objects as JSON. */
function cell(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace('T', ' ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Writes the workbook to `res`; returns the number of leads written. */
async function exportLeads(query, scope, res, deps = { pool, getCampaignFormFields }) {
  const db = deps.pool;
  const where = leadWhere(query, scope);

  const formCols = await formColumns(db, query, where, deps);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="viztex-leads-${stamp}.xlsx"`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet('Leads');
  ws.columns = [
    ...BASE.map(([header, key, width]) => ({ header, key, width })),
    ...formCols.map(([label, key]) => ({ header: label, key: `f:${key}`, width: 18 })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();

  let lastId = 0;
  let written = 0;
  while (written < MAX_ROWS) {
    const [rows] = await db.query(
      `SELECT l.id, l.name, l.phone, l.alt_phone, l.status, l.attempts, l.last_attempt_at, l.next_call_at, l.is_final,
              l.priority, l.created_at, l.custom_data, c.name AS campaign_name, ls.name AS list_name,
              au.username AS assigned_to, cd.label AS status_label
       FROM leads l
       LEFT JOIN campaigns c ON c.id = l.campaign_id
       LEFT JOIN lists ls ON ls.id = l.list_id
       LEFT JOIN users au ON au.id = l.assigned_user_id
       LEFT JOIN campaign_dispositions cd ON cd.campaign_id = l.campaign_id AND cd.code = l.status
       ${where.sql ? where.sql + ' AND' : 'WHERE'} l.id > ?
       ORDER BY l.id LIMIT ?`,
      [...where.params, lastId, Math.min(BATCH, MAX_ROWS - written)],
    );
    if (!rows.length) break;
    const worked = await workedDetails(
      db,
      rows.map((r) => r.id),
    );
    for (const r of rows) {
      Object.assign(r, worked[r.id]);
      const data = typeof r.custom_data === 'string' ? JSON.parse(r.custom_data || '{}') : r.custom_data || {};
      const out = {};
      for (const [, key] of BASE) out[key] = cell(r[key]);
      out.status_label = r.status_label || r.status;
      out.is_final = r.is_final ? 'yes' : 'no';
      for (const [, key] of formCols) out[`f:${key}`] = cell(data[key]);
      ws.addRow(out).commit();
    }
    written += rows.length;
    lastId = rows[rows.length - 1].id;
  }
  ws.commit();
  await wb.commit();
  return written;
}

module.exports = { exportLeads, workedDetails, MAX_ROWS };
