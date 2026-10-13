const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../middleware/auth');
const { can } = require('../services/access');
const { audit } = require('../services/audit');
const { byKey, catalog } = require('../services/reports');
const { parseRange, ZONE } = require('../services/reports/time');
const { scoped } = require('../services/reports/common');

// Reports (src/services/reports). A team-scoped role's reports cover only
// its teams' campaigns and agents. ?format=csv = the same report as a file
// (right Reports -> Export CSV; every export is in the audit log).

const router = express.Router();

const BOM = String.fromCharCode(0xfeff); // so Excel opens the CSV as UTF-8

/** CSV of a report:the column labels, the rows, the totals row. Formulas can't start a cell (=,+,-,@). */
function toCsv({ columns, rows, totals }) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // A recording column holds the call id (for the player); a file just says Yes.
  const value = (c, v) => (c.type === 'recording' ? (v ? 'Yes' : null) : v);
  const line = (r) => columns.map((c) => cell(value(c, r[c.key]))).join(',');
  const lines = [columns.map((c) => cell(c.label)).join(','), ...rows.map(line)];
  if (totals) lines.push(line(totals));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

// The list of reports + what the filters offer (only the caller's scope;
// the Reports right alone is enough - no Campaigns / Users right needed).
router.get('/admin/reports', requirePermission('reports', 'view'), async (req, res) => {
  const scope = req.access.scope;
  const cs = scoped(scope, 'campaigns', 'c.id');
  const as = scoped(scope, 'agents', 'id');
  const [campaigns] = await pool.query(
    `SELECT c.id, CONCAT(c.name, IF(c.deleted_at IS NULL, '', ' (deleted)')) AS name FROM campaigns c
     WHERE 1 = 1${cs.sql} ORDER BY c.deleted_at IS NULL DESC, c.name`,
    cs.params,
  );
  const [agents] = await pool.query(
    `SELECT id, username FROM users WHERE role = 'agent'${as.sql} ORDER BY username`,
    as.params,
  );
  const [outcomes] = await pool.query(
    `SELECT cd.code, MIN(cd.label) AS label FROM campaign_dispositions cd JOIN campaigns c ON c.id = cd.campaign_id
     WHERE 1 = 1${cs.sql} GROUP BY cd.code ORDER BY label`,
    cs.params,
  );
  res.json({ timezone: ZONE, reports: catalog(), campaigns, agents, outcomes });
});

router.get('/admin/reports/:key', requirePermission('reports', 'view'), async (req, res) => {
  const report = byKey[req.params.key];
  if (!report) return res.status(404).json({ error: 'no such report' });
  const csv = req.query.format === 'csv';
  if (csv && !can(req.access, 'reports', 'export')) {
    return res.status(403).json({ error: "Your role doesn't allow: Reports - Export CSV" });
  }
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  let result;
  try {
    result = await report.run({ db: pool, range, q: req.query, scope: req.access.scope, csv });
  } catch (err) {
    console.error(`[report ${report.key}]`, err);
    return res.status(500).json({ error: `could not build the report: ${err.message}` });
  }
  const body = {
    report: report.key,
    title: report.title,
    from: range.from,
    to: range.to,
    timezone: range.zone,
    ...result,
  };
  if (!csv) return res.json(body);
  void audit({
    user: req.session.user,
    action: 'reports.export',
    entity: 'reports',
    summary: `${report.title} ${range.from}..${range.to} (${result.rows.length} rows)`,
    request: req.query,
    ip: req.ip,
  });
  const name = report.noRange
    ? report.key
    : `${report.key}-${range.from}${range.to !== range.from ? `-to-${range.to}` : ''}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dialforge-${name}.csv"`);
  res.send(toCsv(result));
});

module.exports = router;
module.exports.toCsv = toCsv; // tests
