const express = require('express');
const pool = require('../../db');
const { requirePermission, requireAdminSide, requireAllScope } = require('../middleware/auth');
const { checkTeamRefs, parseTeam } = require('../services/teams');
const hub = require('../realtime/hub');

const router = express.Router();

// --- Admin: teams (a group of agents + the campaigns they may work) ---
// Members and campaigns come back as id arrays so the edit form can
// pre-tick its checkboxes, plus names for the table.
router.get('/admin/teams', requireAdminSide, async (req, res) => {
  const { scope } = req.access;
  const [teams] = scope
    ? await pool.query('SELECT * FROM teams WHERE id IN (?) ORDER BY id DESC', [
        scope.teamIds.length ? scope.teamIds : [-1],
      ])
    : await pool.query('SELECT * FROM teams ORDER BY id DESC');
  const [members] = await pool.query(
    'SELECT tm.team_id, u.id, u.username, u.role FROM team_members tm JOIN users u ON u.id = tm.user_id ORDER BY u.username',
  );
  const [campaigns] = await pool.query(
    'SELECT tc.team_id, c.id, c.name FROM team_campaigns tc JOIN campaigns c ON c.id = tc.campaign_id ORDER BY c.name',
  );
  res.json(
    teams.map((t) => ({
      ...t,
      members: members.filter((m) => m.team_id === t.id).map(({ id, username, role }) => ({ id, username, role })),
      campaigns: campaigns.filter((c) => c.team_id === t.id).map(({ id, name }) => ({ id, name })),
    })),
  );
});

const LINKS = [
  ['team_members', 'user_id', 'memberIds'],
  ['team_campaigns', 'campaign_id', 'campaignIds'],
];

// Create and edit both replace the full link sets inside one transaction,
// so a half-saved team (name changed, mappings not) can't happen.
async function saveTeam(teamId, team) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (teamId) {
      await conn.query('UPDATE teams SET name = ?, status = ? WHERE id = ?', [team.name, team.status, teamId]);
      for (const [table] of LINKS) await conn.query(`DELETE FROM ${table} WHERE team_id = ?`, [teamId]);
    } else {
      const [result] = await conn.query('INSERT INTO teams (tenant_id, name, status) VALUES (1, ?, ?)', [
        team.name,
        team.status,
      ]);
      teamId = result.insertId;
    }
    for (const [table, column, key] of LINKS) {
      if (!team[key].length) continue;
      await conn.query(`INSERT INTO ${table} (team_id, ${column}) VALUES ?`, [team[key].map((id) => [teamId, id])]);
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

/** Shared by create and edit: validate, check the ids, save, answer. */
async function handleSave(req, res, teamId) {
  const { error, team } = parseTeam(req.body);
  if (error) return res.status(400).json({ error });
  const refError = await checkTeamRefs(team);
  if (refError) return res.status(400).json({ error: refError });
  try {
    const id = await saveTeam(teamId, team);
    hub.refreshAccess(); // team-scoped live updates follow the new membership
    res.status(teamId ? 200 : 201).json({ id, name: team.name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'a team with that name already exists' });
    console.error('[team save failed]', err);
    res.status(500).json({ error: 'failed to save team' });
  }
}

router.post('/admin/teams', requirePermission('teams', 'manage'), requireAllScope('change teams'), (req, res) =>
  handleSave(req, res, null),
);

router.put(
  '/admin/teams/:id',
  requirePermission('teams', 'manage'),
  requireAllScope('change teams'),
  async (req, res) => {
    const [rows] = await pool.query('SELECT id FROM teams WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'team not found' });
    return handleSave(req, res, rows[0].id);
  },
);

// Deleting a team only removes the grouping (link rows cascade); no call
// or lead data references teams, so nothing needs to block it.
router.delete(
  '/admin/teams/:id',
  requirePermission('teams', 'manage'),
  requireAllScope('change teams'),
  async (req, res) => {
    const [rows] = await pool.query('SELECT id FROM teams WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'team not found' });
    await pool.query('DELETE FROM teams WHERE id = ?', [req.params.id]);
    hub.refreshAccess();
    res.json({ status: 'ok' });
  },
);

module.exports = router;
