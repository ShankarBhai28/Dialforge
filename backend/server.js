require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('./db');
const ari = require('./ari');
const ami = require('./ami');

// Fail loudly at startup, not with a confusing runtime error the first
// time something tries to use a missing secret - a fresh deploy that
// forgot to fill in .env should never limp along silently.
const REQUIRED_ENV_VARS = ['DB_PASSWORD', 'ARI_PASS', 'AMI_PASS', 'SESSION_SECRET'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variable(s): ${missingEnvVars.join(', ')}. Copy .env.example to .env and fill in real values.`);
  process.exit(1);
}

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Hand-rolled, not another dependency - correctly handles quoted fields
// with embedded commas/escaped quotes, which is the actual tricky part
// of CSV parsing (doesn't handle embedded newlines inside a quoted
// field, an acceptable gap for a name/phone lead list).
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result.map((s) => s.trim());
}

const QUEUES_CONF_PATH = process.env.QUEUES_CONF_PATH || '/etc/asterisk/queues.conf';

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Safety net: an uncaught error in any async route handler otherwise
// crashes the entire process (Node terminates on unhandled rejections
// by default) - log it instead of taking down every agent's call.
process.on('unhandledRejection', (err) => {
  console.error('[Unhandled rejection - not crashing]', err);
});

const APP_NAME = 'dialforge-app';
// Live SIP trunk to nxtra (Tata Communications PSTN), set up in Phase 2.
// Real destination numbers route through this; our own test extensions
// (1001/1002) still dial directly, no trunk involved. Deployment-specific
// (a different server may use a different trunk provider), so it's an
// env var rather than a hardcoded constant, even though it's not a secret.
const TRUNK_ENDPOINT = process.env.TRUNK_ENDPOINT || 'dialforge-nxtra1';
const TRUNK_CALLER_ID = process.env.TRUNK_CALLER_ID || '8065098690'; // DID authorized on the trunk account for outbound CLI
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000, secure: true }, // 8 hour login, HTTPS-only cookie
  })
);

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    if (req.session.user.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// In-memory tracking of in-progress click-to-call attempts, keyed by our
// own call id (the calls.id row). Not persisted - if the backend restarts
// mid-call, this state is lost, but the DB row/event trail still exists.
const activeCalls = new Map();

// Correlates a native-queue call back to our own calls.id row: AMI's
// queue events identify channels by Asterisk's own channel name, not our
// database id, so this maps one to the other for the lifetime of the call.
const queueCallChannels = new Map();

// Decides how to dial a destination: straight to one of our own test
// extensions if it matches one, otherwise out through the live trunk -
// using the calling campaign's own CLI if it has one set, falling back
// to the global default otherwise.
async function resolveDestination(toNumber, campaignCallerId) {
  const [rows] = await pool.query('SELECT 1 FROM extensions WHERE name = ? LIMIT 1', [toNumber]);
  if (rows.length > 0) {
    return { endpoint: `PJSIP/${toNumber}`, callerId: null };
  }
  return { endpoint: `PJSIP/${toNumber}@${TRUNK_ENDPOINT}`, callerId: campaignCallerId || TRUNK_CALLER_ID };
}

async function logEvent(callId, eventType, payload) {
  await pool.query(
    'INSERT INTO call_events (call_id, event_type, payload) VALUES (?, ?, ?)',
    [callId, eventType, payload ? JSON.stringify(payload) : null]
  );
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- Auth ---
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const [rows] = await pool.query(
    `SELECT users.*, extensions.name AS extension_name
     FROM users LEFT JOIN extensions ON users.extension_id = extensions.id
     WHERE username = ?`,
    [username]
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

app.post('/auth/logout', async (req, res) => {
  if (req.session.user && req.session.user.role === 'agent') {
    await closeOpenStatus(req.session.user.id);
    await syncQueueMembership(req.session.user.id, req.session.user.extensionName, 'offline', null);
  }
  req.session.destroy(() => res.json({ status: 'ok' }));
});

app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  res.json(req.session.user);
});

// --- Agent status tracking (available / break / acw) ---
async function closeOpenStatus(userId) {
  await pool.query(
    'UPDATE agent_status_log SET ended_at = NOW() WHERE user_id = ? AND ended_at IS NULL',
    [userId]
  );
}

// Which queue is this agent nominally working this session? (the most
// recent status row that had one set, regardless of current status) -
// needed so break/acw/logout know which real Asterisk queue to pause or
// remove them from without every caller having to track it separately.
async function findCurrentQueueAsteriskName(userId) {
  const [rows] = await pool.query(
    'SELECT queue_id FROM agent_status_log WHERE user_id = ? AND queue_id IS NOT NULL ORDER BY id DESC LIMIT 1',
    [userId]
  );
  if (!rows[0]) return null;
  const [queueRows] = await pool.query('SELECT asterisk_name FROM queues WHERE id = ?', [rows[0].queue_id]);
  return queueRows[0] ? queueRows[0].asterisk_name : null;
}

// The full campaign row for whichever queue this agent is currently
// working - same underlying lookup as above, one hop further, used
// anywhere a feature depends on "which campaign is this agent in right
// now" (leads scoping, outbound CLI selection).
async function findCurrentCampaign(userId) {
  const asteriskName = await findCurrentQueueAsteriskName(userId);
  if (!asteriskName) return null;
  const [rows] = await pool.query(
    `SELECT c.* FROM campaigns c JOIN queues q ON q.id = c.queue_id WHERE q.asterisk_name = ? LIMIT 1`,
    [asteriskName]
  );
  return rows[0] || null;
}

// Keeps real Asterisk queue membership in sync with our own status
// tracking via AMI - this is what makes "queue show" reflect what an
// agent is actually doing, instead of a label that only lives in our DB.
async function syncQueueMembership(userId, extensionName, newStatus, explicitQueueId) {
  if (!extensionName) return;
  let asteriskName;
  if (explicitQueueId) {
    const [rows] = await pool.query('SELECT asterisk_name FROM queues WHERE id = ?', [explicitQueueId]);
    asteriskName = rows[0] ? rows[0].asterisk_name : null;
  } else {
    asteriskName = await findCurrentQueueAsteriskName(userId);
  }
  if (!asteriskName) return;

  const iface = `PJSIP/${extensionName}`;
  try {
    if (newStatus === 'available') {
      await ami.queueAdd(asteriskName, iface).catch(() => {}); // already a member - fine
      await ami.queuePause(asteriskName, iface, false);
    } else if (newStatus === 'break' || newStatus === 'acw') {
      await ami.queuePause(asteriskName, iface, true);
    } else if (newStatus === 'offline') {
      await ami.queueRemove(asteriskName, iface);
    }
  } catch (err) {
    console.error('[AMI queue sync failed]', err.message);
  }
}

async function setAgentStatus(userId, status, reason, queueId, extensionName) {
  await closeOpenStatus(userId);
  await pool.query(
    'INSERT INTO agent_status_log (user_id, status, reason, queue_id, extension_name) VALUES (?, ?, ?, ?, ?)',
    [userId, status, reason || null, queueId || null, extensionName || null]
  );
  await syncQueueMembership(userId, extensionName, status, queueId);
}

// Who is ACTUALLY on this extension right now? Not the same as asking
// which login account has it as their assigned extension - an agent can
// connect with a different one (a per-shift device choice), so the only
// reliable source of truth is their most recent status row that recorded
// this extension_name.
async function findAgentIdByExtension(extensionName) {
  const [rows] = await pool.query(
    'SELECT user_id FROM agent_status_log WHERE extension_name = ? ORDER BY id DESC LIMIT 1',
    [extensionName]
  );
  return rows[0] ? rows[0].user_id : null;
}

app.post('/agent/status', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const { status, reason, queueId } = req.body;
  if (!['available', 'break', 'acw'].includes(status)) {
    return res.status(400).json({ error: 'status must be available, break, or acw' });
  }
  if (status === 'available' && !queueId) {
    return res.status(400).json({ error: 'a queue must be selected to go Available' });
  }
  await setAgentStatus(
    req.session.user.id,
    status,
    status === 'break' ? reason : null,
    queueId,
    req.session.user.extensionName
  );
  res.json({ status: 'ok' });
});

// --- Agent: does the call currently ringing them auto-answer, or should
// the browser show a real Accept/Reject popup? Set per-campaign by admin.
// Resolved from the agent's *current queue*, not by matching a specific
// calls row - auto_answer is a property of the campaign/queue, the same
// for whoever answers, so this needs no correlation to a particular call
// and can't race against AMI events telling us who picked up.
app.get('/agent/call-policy', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const asteriskName = await findCurrentQueueAsteriskName(req.session.user.id);
  if (!asteriskName) return res.json({ autoAnswer: false });
  const [rows] = await pool.query(
    `SELECT c.auto_answer FROM campaigns c JOIN queues q ON q.id = c.queue_id
     WHERE q.asterisk_name = ? LIMIT 1`,
    [asteriskName]
  );
  res.json({ autoAnswer: rows[0] ? !!rows[0].auto_answer : false });
});

// --- Queues (agent-visible list for the "pick a queue" popup) ---
// A queue only shows up here once some active campaign actually
// references it - an unassigned queue has no campaign context for an
// agent to be working under.
app.get('/queues', requireAuth, async (req, res) => {
  const [rows] = await pool.query(`
    SELECT q.id, q.name, c.name AS campaign_name
    FROM queues q
    JOIN campaigns c ON c.queue_id = q.id
    WHERE q.status = 'active' AND c.status = 'active'
    ORDER BY c.name, q.name
  `);
  res.json(rows);
});

// --- Admin: standalone queue management (reusable across campaigns) ---
app.get('/admin/queues', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM queues ORDER BY id DESC');
  res.json(rows);
});

app.post('/admin/queues', requireRole('admin'), async (req, res) => {
  const { name, ringStrategy, waitTimeout, announce, retry, timeoutRestart } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const asteriskName = slugify(name);
  if (!asteriskName) return res.status(400).json({ error: 'name must contain at least one letter or digit' });

  const [existing] = await pool.query('SELECT id FROM queues WHERE asterisk_name = ?', [asteriskName]);
  if (existing[0]) {
    return res.status(409).json({ error: 'a queue with a matching name already exists' });
  }

  const [result] = await pool.query(
    `INSERT INTO queues (tenant_id, name, asterisk_name, ring_strategy, wait_timeout, announce, retry, timeout_restart)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    [name, asteriskName, ringStrategy || 'ringall', waitTimeout || 30, announce || 'no', retry || 1, timeoutRestart || 'yes']
  );

  // Make it real in Asterisk, not just a database row - this is what
  // makes "queue show" list it and lets agents actually join it.
  const announceFrequency = announce === 'yes' ? 30 : 0;
  const stanza = `\n[${asteriskName}]\nstrategy = ${ringStrategy || 'ringall'}\ntimeout = ${waitTimeout || 30}\nretry = ${retry || 1}\ntimeoutrestart = ${timeoutRestart || 'yes'}\nannounce-frequency = ${announceFrequency}\n`;
  try {
    fs.appendFileSync(QUEUES_CONF_PATH, stanza);
    await ami.queueReload();
  } catch (err) {
    console.error('[Queue config write/reload failed]', err.message);
    return res.status(500).json({ error: 'queue saved but Asterisk could not be updated: ' + err.message });
  }

  res.status(201).json({ id: result.insertId, name, asteriskName });
});

// Ring-behavior fields live in a 6-line stanza in queues.conf, written
// without any brackets in the body - this regex relies on that to find
// exactly one stanza and nothing past the next queue's `[name]` line.
// Safe to build directly from asterisk_name since slugify() only ever
// produces [a-z0-9_], never a regex metacharacter.
function queueStanzaRegex(asteriskName) {
  return new RegExp(
    `\\n?\\[${asteriskName}\\]\\nstrategy = [^\\n]*\\ntimeout = [^\\n]*\\nretry = [^\\n]*\\ntimeoutrestart = [^\\n]*\\nannounce-frequency = [^\\n]*\\n`
  );
}

app.put('/admin/queues/:id', requireRole('admin'), async (req, res) => {
  const { ringStrategy, waitTimeout, announce, retry, timeoutRestart } = req.body;
  const [rows] = await pool.query('SELECT * FROM queues WHERE id = ?', [req.params.id]);
  const queue = rows[0];
  if (!queue) return res.status(404).json({ error: 'queue not found' });

  // Name/asterisk_name is intentionally not editable here - renaming
  // would require touching every campaign and queues.conf stanza header
  // that already points at it, not worth it for a ring-behavior change.
  const updated = {
    ringStrategy: ringStrategy || queue.ring_strategy,
    waitTimeout: waitTimeout || queue.wait_timeout,
    announce: announce || queue.announce,
    retry: retry || queue.retry,
    timeoutRestart: timeoutRestart || queue.timeout_restart,
  };

  await pool.query(
    'UPDATE queues SET ring_strategy = ?, wait_timeout = ?, announce = ?, retry = ?, timeout_restart = ? WHERE id = ?',
    [updated.ringStrategy, updated.waitTimeout, updated.announce, updated.retry, updated.timeoutRestart, req.params.id]
  );

  const announceFrequency = updated.announce === 'yes' ? 30 : 0;
  const newStanza = `[${queue.asterisk_name}]\nstrategy = ${updated.ringStrategy}\ntimeout = ${updated.waitTimeout}\nretry = ${updated.retry}\ntimeoutrestart = ${updated.timeoutRestart}\nannounce-frequency = ${announceFrequency}\n`;
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

app.delete('/admin/queues/:id', requireRole('admin'), async (req, res) => {
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
  const [statusLogRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM agent_status_log WHERE queue_id = ?', [req.params.id]);
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
    return res.status(500).json({ error: 'queue deleted from DB but Asterisk config could not be updated: ' + err.message });
  }

  res.json({ status: 'ok' });
});

// --- Admin: campaigns (each references one queue) ---
app.get('/admin/campaigns', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT c.*, q.name AS queue_name, q.ring_strategy, q.wait_timeout
    FROM campaigns c
    LEFT JOIN queues q ON q.id = c.queue_id
    ORDER BY c.id DESC
  `);
  res.json(rows);
});

app.post('/admin/campaigns', requireRole('admin'), async (req, res) => {
  const { name, queueId, outboundCallerId, autoAnswer } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const [result] = await pool.query(
    'INSERT INTO campaigns (tenant_id, name, queue_id, outbound_caller_id, auto_answer) VALUES (1, ?, ?, ?, ?)',
    [name, queueId || null, outboundCallerId || null, autoAnswer ? 1 : 0]
  );
  res.status(201).json({ id: result.insertId, name });
});

app.put('/admin/campaigns/:id', requireRole('admin'), async (req, res) => {
  const { name, queueId, outboundCallerId, autoAnswer, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'campaign not found' });

  await pool.query(
    'UPDATE campaigns SET name = ?, queue_id = ?, outbound_caller_id = ?, auto_answer = ?, status = ? WHERE id = ?',
    [name, queueId || null, outboundCallerId || null, autoAnswer ? 1 : 0, status || 'active', req.params.id]
  );
  res.json({ id: Number(req.params.id), name });
});

app.delete('/admin/campaigns/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'campaign not found' });

  // Checked explicitly (rather than relying on the raw FK error) so the
  // message can actually say what's in the way, not just "a constraint
  // failed" - the whole point of the "block with a clear error" choice.
  const [didRefs] = await pool.query('SELECT number FROM dids WHERE campaign_id = ?', [req.params.id]);
  const [leadRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM leads WHERE campaign_id = ?', [req.params.id]);
  const [callRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM calls WHERE campaign_id = ?', [req.params.id]);

  const blockers = [];
  if (didRefs.length) blockers.push(`${didRefs.length} DID number(s) (${didRefs.map((d) => d.number).join(', ')})`);
  if (leadRefs[0].cnt > 0) blockers.push(`${leadRefs[0].cnt} lead(s)`);
  if (callRefs[0].cnt > 0) blockers.push(`${callRefs[0].cnt} call record(s)`);
  if (blockers.length) {
    return res.status(409).json({ error: `Cannot delete - still referenced by ${blockers.join(' and ')}. Reassign or remove them first.` });
  }

  await pool.query('DELETE FROM campaigns WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

// --- Admin: DID numbers, mapped to a campaign (this is what makes
// inbound routing actually DID-aware instead of guessing) ---
app.get('/admin/dids', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT d.id, d.number, d.campaign_id, c.name AS campaign_name
    FROM dids d
    LEFT JOIN campaigns c ON c.id = d.campaign_id
    ORDER BY d.id DESC
  `);
  res.json(rows);
});

app.post('/admin/dids', requireRole('admin'), async (req, res) => {
  const { number, campaignId } = req.body;
  if (!number) return res.status(400).json({ error: 'number is required' });
  // Upsert - reassigning an existing DID to a different campaign is just
  // as valid a thing to do here as creating a brand new one.
  await pool.query(
    `INSERT INTO dids (tenant_id, number, campaign_id) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE campaign_id = VALUES(campaign_id)`,
    [number, campaignId || null]
  );
  res.status(201).json({ number, campaignId: campaignId || null });
});

app.put('/admin/dids/:id', requireRole('admin'), async (req, res) => {
  const { campaignId } = req.body;
  const [rows] = await pool.query('SELECT id FROM dids WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'DID not found' });
  await pool.query('UPDATE dids SET campaign_id = ? WHERE id = ?', [campaignId || null, req.params.id]);
  res.json({ id: Number(req.params.id), campaignId: campaignId || null });
});

app.delete('/admin/dids/:id', requireRole('admin'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM dids WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'DID not found' });
  res.json({ status: 'ok' });
});

// --- Admin: named lead lists within a campaign - a CSV import always
// targets one of these (a batch), not the campaign's flat lead pool
// directly, so admins can tell "Jan cold list" apart from "referrals". ---
app.get('/admin/lists', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT ls.*, c.name AS campaign_name,
      (SELECT COUNT(*) FROM leads WHERE leads.list_id = ls.id) AS lead_count
    FROM lists ls
    LEFT JOIN campaigns c ON c.id = ls.campaign_id
    ORDER BY ls.id DESC
  `);
  res.json(rows);
});

app.post('/admin/lists', requireRole('admin'), async (req, res) => {
  const { name, campaignId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const [result] = await pool.query(
    'INSERT INTO lists (tenant_id, campaign_id, name) VALUES (1, ?, ?)',
    [campaignId, name]
  );
  res.status(201).json({ id: result.insertId, name, campaignId });
});

app.put('/admin/lists/:id', requireRole('admin'), async (req, res) => {
  const { name, campaignId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const [rows] = await pool.query('SELECT id FROM lists WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'list not found' });
  await pool.query('UPDATE lists SET name = ?, campaign_id = ? WHERE id = ?', [name, campaignId, req.params.id]);
  res.json({ id: Number(req.params.id), name, campaignId });
});

app.delete('/admin/lists/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM lists WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'list not found' });
  const [leadRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM leads WHERE list_id = ?', [req.params.id]);
  if (leadRefs[0].cnt > 0) {
    return res.status(409).json({ error: `Cannot delete - ${leadRefs[0].cnt} lead(s) still belong to this list. Reassign or remove them first.` });
  }
  await pool.query('DELETE FROM lists WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

app.get('/agent/stats', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const userId = req.session.user.id;

  // Login time: from the first status row logged today until now.
  const [loginRows] = await pool.query(
    `SELECT MIN(started_at) AS first_login FROM agent_status_log
     WHERE user_id = ? AND DATE(started_at) = CURDATE()`,
    [userId]
  );
  const loginSeconds = loginRows[0].first_login
    ? Math.floor((Date.now() - new Date(loginRows[0].first_login).getTime()) / 1000)
    : 0;

  async function sumSecondsForStatus(status) {
    const [rows] = await pool.query(
      `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, NOW()))), 0) AS secs
       FROM agent_status_log
       WHERE user_id = ? AND status = ? AND DATE(started_at) = CURDATE()`,
      [userId, status]
    );
    // MySQL returns SUM()/COALESCE() results as strings via mysql2, not numbers.
    return Number(rows[0].secs);
  }

  const breakSeconds = await sumSecondsForStatus('break');
  const acwSeconds = await sumSecondsForStatus('acw');

  const [talkRows] = await pool.query(
    `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, answer_time, COALESCE(end_time, NOW()))), 0) AS secs
     FROM calls
     WHERE from_extension = ? AND answer_time IS NOT NULL AND DATE(start_time) = CURDATE()`,
    [req.session.user.extensionName]
  );
  const talkSeconds = Number(talkRows[0].secs);

  // The agent's real current status can change server-side (e.g. the
  // automatic ACW transition after a call ends) without the browser ever
  // being told - without this, the status pill goes stale and silently
  // disagrees with reality (shows "Available" while actually paused in
  // the real queue). Piggybacking on the stats poll keeps it in sync.
  const [currentRows] = await pool.query(
    `SELECT asl.status, asl.reason, q.name AS queue_name
     FROM agent_status_log asl
     LEFT JOIN queues q ON q.id = asl.queue_id
     WHERE asl.user_id = ? AND asl.ended_at IS NULL
     ORDER BY asl.id DESC LIMIT 1`,
    [userId]
  );
  const current = currentRows[0] || null;

  res.json({
    loginSeconds,
    talkSeconds,
    breakSeconds,
    acwSeconds,
    handleSeconds: talkSeconds + acwSeconds,
    currentStatus: current ? current.status : null,
    currentReason: current ? current.reason : null,
    currentQueueName: current ? current.queue_name : null,
  });
});

// --- Agent: SIP credentials for the browser to register a WebRTC line ---
// The extension an agent connects with is a per-session device choice
// (like picking a desk phone for a shift), not tied to their login account.
app.get('/agent/extension-credentials/:extension', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, name, sip_password FROM extensions WHERE name = ?',
    [req.params.extension]
  );
  if (!rows[0] || !rows[0].sip_password) {
    return res.status(404).json({ error: 'unknown extension' });
  }
  // This is the moment the agent commits to an extension for this session -
  // everything downstream (queue membership, click2call's fromExtension,
  // stats, live-agents display) reads this session field, so it must match
  // what they actually registered in the browser, not their login-assigned
  // extension (those two can differ - picking a device is a per-shift choice).
  req.session.user.extensionName = rows[0].name;
  req.session.user.extensionId = rows[0].id;
  res.json({ extension: rows[0].name, sipPassword: rows[0].sip_password });
});

// --- Leads (campaign-scoped for agents - admins see everything) ---
app.get('/leads', requireAuth, async (req, res) => {
  if (req.session.user.role === 'admin') {
    const [rows] = await pool.query(`
      SELECT l.*, c.name AS campaign_name, ls.name AS list_name
      FROM leads l
      LEFT JOIN campaigns c ON c.id = l.campaign_id
      LEFT JOIN lists ls ON ls.id = l.list_id
      ORDER BY l.id DESC LIMIT 200
    `);
    return res.json(rows);
  }
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign) return res.json([]);
  const [rows] = await pool.query(
    'SELECT * FROM leads WHERE campaign_id = ? ORDER BY id DESC LIMIT 100',
    [campaign.id]
  );
  res.json(rows);
});

app.post('/leads', requireAuth, async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  let campaignId = null;
  if (req.session.user.role === 'agent') {
    const campaign = await findCurrentCampaign(req.session.user.id);
    campaignId = campaign ? campaign.id : null;
  }
  const [result] = await pool.query(
    'INSERT INTO leads (tenant_id, phone, name, campaign_id) VALUES (1, ?, ?, ?)',
    [phone, name || null, campaignId]
  );
  const [rows] = await pool.query('SELECT * FROM leads WHERE id = ?', [result.insertId]);
  res.status(201).json(rows[0]);
});

// --- Lead disposition: the actual outcome of an outbound call, set by
// the agent right after it ends. "do_not_call" is enforced below, not
// just a label - click2call refuses to dial a lead marked this way.
const LEAD_STATUSES = ['new', 'interested', 'not_interested', 'callback', 'no_answer', 'do_not_call'];
app.post('/leads/:id/disposition', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
  }
  await pool.query('UPDATE leads SET status = ?, updated_by = ? WHERE id = ?', [
    status,
    req.session.user.id,
    req.params.id,
  ]);
  res.json({ status: 'ok' });
});

// --- Admin: full lead edit/delete (distinct from the agent-facing
// disposition endpoint above, which only ever touches status) ---
app.put('/admin/leads/:id', requireRole('admin'), async (req, res) => {
  const { name, phone, campaignId, listId, status } = req.body;
  if (!phone || !/^\+?[0-9]{7,15}$/.test(phone)) {
    return res.status(400).json({ error: 'a valid phone is required' });
  }
  if (status && !LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
  }
  const [rows] = await pool.query('SELECT id FROM leads WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'lead not found' });

  await pool.query(
    'UPDATE leads SET name = ?, phone = ?, campaign_id = ?, list_id = ?, status = COALESCE(?, status), updated_by = ? WHERE id = ?',
    [name || null, phone, campaignId || null, listId || null, status || null, req.session.user.id, req.params.id]
  );
  res.json({ status: 'ok' });
});

app.delete('/admin/leads/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM leads WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'lead not found' });

  const [callRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM calls WHERE lead_id = ?', [req.params.id]);
  if (callRefs[0].cnt > 0) {
    return res.status(409).json({ error: `Cannot delete - ${callRefs[0].cnt} call record(s) reference this lead.` });
  }

  await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

// --- Admin: CSV lead import, assigned to a specific campaign ---
app.get('/admin/leads/csv-template', requireRole('admin'), (req, res) => {
  const csv = 'name,phone\nJohn Doe,9000000001\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads-template.csv"');
  res.send(csv);
});

app.post('/admin/leads/import', requireRole('admin'), csvUpload.single('file'), async (req, res) => {
  const { listId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
  if (!listId) return res.status(400).json({ error: 'listId is required - create a list first' });

  const [listRows] = await pool.query('SELECT * FROM lists WHERE id = ?', [listId]);
  const list = listRows[0];
  if (!list) return res.status(400).json({ error: 'list not found' });
  const campaignId = list.campaign_id;

  const text = req.file.buffer.toString('utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const phoneIdx = headers.indexOf('phone');
  const nameIdx = headers.indexOf('name');
  if (phoneIdx === -1) return res.status(400).json({ error: 'CSV must have a "phone" column' });

  const [existingRows] = await pool.query('SELECT phone FROM leads WHERE campaign_id = ?', [campaignId]);
  const existingPhones = new Set(existingRows.map((r) => r.phone));
  const seenInFile = new Set();

  let imported = 0;
  let duplicates = 0;
  let invalid = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const phone = cols[phoneIdx];
    const name = nameIdx !== -1 ? cols[nameIdx] : null;

    if (!phone || !/^\+?[0-9]{7,15}$/.test(phone)) {
      invalid++;
      continue;
    }
    if (existingPhones.has(phone) || seenInFile.has(phone)) {
      duplicates++;
      continue;
    }
    seenInFile.add(phone);
    await pool.query(
      'INSERT INTO leads (tenant_id, phone, name, campaign_id, list_id) VALUES (1, ?, ?, ?, ?)',
      [phone, name || null, campaignId, listId]
    );
    imported++;
  }

  res.json({ imported, duplicates, invalid, total: lines.length - 1 });
});

// --- Calls (admin sees everything, agent sees only their own extension's calls) ---
app.get('/calls', requireAuth, async (req, res) => {
  if (req.session.user.role === 'admin') {
    const [rows] = await pool.query('SELECT * FROM calls ORDER BY id DESC LIMIT 100');
    return res.json(rows);
  }
  const [rows] = await pool.query(
    'SELECT * FROM calls WHERE from_extension = ? ORDER BY id DESC LIMIT 100',
    [req.session.user.extensionName]
  );
  res.json(rows);
});

app.post('/calls/click2call', requireAuth, async (req, res) => {
  const { toNumber, leadId } = req.body;
  // Agents can only ever call from their own assigned extension - never
  // trust a client-supplied fromExtension for that role. Admins (who have
  // no extension of their own) may still specify one for testing.
  const fromExtension =
    req.session.user.role === 'agent' ? req.session.user.extensionName : req.body.fromExtension;

  if (!fromExtension || !toNumber) {
    return res.status(400).json({ error: 'fromExtension and toNumber are required' });
  }

  // Do Not Call is enforced here, not just a label an agent can override -
  // real compliance behavior, not cosmetic.
  if (leadId) {
    const [leadRows] = await pool.query('SELECT status FROM leads WHERE id = ?', [leadId]);
    if (leadRows[0] && leadRows[0].status === 'do_not_call') {
      return res.status(403).json({ error: 'this lead is marked Do Not Call' });
    }
  }

  const campaign =
    req.session.user.role === 'agent' ? await findCurrentCampaign(req.session.user.id) : null;

  const [insertResult] = await pool.query(
    `INSERT INTO calls (tenant_id, lead_id, direction, from_extension, to_number, campaign_id)
     VALUES (1, ?, 'outbound', ?, ?, ?)`,
    [leadId || null, fromExtension, toNumber, campaign ? campaign.id : null]
  );
  const callId = insertResult.insertId;
  await logEvent(callId, 'originated', { fromExtension, toNumber });

  try {
    // Leg 1: ring the agent's own extension first.
    const agentChannel = await ari.originate({
      endpoint: `PJSIP/${fromExtension}`,
      app: APP_NAME,
      appArgs: `click2call,${callId},agent`,
    });
    activeCalls.set(callId, { agentChannelId: agentChannel.id, destChannelId: null, bridgeId: null });
    res.status(202).json({ callId, status: 'ringing_agent' });
  } catch (err) {
    await logEvent(callId, 'error', { message: err.message });
    res.status(502).json({ error: err.message });
  }
});

// --- Admin: manage user accounts ---
app.get('/admin/users', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT users.id, users.username, users.role, users.created_at, extensions.name AS extension_name
     FROM users LEFT JOIN extensions ON users.extension_id = extensions.id
     ORDER BY users.id`
  );
  res.json(rows);
});

app.post('/admin/users', requireRole('admin'), async (req, res) => {
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
      [username, hash, role, role === 'agent' ? extensionId : null]
    );
    res.status(201).json({ id: result.insertId, username, role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'that username is already taken' });
    }
    throw err;
  }
});

app.get('/admin/extensions', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM extensions ORDER BY id');
  res.json(rows);
});

// --- Admin: dashboard summary ---
app.get('/admin/dashboard', requireRole('admin'), async (req, res) => {
  const [[agentCount]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role = 'agent'");
  const [[availableCount]] = await pool.query(
    `SELECT COUNT(*) AS c FROM agent_status_log
     WHERE ended_at IS NULL AND status = 'available'`
  );
  const [[callsToday]] = await pool.query(
    'SELECT COUNT(*) AS c FROM calls WHERE DATE(start_time) = CURDATE()'
  );
  const [[avgHandle]] = await pool.query(
    `SELECT COALESCE(AVG(TIMESTAMPDIFF(SECOND, answer_time, end_time)), 0) AS secs
     FROM calls WHERE DATE(start_time) = CURDATE() AND answer_time IS NOT NULL AND end_time IS NOT NULL`
  );
  res.json({
    totalAgents: agentCount.c,
    availableNow: availableCount.c,
    callsToday: callsToday.c,
    avgHandleSeconds: Math.round(Number(avgHandle.secs)),
  });
});

// --- Admin: real-time live agent status ---
app.get('/admin/live-agents', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT
      u.id, u.username, e.name AS extension_name,
      asl.status, asl.reason, asl.started_at,
      q.name AS queue_name,
      (SELECT c.to_number FROM calls c WHERE c.from_extension = e.name AND c.end_time IS NULL ORDER BY c.id DESC LIMIT 1) AS active_call_number
    FROM users u
    LEFT JOIN extensions e ON u.extension_id = e.id
    LEFT JOIN agent_status_log asl ON asl.user_id = u.id AND asl.ended_at IS NULL
    LEFT JOIN queues q ON q.id = asl.queue_id
    WHERE u.role = 'agent'
    ORDER BY u.username
  `);
  res.json(rows);
});

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
app.get('/admin/reports/campaigns', requireRole('admin'), async (req, res) => {
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
     GROUP BY c.id, c.name
     ORDER BY c.id DESC`,
    [from, to]
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
app.get('/admin/reports/agents', requireRole('admin'), async (req, res) => {
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
    [from, to]
  );

  const [loginStats] = await pool.query(
    `SELECT user_id,
       COALESCE(SUM(TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, NOW()))), 0) AS login_seconds
     FROM agent_status_log
     WHERE DATE(started_at) BETWEEN ? AND ?
     GROUP BY user_id`,
    [from, to]
  );

  const [callbackStats] = await pool.query(
    `SELECT updated_by AS user_id, COUNT(*) AS callbacks
     FROM leads
     WHERE status = 'callback' AND updated_by IS NOT NULL AND DATE(updated_at) BETWEEN ? AND ?
     GROUP BY updated_by`,
    [from, to]
  );

  const [agents] = await pool.query("SELECT id, username FROM users WHERE role = 'agent'");

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
app.get('/admin/reports/calls', requireRole('admin'), async (req, res) => {
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
app.get('/admin/reports/hourly', requireRole('admin'), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const [rows] = await pool.query(
    `SELECT HOUR(start_time) AS hour, COUNT(*) AS total_calls, SUM(answer_time IS NOT NULL) AS answered
     FROM calls WHERE DATE(start_time) = ?
     GROUP BY HOUR(start_time)`,
    [date]
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

// --- ARI event handling: drives the click-to-call flow above ---
ari.connectEvents(APP_NAME, async (event) => {
  try {
    if (event.type === 'StasisStart') {
      const [tag] = event.args;

      if (tag === 'inbound') {
        // A real PSTN call arrived via the trunk. Route it into Asterisk's
        // own native Queue() app - real ring strategy, real skip-if-
        // unreachable device state, real hold - rather than our own
        // simplified single-agent picker.
        const callerNumber = event.args[1] || 'unknown';
        const dialedNumber = event.args[2] || null;

        // Which campaign owns the number that was actually dialed? This is
        // the real routing decision - falls back to "first active campaign
        // with a queue" only if the DID genuinely isn't mapped yet, and
        // that fallback is logged loudly since it means a misconfiguration
        // (a live DID nobody assigned to a campaign), not normal operation.
        let campaign = null;
        let didMatched = false;
        if (dialedNumber) {
          const [didRows] = await pool.query(
            `SELECT c.id, c.auto_answer, q.asterisk_name
             FROM dids d
             JOIN campaigns c ON c.id = d.campaign_id
             JOIN queues q ON q.id = c.queue_id
             WHERE d.number = ? AND c.status = 'active' AND q.status = 'active'
             LIMIT 1`,
            [dialedNumber]
          );
          if (didRows[0]) {
            campaign = didRows[0];
            didMatched = true;
          }
        }

        if (!campaign) {
          const [campaignRows] = await pool.query(`
            SELECT c.id, c.auto_answer, q.asterisk_name
            FROM campaigns c
            JOIN queues q ON q.id = c.queue_id
            WHERE c.status = 'active' AND q.status = 'active'
            ORDER BY c.id ASC
            LIMIT 1
          `);
          campaign = campaignRows[0] || null;
          if (campaign) {
            console.error(
              `[DID routing] "${dialedNumber}" has no campaign mapping - falling back to campaign ${campaign.id}. Add it under Admin > Campaigns > DID Numbers.`
            );
          }
        }

        if (!campaign) {
          // No campaign/queue configured to receive this yet - don't
          // leave the caller in dead air.
          await ari.answer(event.channel.id);
          await new Promise((resolve) => setTimeout(resolve, 4000));
          try {
            await ari.hangup(event.channel.id);
          } catch (err) {
            // Caller already hung up - fine.
          }
          return;
        }

        // from_extension isn't known yet - Asterisk's queue engine decides
        // who answers, not us. AMI's AgentConnect event fills it in.
        const [insertResult] = await pool.query(
          `INSERT INTO calls (tenant_id, direction, to_number, campaign_id, auto_answer)
           VALUES (1, 'inbound', ?, ?, ?)`,
          [callerNumber, campaign.id, campaign.auto_answer]
        );
        const callId = insertResult.insertId;
        queueCallChannels.set(event.channel.name, callId);
        await logEvent(callId, 'queued', {
          queue: campaign.asterisk_name,
          callerNumber,
          dialedNumber,
          didMatched,
        });

        await ari.setChannelVar(event.channel.id, 'QUEUENAME', campaign.asterisk_name);
        await ari.continueInDialplan(event.channel.id, {
          context: 'queue-dispatch',
          extension: 's',
          priority: 1,
        });
        return;
      }

      if (tag !== 'click2call') return;
      const callId = parseInt(event.args[1], 10);
      const leg = event.args[2];
      const state = activeCalls.get(callId);
      if (!state) return;

      if (leg === 'agent') {
        await ari.answer(event.channel.id);
        await logEvent(callId, 'agent_answered', { channelId: event.channel.id });

        if (state.destChannelId) {
          // Inbound flow: the caller is already waiting - answer them now
          // and bridge immediately, rather than originating anything new.
          await ari.answer(state.destChannelId);
          await pool.query('UPDATE calls SET answer_time = NOW() WHERE id = ?', [callId]);
          const bridge = await ari.createBridge();
          await ari.addChannelToBridge(bridge.id, event.channel.id);
          await ari.addChannelToBridge(bridge.id, state.destChannelId);
          state.bridgeId = bridge.id;
          await logEvent(callId, 'bridged', { bridgeId: bridge.id });
        } else {
          // Outbound click2call flow: the agent just picked up, now dial
          // the real destination.
          const [rows] = await pool.query('SELECT to_number, campaign_id FROM calls WHERE id = ?', [callId]);
          const toNumber = rows[0].to_number;
          let campaignCallerId = null;
          if (rows[0].campaign_id) {
            const [campRows] = await pool.query(
              'SELECT outbound_caller_id FROM campaigns WHERE id = ?',
              [rows[0].campaign_id]
            );
            campaignCallerId = campRows[0] ? campRows[0].outbound_caller_id : null;
          }
          const { endpoint, callerId } = await resolveDestination(toNumber, campaignCallerId);
          const destChannel = await ari.originate({
            endpoint,
            app: APP_NAME,
            appArgs: `click2call,${callId},dest`,
            callerId,
          });
          state.destChannelId = destChannel.id;
        }
      } else if (leg === 'dest') {
        await ari.answer(event.channel.id);
        await logEvent(callId, 'dest_answered', { channelId: event.channel.id });

        const bridge = await ari.createBridge();
        await ari.addChannelToBridge(bridge.id, state.agentChannelId);
        await ari.addChannelToBridge(bridge.id, event.channel.id);
        state.bridgeId = bridge.id;

        await pool.query('UPDATE calls SET answer_time = NOW() WHERE id = ?', [callId]);
        await logEvent(callId, 'bridged', { bridgeId: bridge.id });
      }
    } else if (event.type === 'StasisEnd') {
      for (const [callId, state] of activeCalls.entries()) {
        if (state.agentChannelId === event.channel.id || state.destChannelId === event.channel.id) {
          // Claim this call's cleanup IMMEDIATELY, before any await - hanging
          // up the other leg below triggers a second StasisEnd for it almost
          // instantly, and without this synchronous delete both events would
          // race each other into processing the same call-end twice (this
          // was a real bug: it double-fired the agent's ACW transition and
          // could leave them with no open status row at all).
          activeCalls.delete(callId);

          // A bridge does NOT automatically hang up the other party just
          // because one leg left - ARI leaves teardown entirely to us.
          // Without this, whichever side didn't hang up first stays
          // connected indefinitely (this was a real bug, not a gap).
          const otherChannelId =
            state.agentChannelId === event.channel.id ? state.destChannelId : state.agentChannelId;
          if (otherChannelId) {
            try {
              await ari.hangup(otherChannelId);
            } catch (err) {
              // Already gone (e.g. both sides hung up near-simultaneously) - fine.
            }
          }
          if (state.bridgeId) {
            try {
              await ari.destroyBridge(state.bridgeId);
            } catch (err) {
              // Already gone - fine.
            }
          }

          const [callRows] = await pool.query('SELECT from_extension FROM calls WHERE id = ?', [callId]);
          await pool.query(
            "UPDATE calls SET end_time = NOW(), disposition = 'ended' WHERE id = ?",
            [callId]
          );
          await logEvent(callId, 'ended', { channelId: event.channel.id });

          // Automatically move the agent into after-call-work (ACW) status
          // once their call ends - matches real contact-center behavior,
          // they explicitly go back to Available when done wrapping up.
          const acwUserId = await findAgentIdByExtension(callRows[0].from_extension);
          if (acwUserId) {
            await setAgentStatus(acwUserId, 'acw', null, null, callRows[0].from_extension);
          }
          break;
        }
      }
    }
  } catch (err) {
    console.error('[ARI event handler error]', err);
  }
});

// --- AMI event handling: fills in tracking for calls handed off to
// native Queue() - once continueInDialplan() runs above, Stasis stops
// receiving any more events for that channel, so these AMI events are
// the only way left to know who answered and when it ended.
ami.on('AgentConnect', async (fields) => {
  try {
    const callId = queueCallChannels.get(fields.Channel);
    if (!callId) return;
    const match = (fields.Interface || '').match(/PJSIP\/([^\s,]+)/i);
    const extensionName = match ? match[1] : null;
    if (!extensionName) return;
    await pool.query('UPDATE calls SET from_extension = ?, answer_time = NOW() WHERE id = ?', [extensionName, callId]);
    await logEvent(callId, 'agent_answered', { extensionName, interface: fields.Interface });
  } catch (err) {
    console.error('[AMI AgentConnect handling error]', err);
  }
});

ami.on('AgentComplete', async (fields) => {
  try {
    const callId = queueCallChannels.get(fields.Channel);
    if (!callId) return;
    queueCallChannels.delete(fields.Channel);
    await pool.query("UPDATE calls SET end_time = NOW(), disposition = 'ended' WHERE id = ?", [callId]);
    await logEvent(callId, 'ended', { interface: fields.Interface, reason: fields.Reason });

    // Same auto-ACW behavior the click2call path already has - the agent
    // explicitly goes back to Available when done wrapping up.
    const match = (fields.Interface || '').match(/PJSIP\/([^\s,]+)/i);
    const extensionName = match ? match[1] : null;
    if (extensionName) {
      const acwUserId = await findAgentIdByExtension(extensionName);
      if (acwUserId) {
        await setAgentStatus(acwUserId, 'acw', null, null, extensionName);
      }
    }
  } catch (err) {
    console.error('[AMI AgentComplete handling error]', err);
  }
});

ami.on('QueueCallerAbandon', async (fields) => {
  try {
    const callId = queueCallChannels.get(fields.Channel);
    if (!callId) return;
    queueCallChannels.delete(fields.Channel);
    await pool.query("UPDATE calls SET end_time = NOW(), disposition = 'abandoned' WHERE id = ?", [callId]);
    await logEvent(callId, 'abandoned', {});
  } catch (err) {
    console.error('[AMI QueueCallerAbandon handling error]', err);
  }
});

const PORT = process.env.PORT || 3000;
// HTTPS is required, not just nicer - browsers block microphone access
// (getUserMedia, which JsSIP/WebRTC needs) on any page that isn't a
// secure context, so the embedded softphone in agent.html can't work
// over plain HTTP.
const CERT_DIR = path.join(__dirname, 'certs');
const tlsOptions = {
  key: fs.readFileSync(path.join(CERT_DIR, 'privkey.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'fullchain.pem')),
};
https.createServer(tlsOptions, app).listen(PORT, () =>
  console.log(`DialForge backend listening on port ${PORT} (HTTPS)`)
);
