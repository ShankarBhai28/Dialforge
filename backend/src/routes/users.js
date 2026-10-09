const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// --- Admin: manage user accounts ---
router.get('/admin/users', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT users.id, users.username, users.role, users.created_at, extensions.name AS extension_name
     FROM users LEFT JOIN extensions ON users.extension_id = extensions.id
     ORDER BY users.id`,
  );
  res.json(rows);
});

router.post('/admin/users', requireRole('admin'), async (req, res) => {
  const { username, password, role, extensionId } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, and role are required' });
  }
  if (role === 'agent' && !extensionId) {
    return res.status(400).json({ error: 'agent accounts must be linked to an extension' });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.query(
      'INSERT INTO users (tenant_id, username, password_hash, role, extension_id) VALUES (1, ?, ?, ?, ?)',
      [username, hash, role, role === 'agent' ? extensionId : null],
    );
    res.status(201).json({ id: result.insertId, username, role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'that username is already taken' });
    }
    throw err;
  }
});

router.get('/admin/extensions', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM extensions ORDER BY id');
  res.json(rows);
});

module.exports = router;
