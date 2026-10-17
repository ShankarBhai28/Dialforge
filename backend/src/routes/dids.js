const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();

// --- Admin: DID numbers, mapped to a queue (a line). Inbound calls to the
// number wait in that queue; every campaign that has the queue (main or
// one of its queues) takes them, and the answering agent's campaign decides
// the form and dispositions. ---
router.get('/admin/dids', requirePermission('numbers', 'view'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT d.id, d.number, d.queue_id, q.name AS queue_name,
      (SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ', ') FROM campaigns c
       LEFT JOIN campaign_queues cq ON cq.campaign_id = c.id
       WHERE c.deleted_at IS NULL AND (c.queue_id = d.queue_id OR cq.queue_id = d.queue_id)) AS campaign_names
    FROM dids d
    LEFT JOIN queues q ON q.id = d.queue_id
    ORDER BY d.id DESC
  `);
  res.json(rows);
});

async function checkQueue(queueId) {
  if (!queueId) return null;
  const [rows] = await pool.query('SELECT id FROM queues WHERE id = ? AND deleted_at IS NULL', [queueId]);
  return rows[0] ? null : 'queue not found';
}

router.post('/admin/dids', requirePermission('numbers', 'create'), async (req, res) => {
  const { number, queueId } = req.body;
  if (!number) return res.status(400).json({ error: 'number is required' });
  const queueError = await checkQueue(queueId);
  if (queueError) return res.status(400).json({ error: queueError });
  // Upsert - reassigning an existing DID to a different queue is just
  // as valid a thing to do here as creating a brand new one.
  await pool.query(
    `INSERT INTO dids (tenant_id, number, queue_id) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE queue_id = VALUES(queue_id), campaign_id = NULL`,
    [number, queueId || null],
  );
  res.status(201).json({ number, queueId: queueId || null });
});

router.put('/admin/dids/:id', requirePermission('numbers', 'edit'), async (req, res) => {
  const { queueId } = req.body;
  const [rows] = await pool.query('SELECT id FROM dids WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'DID not found' });
  const queueError = await checkQueue(queueId);
  if (queueError) return res.status(400).json({ error: queueError });
  await pool.query('UPDATE dids SET queue_id = ?, campaign_id = NULL WHERE id = ?', [queueId || null, req.params.id]);
  res.json({ id: Number(req.params.id), queueId: queueId || null });
});

router.delete('/admin/dids/:id', requirePermission('numbers', 'delete'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM dids WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'DID not found' });
  res.json({ status: 'ok' });
});

module.exports = router;
