const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../middleware/auth');
const { scopeCondition } = require('../services/access');

// A team-scoped role's reports cover only its teams' campaigns and agents.
const andScope = (req, kind, column) => {
  const [cond, params] = scopeCondition(req.access.scope, kind, column);
  return { sql: cond ? ` AND ${cond}` : '', params };
};

const router = express.Router();

// --- Reports: CSV export helper + shared date-range parsing ---
function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

function sendReport(req, res, rows, filename) {
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(toCsv(rows));
  }
  res.json(rows);
}

function dateRange(req) {
  const today = new Date().toISOString().slice(0, 10);
  return { from: req.query.from || today, to: req.query.to || req.query.from || today };
}

// --- Campaign report: per-campaign call outcomes for a date range ---
router.get('/admin/reports/campaigns', requirePermission('reports', 'view'), async (req, res) => {
  const { from, to } = dateRange(req);
  const [rows] = await pool.query(
    `SELECT
       c.id AS campaign_id, c.name AS campaign_name,
       (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id) AS total_leads,
       COUNT(ca.id) AS total_calls,
       SUM(ca.answer_time IS NOT NULL) AS answered,
       SUM(ca.answer_time IS NULL AND (ca.disposition IS NULL OR ca.disposition != 'abandoned')) AS not_answered,
       SUM(ca.disposition = 'abandoned') AS abandoned,
       COALESCE(AVG(CASE WHEN ca.answer_time IS NOT NULL
         THEN TIMESTAMPDIFF(SECOND, ca.answer_time, COALESCE(ca.end_time, NOW())) END), 0) AS avg_talk_seconds
     FROM campaigns c
     LEFT JOIN calls ca ON ca.campaign_id = c.id AND DATE(ca.start_time) BETWEEN ? AND ?
     WHERE 1 = 1${andScope(req, 'campaigns', 'c.id').sql}
     GROUP BY c.id, c.name
     ORDER BY c.id DESC`,
    [from, to, ...andScope(req, 'campaigns', 'c.id').params],
  );
  const result = rows.map((r) => {
    const totalCalls = Number(r.total_calls);
    const answered = Number(r.answered);
    return {
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      total_leads: Number(r.total_leads),
      total_calls: totalCalls,
      answered,
      not_answered: Number(r.not_answered),
      abandoned: Number(r.abandoned),
      answer_rate: totalCalls > 0 ? Math.round((answered / totalCalls) * 100) : 0,
      avg_talk_seconds: Math.round(Number(r.avg_talk_seconds)),
    };
  });
  sendReport(req, res, result, 'campaign-report.csv');
});

// --- Agent report: per-agent activity for a date range ---
// Attributes each call to whichever agent was ACTUALLY using that
// extension at the time (via agent_status_log.extension_name + a
// time-window join), not the login account's statically-assigned
// extension - that exact mismatch was a real bug fixed twice already
// this project (see RUNBOOK Phase 8 6d/6f), not repeating it here.
router.get('/admin/reports/agents', requirePermission('reports', 'view'), async (req, res) => {
  const { from, to } = dateRange(req);

  const [callStats] = await pool.query(
    `SELECT
       asl.user_id,
       COUNT(ca.id) AS total_calls,
       SUM(ca.answer_time IS NOT NULL) AS answered_calls,
       COALESCE(SUM(CASE WHEN ca.answer_time IS NOT NULL
         THEN TIMESTAMPDIFF(SECOND, ca.answer_time, COALESCE(ca.end_time, NOW())) ELSE 0 END), 0) AS talk_seconds
     FROM calls ca
     JOIN agent_status_log asl
       ON asl.extension_name = ca.from_extension
      AND ca.start_time >= asl.started_at
      AND (asl.ended_at IS NULL OR ca.start_time <= asl.ended_at)
     WHERE ca.from_extension IS NOT NULL AND DATE(ca.start_time) BETWEEN ? AND ?
     GROUP BY asl.user_id`,
    [from, to],
  );

  const [loginStats] = await pool.query(
    `SELECT user_id,
       COALESCE(SUM(TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, NOW()))), 0) AS login_seconds
     FROM agent_status_log
     WHERE DATE(started_at) BETWEEN ? AND ?
     GROUP BY user_id`,
    [from, to],
  );

  const [callbackStats] = await pool.query(
    `SELECT updated_by AS user_id, COUNT(*) AS callbacks
     FROM leads
     WHERE status = 'callback' AND updated_by IS NOT NULL AND DATE(updated_at) BETWEEN ? AND ?
     GROUP BY updated_by`,
    [from, to],
  );

  const agentScope = andScope(req, 'agents', 'id');
  const [agents] = await pool.query(
    `SELECT id, username FROM users WHERE role = 'agent'${agentScope.sql}`,
    agentScope.params,
  );

  const callMap = Object.fromEntries(callStats.map((r) => [r.user_id, r]));
  const loginMap = Object.fromEntries(loginStats.map((r) => [r.user_id, r]));
  const callbackMap = Object.fromEntries(callbackStats.map((r) => [r.user_id, r]));

  const result = agents.map((a) => {
    const calls = callMap[a.id];
    const login = loginMap[a.id];
    const callbacks = callbackMap[a.id];
    const totalCalls = calls ? Number(calls.total_calls) : 0;
    const talkSeconds = calls ? Number(calls.talk_seconds) : 0;
    return {
      user_id: a.id,
      username: a.username,
      login_seconds: login ? Number(login.login_seconds) : 0,
      total_calls: totalCalls,
      answered_calls: calls ? Number(calls.answered_calls) : 0,
      talk_seconds: talkSeconds,
      avg_talk_seconds: totalCalls > 0 ? Math.round(talkSeconds / totalCalls) : 0,
      callbacks_set: callbacks ? Number(callbacks.callbacks) : 0,
    };
  });
  sendReport(req, res, result, 'agent-report.csv');
});

// --- Call report: filterable detailed call list ---
router.get('/admin/reports/calls', requirePermission('reports', 'view'), async (req, res) => {
  const { from, to } = dateRange(req);
  const { campaignId, extension, disposition } = req.query;
  let sql = `
    SELECT ca.id, ca.direction, ca.from_extension, ca.to_number, ca.disposition,
           ca.start_time, ca.answer_time, ca.end_time, c.name AS campaign_name
    FROM calls ca
    LEFT JOIN campaigns c ON c.id = ca.campaign_id
    WHERE DATE(ca.start_time) BETWEEN ? AND ?
  `;
  const params = [from, to];
  const callScope = andScope(req, 'campaigns', 'ca.campaign_id');
  sql += callScope.sql;
  params.push(...callScope.params);
  if (campaignId) {
    sql += ' AND ca.campaign_id = ?';
    params.push(campaignId);
  }
  if (extension) {
    sql += ' AND ca.from_extension = ?';
    params.push(extension);
  }
  if (disposition) {
    sql += ' AND ca.disposition = ?';
    params.push(disposition);
  }
  sql += ' ORDER BY ca.id DESC LIMIT 500';
  const [rows] = await pool.query(sql, params);
  sendReport(req, res, rows, 'call-report.csv');
});

// --- Hourly report: call volume + answer rate by hour, one day at a time ---
router.get('/admin/reports/hourly', requirePermission('reports', 'view'), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const [rows] = await pool.query(
    `SELECT HOUR(start_time) AS hour, COUNT(*) AS total_calls, SUM(answer_time IS NOT NULL) AS answered
     FROM calls WHERE DATE(start_time) = ?${andScope(req, 'campaigns', 'campaign_id').sql}
     GROUP BY HOUR(start_time)`,
    [date, ...andScope(req, 'campaigns', 'campaign_id').params],
  );
  const byHour = {};
  for (const r of rows) byHour[r.hour] = { total_calls: Number(r.total_calls), answered: Number(r.answered) };
  const result = [];
  for (let h = 0; h < 24; h++) {
    const d = byHour[h] || { total_calls: 0, answered: 0 };
    result.push({
      hour: h,
      total_calls: d.total_calls,
      answered: d.answered,
      answer_rate: d.total_calls > 0 ? Math.round((d.answered / d.total_calls) * 100) : 0,
    });
  }
  sendReport(req, res, result, 'hourly-report.csv');
});

module.exports = router;
