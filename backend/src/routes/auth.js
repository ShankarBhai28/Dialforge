const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db');
const { closeOpenStatus, syncQueueMembership } = require('../services/agents');
const { releasePreviewLocks } = require('../services/preview');

const router = express.Router();

// --- Auth ---
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const [rows] = await pool.query(
    `SELECT users.*, extensions.name AS extension_name
     FROM users LEFT JOIN extensions ON users.extension_id = extensions.id
     WHERE username = ?`,
    [username],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'invalid username or password' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    extensionId: user.extension_id,
    extensionName: user.extension_name,
  };

  // No auto-Available here anymore - an agent must pick a queue first
  // (enforced client-side via a popup, and server-side below).
  res.json({ status: 'ok', user: req.session.user });
});

router.post('/auth/logout', async (req, res) => {
  if (req.session.user && req.session.user.role === 'agent') {
    await releasePreviewLocks(req.session.user.id, null);
    await closeOpenStatus(req.session.user.id);
    await syncQueueMembership(req.session.user.id, req.session.user.extensionName, 'offline', null);
  }
  req.session.destroy(() => res.json({ status: 'ok' }));
});

router.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  res.json(req.session.user);
});

module.exports = router;
