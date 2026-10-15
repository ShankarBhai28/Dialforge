// Leads -> Export: the leads matching the Leads filters as an Excel file,
// streamed in batches so a big list never sits in memory. One column per
// form field (the campaign's form labels when a campaign is filtered,
// otherwise every key the leads carry).
const ExcelJS = require('exceljs');
const pool = require('../../db');
const { leadWhere } = require('./leadFilters');
const { getCampaignFormFields } = require('./leadImport');

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
];

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

  // Form columns: the filtered campaign's form, else the keys the leads carry.
  let formCols = [];
  if (query.campaignId && query.campaignId !== 'none') {
    formCols = (await deps.getCampaignFormFields(Number(query.campaignId))).map((f) => [f.label, f.field_key]);
  }
  if (!formCols.length) {
    const [keys] = await db.query(
      `SELECT DISTINCT jt.k FROM leads l, JSON_TABLE(JSON_KEYS(COALESCE(l.custom_data, JSON_OBJECT())), '$[*]' COLUMNS (k VARCHAR(64) PATH '$')) jt
       ${where.sql} LIMIT 100`,
      where.params,
    );
    formCols = keys.map((r) => [r.k, r.k]);
  }

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
    for (const r of rows) {
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

module.exports = { exportLeads, MAX_ROWS };
