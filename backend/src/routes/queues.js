const express = require('express');
const { deleteQueue } = require('../services/softDelete');
const pool = require('../../db');
const ami = require('../../ami');
const { requirePermission, requireAdminSide } = require('../middleware/auth');
const { QUEUE_DEFAULTS, parseQueueSettings, slugify } = require('../services/queueConfig');

const router = express.Router();

// --- Admin: standalone queue management (reusable across campaigns) ---
// Queues live only in the database: Asterisk reads them through the
// ast_queues view (migration 0002, docs/plans/ASTERISK_REALTIME_PLAN.md),
// so nothing here touches Asterisk's files.

/** Asks Asterisk to re-read a queue's settings now (it also does on next use). Never fails the request. */
async function refreshInAsterisk() {
  try {
    await ami.queueReload();
  } catch (err) {
    console.error('[queue reload]', err.message);
  }
}
router.get('/admin/queues', requireAdminSide, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM queues WHERE deleted_at IS NULL ORDER BY id DESC');
  res.json(rows);
});

router.post('/admin/queues', requirePermission('queues', 'create'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const asteriskName = slugify(name);
  if (!asteriskName) return res.status(400).json({ error: 'name must contain at least one letter or digit' });
  const { error, settings } = parseQueueSettings(req.body, QUEUE_DEFAULTS);
  if (error) return res.status(400).json({ error });
  const { ringStrategy, waitTimeout, announce, retry, timeoutRestart } = settings;

  const [existing] = await pool.query('SELECT id FROM queues WHERE asterisk_name = ? AND deleted_at IS NULL', [
    asteriskName,
  ]);
  if (existing[0]) {
    return res.status(409).json({ error: 'a queue with a matching name already exists' });
  }

  const [result] = await pool.query(
    `INSERT INTO queues (tenant_id, name, asterisk_name, ring_strategy, wait_timeout, announce, retry, timeout_restart)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    [name, asteriskName, ringStrategy, waitTimeout, announce, retry, timeoutRestart],
  );

  // Asterisk finds the new queue in the database the first time it's used.
  res.status(201).json({ id: result.insertId, name, asteriskName });
});

router.put('/admin/queues/:id', requirePermission('queues', 'edit'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM queues WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  const queue = rows[0];
  if (!queue) return res.status(404).json({ error: 'queue not found' });

  // Name/asterisk_name is intentionally not editable here - agents' live
  // queue membership and every campaign point at it.
  // Fields left out keep their current value.
  const { error, settings: updated } = parseQueueSettings(req.body, {
    ringStrategy: queue.ring_strategy,
    waitTimeout: queue.wait_timeout,
    announce: queue.announce,
    retry: queue.retry,
    timeoutRestart: queue.timeout_restart,
  });
  if (error) return res.status(400).json({ error });

  await pool.query(
    'UPDATE queues SET ring_strategy = ?, wait_timeout = ?, announce = ?, retry = ?, timeout_restart = ? WHERE id = ?',
    [updated.ringStrategy, updated.waitTimeout, updated.announce, updated.retry, updated.timeoutRestart, req.params.id],
  );

  await refreshInAsterisk();
  res.json({ id: Number(req.params.id), ...updated });
});

// Delete always works and keeps history: campaigns using it lose it (and
// stop dialing); Asterisk no longer sees it (ast_queues view).
router.delete('/admin/queues/:id', requirePermission('queues', 'delete'), async (req, res) => {
  const notes = await deleteQueue(Number(req.params.id), req.session.user.id);
  if (notes === null) return res.status(404).json({ error: 'queue not found' });
  res.json({ status: 'ok', notes });
  await refreshInAsterisk();
});

module.exports = router;
