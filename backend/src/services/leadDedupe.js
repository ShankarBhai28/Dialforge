// Lead upload: which rows go in, which are skipped and why.
//
// Duplicate check (chosen on the upload screen), on the normalised number
// ("+91 98400 12345" = "9840012345"), matching a lead's phone or alt phone:
//   none     - no check, every valid row is imported
//   file     - only numbers repeated inside this file
//   list     - the file + leads already in the chosen list
//   campaign - the file + leads already in any list of the campaign (default)
//   all      - the file + leads in every campaign
// Numbers on the DNC list are always skipped (compliance), and invalid rows
// are always rejected. Every skipped row goes into a downloadable Excel
// report with its original columns and the reason.
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { parseLeadCustomValue } = require('./leadImport');

const DUP_SCOPES = ['none', 'file', 'list', 'campaign', 'all'];
const DEFAULT_SCOPE = 'campaign';

/**
 * Leads already in the database with one of these numbers, within the
 * scope: Map number -> { id, list, campaign, campaignId }.
 */
async function findExisting(numbers, scope, { listId, campaignId }, deps = { pool }) {
  const found = new Map();
  if (!['list', 'campaign', 'all'].includes(scope) || !numbers.length) return found;
  const where = scope === 'list' ? ' AND l.list_id = ?' : scope === 'campaign' ? ' AND l.campaign_id = ?' : '';
  const extra = scope === 'list' ? [listId] : scope === 'campaign' ? [campaignId] : [];
  const unique = [...new Set(numbers)];
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000);
    const [rows] = await deps.pool.query(
      `SELECT l.id, l.phone, l.alt_phone, l.campaign_id, ls.name AS list, c.name AS campaign
       FROM leads l LEFT JOIN lists ls ON ls.id = l.list_id LEFT JOIN campaigns c ON c.id = l.campaign_id
       WHERE l.deleted_at IS NULL AND (l.phone IN (?) OR l.alt_phone IN (?))${where}
       ORDER BY l.id`,
      [chunk, chunk, ...extra],
    );
    for (const r of rows) {
      const info = { id: r.id, list: r.list, campaign: r.campaign, campaignId: r.campaign_id };
      for (const n of [r.phone, r.alt_phone].map(normalizePhone)) if (n && !found.has(n)) found.set(n, info);
    }
  }
  return found;
}

const validNumber = (n) => n.length >= 7 && n.length <= 15;

/**
 * Pure: decides every row. `existing` from findExisting, `dnc` a Set of
 * numbers. `campaignInScope(id)`: may the uploader see that campaign's name.
 * Returns { toInsert: [{ phone, altPhone, name, priority, custom }], skipped, summary }.
 */
function planImport({ rows, fields, scope, existing, dnc, campaignInScope = () => true }) {
  const summary = { total: rows.length, imported: 0, inFile: 0, existing: 0, dnc: 0, invalid: 0 };
  const skipped = [];
  const toInsert = [];
  const seenInFile = new Map(); // number -> row number of its first appearance
  const skip = (row, kind, reason) => {
    summary[kind]++;
    skipped.push({ rowNum: row.rowNum, values: row.values, kind, reason });
  };

  for (const row of rows) {
    const { values } = row;
    const phone = normalizePhone(values.phone);
    if (!validNumber(phone)) {
      skip(row, 'invalid', `Invalid phone "${values.phone ?? ''}"`);
      continue;
    }
    let altPhone = null;
    if (values.alt_phone) {
      altPhone = normalizePhone(values.alt_phone);
      if (!validNumber(altPhone)) {
        skip(row, 'invalid', `Invalid alt_phone "${values.alt_phone}"`);
        continue;
      }
    }
    let priority = 0;
    if (values.priority) {
      priority = Number(values.priority);
      if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
        skip(row, 'invalid', 'priority must be a whole number -100..100');
        continue;
      }
    }
    const custom = {};
    let bad = null;
    for (const f of fields) {
      const raw = values[f.field_key];
      if (!raw) continue;
      const r = parseLeadCustomValue(f, raw);
      if (r.error) {
        bad = `${f.field_key} ${r.error}`;
        break;
      }
      custom[f.field_key] = r.value;
    }
    if (bad) {
      skip(row, 'invalid', bad);
      continue;
    }
    if (dnc.has(phone)) {
      skip(row, 'dnc', 'On the Do Not Call list');
      continue;
    }
    if (scope !== 'none') {
      if (seenInFile.has(phone)) {
        skip(row, 'inFile', `Duplicate: same number as row ${seenInFile.get(phone)} in this file`);
        continue;
      }
      const hit = existing.get(phone);
      if (hit) {
        const where =
          scope === 'list'
            ? `this list (lead #${hit.id})`
            : campaignInScope(hit.campaignId)
              ? `campaign ${hit.campaign ?? '(none)'} - list ${hit.list ?? '(none)'} (lead #${hit.id})`
              : 'another campaign';
        skip(row, 'existing', `Already in ${where}`);
        continue;
      }
      seenInFile.set(phone, row.rowNum);
    }
    toInsert.push({ phone, altPhone, name: values.name || null, priority, custom });
  }
  summary.imported = toInsert.length;
  return { toInsert, skipped, summary };
}

// --- the skipped-rows report: kept 1 hour, only for the uploader ---
const REPORT_TTL_MS = 60 * 60 * 1000;
const reports = new Map(); // id -> { userId, at, headers, skipped, summary, listName, scope, dryRun }

function saveReport(userId, report, now = Date.now()) {
  for (const [id, r] of reports) if (now - r.at > REPORT_TTL_MS) reports.delete(id);
  while (reports.size >= 50) reports.delete(reports.keys().next().value);
  const id = crypto.randomBytes(12).toString('hex');
  reports.set(id, { ...report, userId, at: now });
  return id;
}

function getReport(userId, id, now = Date.now()) {
  const r = reports.get(id);
  if (!r || r.userId !== userId || now - r.at > REPORT_TTL_MS) return null;
  return r;
}

const SCOPE_LABEL = {
  none: 'No duplicate check',
  file: 'Within this file',
  list: 'In this list',
  campaign: 'In this campaign',
  all: 'In all campaigns',
};
const KIND_LABEL = { inFile: 'Duplicate in file', existing: 'Already exists', dnc: 'DNC', invalid: 'Invalid' };

/** The report as an .xlsx: "Not imported" (row, type, reason, the file's columns) + "Summary". */
async function reportWorkbook(report) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Not imported');
  const cols = report.headers.filter(Boolean);
  ws.columns = [
    { header: 'Row in file', key: '__row', width: 11 },
    { header: 'Type', key: '__kind', width: 18 },
    { header: 'Reason', key: '__reason', width: 60 },
    ...cols.map((h) => ({ header: h, key: `c_${h}`, width: Math.max(12, h.length + 2) })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const s of report.skipped) {
    ws.addRow({
      __row: s.rowNum,
      __kind: KIND_LABEL[s.kind] || s.kind,
      __reason: s.reason,
      ...Object.fromEntries(cols.map((h) => [`c_${h}`, s.values[h] ?? ''])),
    });
  }
  const sum = wb.addWorksheet('Summary');
  sum.columns = [
    { header: 'Item', key: 'k', width: 34 },
    { header: 'Value', key: 'v', width: 40 },
  ];
  sum.getRow(1).font = { bold: true };
  const s = report.summary;
  for (const [k, v] of [
    ['List', report.listName],
    ['Duplicate check', SCOPE_LABEL[report.scope]],
    ['Checked only (nothing saved)', report.dryRun ? 'Yes' : 'No'],
    ['Rows in file', s.total],
    [report.dryRun ? 'Would be imported' : 'Imported', s.imported],
    ['Duplicate in file', s.inFile],
    ['Already in the database', s.existing],
    ['On DNC list', s.dnc],
    ['Invalid', s.invalid],
  ])
    sum.addRow({ k, v });
  return wb.xlsx.writeBuffer();
}

module.exports = {
  DUP_SCOPES,
  DEFAULT_SCOPE,
  SCOPE_LABEL,
  findExisting,
  planImport,
  saveReport,
  getReport,
  reportWorkbook,
};
