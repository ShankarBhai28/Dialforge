const express = require('express');
const pool = require('../../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// --- Admin: teams (a group of agents + the campaigns they may work) ---
// Members and campaigns come back as id arrays so the edit form can
// pre-tick its checkboxes, plus names for the table.
router.get('/admin/teams', requireRole('admin'), async (req, res) => {
  const [teams] = await pool.query('SELECT * FROM teams ORDER BY id DESC');
  const [members] = await pool.query(
    'SELECT tm.team_id, u.id, u.username FROM team_members tm JOIN users u ON u.id = tm.user_id ORDER BY u.username',
  );
  const [campaigns] = await pool.query(
    'SELECT tc.team_id, c.id, c.name FROM team_campaigns tc JOIN campaigns c ON c.id = tc.campaign_id ORDER BY c.name',
  );
  res.json(
    teams.map((t) => ({
      ...t,
      members: members.filter((m) => m.team_id === t.id).map(({ id, username }) => ({ id, username })),
      campaigns: campaigns.filter((c) => c.team_id === t.id).map(({ id, name }) => ({ id, name })),
    })),
  );
});

// Create and edit both replace the full member/campaign sets inside one
// transaction, so a half-saved team (name changed, mappings not) can't happen.
async function saveTeam(teamId, { name, status, memberIds, campaignIds }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (teamId) {
      await conn.query('UPDATE teams SET name = ?, status = ? WHERE id = ?', [name, status || 'active', teamId]);
      await conn.query('DELETE FROM team_members WHERE team_id = ?', [teamId]);
      await conn.query('DELETE FROM team_campaigns WHERE team_id = ?', [teamId]);
    } else {
      const [result] = await conn.query('INSERT INTO teams (tenant_id, name, status) VALUES (1, ?, ?)', [
        name,
        status || 'active',
      ]);
      teamId = result.insertId;
    }
    for (const userId of memberIds || []) {
      await conn.query('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [teamId, userId]);
    }
    for (const campaignId of campaignIds || []) {
      await conn.query('INSERT INTO team_campaigns (team_id, campaign_id) VALUES (?, ?)', [teamId, campaignId]);
    }
    await conn.commit();
    return teamId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

router.post('/admin/teams', requireRole('admin'), async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name is required' });
  try {
    const id = await saveTeam(null, req.body);
    res.status(201).json({ id, name: req.body.name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'a team with that name already exists' });
    console.error('[team save failed]', err);
    res.status(500).json({ error: 'failed to save team' });
  }
});

router.put('/admin/teams/:id', requireRole('admin'), async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name is required' });
  const [rows] = await pool.query('SELECT id FROM teams WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'team not found' });
  try {
    await saveTeam(Number(req.params.id), req.body);
    res.json({ id: Number(req.params.id), name: req.body.name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'a team with that name already exists' });
    console.error('[team save failed]', err);
    res.status(500).json({ error: 'failed to save team' });
  }
});

// Deleting a team only removes the grouping (link rows cascade); no call
// or lead data references teams, so nothing needs to block it.
router.delete('/admin/teams/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM teams WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'team not found' });
  await pool.query('DELETE FROM teams WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

module.exports = router;
