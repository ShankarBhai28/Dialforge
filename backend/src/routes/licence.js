const express = require('express');
const pool = require('../../db');
const ari = require('../../ari');
const { TRUNK_ENDPOINT } = require('../config');
const { requireAdminSide } = require('../middleware/auth');
const { getLicence, trunkCallsNow } = require('../services/licence');
const { agentsLoggedIn } = require('../services/singleLogin');

const router = express.Router();

// The client's licence, read-only (only the provider changes it, on the
// server): seats (agents logged in) and lines with what's in use now, and the end date.
router.get('/admin/licence', requireAdminSide, async (req, res) => {
  const lic = getLicence();
  const [[ext]] = await pool.query('SELECT COUNT(*) AS n FROM extensions WHERE deleted_at IS NULL');
  res.json({
    state: lic.state,
    customer: lic.customer || null,
    seats: lic.seats,
    seatsUsed: (await agentsLoggedIn()).size,
    extensions: Number(ext.n),
    channels: lic.channels,
    channelsInUse: await trunkCallsNow(ari, TRUNK_ENDPOINT).catch(() => null),
    expires: lic.expires,
    daysLeft: lic.daysLeft ?? null,
  });
});

module.exports = router;
