const express = require('express');
const fs = require('fs');
const pool = require('../../db');
const ami = require('../../ami');
const { QUEUES_CONF_PATH } = require('../config');
const { requirePermission, requireAdminSide } = require('../middleware/auth');
const { QUEUE_DEFAULTS, parseQueueSettings, queueStanzaRegex, slugify } = require('../services/queueConfig');

const router = express.Router();

// --- Admin: standalone queue management (reusable across campaigns) ---
router.get('/admin/queues', requireAdminSide, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM queues ORDER BY id DESC');
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

  const [existing] = await pool.query('SELECT id FROM queues WHERE asterisk_name = ?', [asteriskName]);
  if (existing[0]) {
    return res.status(409).json({ error: 'a queue with a matching name already exists' });
  }

  const [result] = await pool.query(
    `INSERT INTO queues (tenant_id, name, asterisk_name, ring_strategy, wait_timeout, announce, retry, timeout_restart)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    [name, asteriskName, ringStrategy, waitTimeout, announce, retry, timeoutRestart],
  );

  // Make it real in Asterisk, not just a database row - this is what
  // makes "queue show" list it and lets agents actually join it.
  const announceFrequency = announce === 'yes' ? 30 : 0;
  const stanza = `\n[${asteriskName}]\nstrategy = ${ringStrategy}\ntimeout = ${waitTimeout}\nretry = ${retry}\ntimeoutrestart = ${timeoutRestart}\nannounce-frequency = ${announceFrequency}\nringinuse = no\n`;
  try {
    fs.appendFileSync(QUEUES_CONF_PATH, stanza);
    await ami.queueReload();
  } catch (err) {
    console.error('[Queue config write/reload failed]', err.message);
    return res.status(500).json({ error: 'queue saved but Asterisk could not be updated: ' + err.message });
  }

  res.status(201).json({ id: result.insertId, name, asteriskName });
});

router.put('/admin/queues/:id', requirePermission('queues', 'edit'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM queues WHERE id = ?', [req.params.id]);
  const queue = rows[0];
  if (!queue) return res.status(404).json({ error: 'queue not found' });

  // Name/asterisk_name is intentionally not editable here - renaming
  // would require touching every campaign and queues.conf stanza header
  // that already points at it, not worth it for a ring-behavior change.
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

  const announceFrequency = updated.announce === 'yes' ? 30 : 0;
  const newStanza = `[${queue.asterisk_name}]\nstrategy = ${updated.ringStrategy}\ntimeout = ${updated.waitTimeout}\nretry = ${updated.retry}\ntimeoutrestart = ${updated.timeoutRestart}\nannounce-frequency = ${announceFrequency}\nringinuse = no\n`;
  try {
    const content = fs.readFileSync(QUEUES_CONF_PATH, 'utf-8');
    const re = queueStanzaRegex(queue.asterisk_name);
    const match = content.match(re);
    if (!match) throw new Error(`stanza [${queue.asterisk_name}] not found in queues.conf`);
    const leadingNewline = match[0].startsWith('\n') ? '\n' : '';
    fs.writeFileSync(QUEUES_CONF_PATH, content.replace(re, leadingNewline + newStanza));
    await ami.queueReload();
  } catch (err) {
    console.error('[Queue config update failed]', err.message);
    return res.status(500).json({ error: 'queue saved but Asterisk could not be updated: ' + err.message });
  }

  res.json({ id: Number(req.params.id), ...updated });
});

router.delete('/admin/queues/:id', requirePermission('queues', 'delete'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM queues WHERE id = ?', [req.params.id]);
  const queue = rows[0];
  if (!queue) return res.status(404).json({ error: 'queue not found' });

  const [campaignRefs] = await pool.query('SELECT name FROM campaigns WHERE queue_id = ?', [req.params.id]);
  if (campaignRefs.length) {
    return res.status(409).json({
      error: `Cannot delete - still used by campaign(s): ${campaignRefs.map((c) => c.name).join(', ')}. Reassign or delete them first.`,
    });
  }

  // agent_status_log.queue_id also FKs to queues - any agent who ever
  // logged into this queue leaves a historical row here, so a queue with
  // real usage history is never actually deletable. That's correct (don't
  // lose history), but it needs the same clear-error treatment as the
  // campaign check above instead of surfacing as a raw FK error.
  const [statusLogRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM agent_status_log WHERE queue_id = ?', [
    req.params.id,
  ]);
  if (statusLogRefs[0].cnt > 0) {
    return res.status(409).json({
      error: `Cannot delete - ${statusLogRefs[0].cnt} historical agent status record(s) reference this queue.`,
    });
  }

  await pool.query('DELETE FROM queues WHERE id = ?', [req.params.id]);

  try {
    const content = fs.readFileSync(QUEUES_CONF_PATH, 'utf-8');
    const re = queueStanzaRegex(queue.asterisk_name);
    fs.writeFileSync(QUEUES_CONF_PATH, content.replace(re, ''));
    await ami.queueReload();
  } catch (err) {
    console.error('[Queue config removal failed]', err.message);
    return res
      .status(500)
      .json({ error: 'queue deleted from DB but Asterisk config could not be updated: ' + err.message });
  }

  res.json({ status: 'ok' });
});

module.exports = router;
