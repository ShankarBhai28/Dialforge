require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { normalizePhone, localTimeIn, isWithinCallWindow, finishAttempt } = require('./dialer-common');
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

const leadUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
    await releasePreviewLocks(req.session.user.id, null);
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
  let keepCampaignId = null;
  if (status === 'available' && queueId) {
    const [c] = await pool.query('SELECT id FROM campaigns WHERE queue_id = ? LIMIT 1', [queueId]);
    keepCampaignId = c[0] ? c[0].id : null;
  }
  await releasePreviewLocks(userId, keepCampaignId).catch((err) => console.error('[preview release failed]', err.message));
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
  // Enforced here too, not just by hiding queues in the UI - otherwise a
  // hand-crafted request could join any campaign's queue.
  if (status === 'available') {
    const allowed = await findAgentQueues(req.session.user.id);
    if (!allowed.some((q) => q.id === Number(queueId))) {
      return res.status(403).json({ error: 'this queue is not in any of your teams\' campaigns' });
    }
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
// Agents additionally only see campaigns mapped to one of their (active)
// teams - an agent in no team sees nothing, by design.
app.get('/queues', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') {
    const [rows] = await pool.query(`
      SELECT q.id, q.name, c.name AS campaign_name
      FROM queues q
      JOIN campaigns c ON c.queue_id = q.id
      WHERE q.status = 'active' AND c.status = 'active'
      ORDER BY c.name, q.name
    `);
    return res.json(rows);
  }
  res.json(await findAgentQueues(req.session.user.id));
});

// Queues this agent may work, via team membership -> team's campaigns.
// DISTINCT because an agent in two teams sharing a campaign would
// otherwise see that queue twice.
async function findAgentQueues(userId) {
  const [rows] = await pool.query(`
    SELECT DISTINCT q.id, q.name, c.name AS campaign_name
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
    JOIN team_campaigns tc ON tc.team_id = t.id
    JOIN campaigns c ON c.id = tc.campaign_id AND c.status = 'active'
    JOIN queues q ON q.id = c.queue_id AND q.status = 'active'
    WHERE tm.user_id = ?
    ORDER BY c.name, q.name
  `, [userId]);
  return rows;
}

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
  const stanza = `\n[${asteriskName}]\nstrategy = ${ringStrategy || 'ringall'}\ntimeout = ${waitTimeout || 30}\nretry = ${retry || 1}\ntimeoutrestart = ${timeoutRestart || 'yes'}\nannounce-frequency = ${announceFrequency}\nringinuse = no\n`;
  try {
    fs.appendFileSync(QUEUES_CONF_PATH, stanza);
    await ami.queueReload();
  } catch (err) {
    console.error('[Queue config write/reload failed]', err.message);
    return res.status(500).json({ error: 'queue saved but Asterisk could not be updated: ' + err.message });
  }

  res.status(201).json({ id: result.insertId, name, asteriskName });
});

// ringinuse = no: never ring a member who is already on a call - essential
// once the dialer feeds the queue (an agent mid-call must not get a second
// customer). Optional in the regex so stanzas written before D7 still match.
// Ring-behavior fields live in a 6-line stanza in queues.conf, written
// without any brackets in the body - this regex relies on that to find
// exactly one stanza and nothing past the next queue's `[name]` line.
// Safe to build directly from asterisk_name since slugify() only ever
// produces [a-z0-9_], never a regex metacharacter.
function queueStanzaRegex(asteriskName) {
  return new RegExp(
    `\\n?\\[${asteriskName}\\]\\nstrategy = [^\\n]*\\ntimeout = [^\\n]*\\nretry = [^\\n]*\\ntimeoutrestart = [^\\n]*\\nannounce-frequency = [^\\n]*\\n(?:ringinuse = [^\\n]*\\n)?`
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

// --- D3: phone normalisation, DNC, calling window, campaign dial settings,
// per-campaign dispositions ---

async function isDnc(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const [rows] = await pool.query('SELECT 1 FROM dnc_numbers WHERE tenant_id = 1 AND phone = ? LIMIT 1', [normalized]);
  return rows.length > 0;
}

async function addDnc(phone, source, userId) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const [result] = await pool.query(
    'INSERT IGNORE INTO dnc_numbers (tenant_id, phone, source, created_by) VALUES (1, ?, ?, ?)',
    [normalized, source, userId || null]
  );
  return result.affectedRows > 0;
}

const DIAL_MODES = ['manual', 'preview', 'progressive', 'predictive'];

// Parses and range-checks the dial settings block of a campaign form.
// Returns { error } or { settings } with DB column names.
function parseCampaignSettings(body) {
  const num = (v, def) => (v === undefined || v === null || v === '' ? def : Number(v));
  const s = {
    dial_mode: body.dialMode || 'manual',
    dial_ratio: num(body.dialRatio, 1),
    max_dial_ratio: num(body.maxDialRatio, 2.5),
    target_abandon_pct: num(body.targetAbandonPct, 3),
    ring_timeout_sec: num(body.ringTimeoutSec, 30),
    max_attempts: num(body.maxAttempts, 3),
    max_channels: num(body.maxChannels, 10),
    amd_enabled: body.amdEnabled ? 1 : 0,
    preview_autodial_sec: num(body.previewAutodialSec, null),
    wrapup_sec: num(body.wrapupSec, 10),
    call_window_start: body.callWindowStart || '09:00',
    call_window_end: body.callWindowEnd || '21:00',
    timezone: body.timezone || 'Asia/Kolkata',
    abandon_wait_sec: num(body.abandonWaitSec, 5),
  };
  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!DIAL_MODES.includes(s.dial_mode)) return { error: 'unknown dial mode' };
  if (!inRange(s.dial_ratio, 1, 5)) return { error: 'dial ratio must be between 1 and 5' };
  if (!inRange(s.max_dial_ratio, s.dial_ratio, 5)) return { error: 'max dial ratio must be between the dial ratio and 5' };
  if (!inRange(s.target_abandon_pct, 0, 10)) return { error: 'target abandon % must be between 0 and 10' };
  if (!inRange(s.ring_timeout_sec, 10, 60)) return { error: 'ring timeout must be 10-60 seconds' };
  if (!inRange(s.max_attempts, 1, 20) || !Number.isInteger(s.max_attempts)) return { error: 'max attempts must be a whole number 1-20' };
  if (!inRange(s.max_channels, 1, 200) || !Number.isInteger(s.max_channels)) return { error: 'max channels must be a whole number 1-200' };
  if (s.preview_autodial_sec !== null && !inRange(s.preview_autodial_sec, 0, 120)) return { error: 'preview auto-dial must be 0-120 seconds' };
  if (!inRange(s.wrapup_sec, 0, 600)) return { error: 'wrap-up must be 0-600 seconds' };
  if (!inRange(s.abandon_wait_sec, 2, 30) || !Number.isInteger(s.abandon_wait_sec)) return { error: 'max wait for an agent must be 2-30 seconds' };
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
  if (!timeRe.test(s.call_window_start) || !timeRe.test(s.call_window_end)) return { error: 'calling window times must be HH:MM' };
  if (s.call_window_start.length === 5) s.call_window_start += ':00';
  if (s.call_window_end.length === 5) s.call_window_end += ':00';
  if (s.call_window_start >= s.call_window_end) return { error: 'calling window start must be before its end' };
  try {
    localTimeIn(s.timezone);
  } catch {
    return { error: `unknown timezone "${s.timezone}"` };
  }
  return { settings: s };
}

// Seeded into every new campaign - same codes the system always used.
const DEFAULT_DISPOSITIONS = [
  { code: 'interested', label: 'Interested', is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'not_interested', label: 'Not Interested', is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'callback', label: 'Callback', is_final: 0, retry_after_min: null, marks_dnc: 0, is_callback: 1 },
  { code: 'no_answer', label: 'No Answer', is_final: 0, retry_after_min: 60, marks_dnc: 0, is_callback: 0 },
  { code: 'do_not_call', label: 'Do Not Call', is_final: 1, retry_after_min: null, marks_dnc: 1, is_callback: 0 },
];

// A lead with no campaign (e.g. added by an admin without one) falls back
// to the defaults so it can still be dispositioned.
async function getDispositions(campaignId) {
  if (!campaignId) return DEFAULT_DISPOSITIONS;
  const [rows] = await pool.query(
    'SELECT code, label, is_final, retry_after_min, marks_dnc, is_callback FROM campaign_dispositions WHERE campaign_id = ? ORDER BY sort_order, id',
    [campaignId]
  );
  return rows;
}

function validateDispositions(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'a campaign needs at least one disposition' };
  const seen = new Set();
  const cleaned = [];
  for (const d of list) {
    const code = String(d.code || '').trim();
    const label = String(d.label || '').trim();
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(code)) return { error: `code "${code}" must be lowercase letters, digits, underscores, starting with a letter` };
    if (code === 'new') return { error: '"new" is reserved for leads not yet called' };
    if (seen.has(code)) return { error: `code "${code}" is used twice` };
    seen.add(code);
    if (!label) return { error: `disposition "${code}" needs a label` };
    const retry = d.retryAfterMin === '' || d.retryAfterMin == null ? null : Number(d.retryAfterMin);
    if (retry !== null && (!Number.isInteger(retry) || retry < 1 || retry > 43200)) {
      return { error: `"${label}": retry must be a whole number of minutes (1-43200)` };
    }
    const isFinal = d.isFinal ? 1 : 0;
    const isCallback = d.isCallback ? 1 : 0;
    const marksDnc = d.marksDnc ? 1 : 0;
    if (isFinal && (retry !== null || isCallback)) return { error: `"${label}": a final disposition can't also retry or schedule a callback` };
    if (marksDnc && !isFinal) return { error: `"${label}": Do-Not-Call dispositions must also be final` };
    if (isCallback && retry !== null) return { error: `"${label}": pick either callback or retry, not both` };
    cleaned.push({ code, label, is_final: isFinal, retry_after_min: retry, marks_dnc: marksDnc, is_callback: isCallback });
  }
  return { dispositions: cleaned };
}

async function replaceDispositions(conn, campaignId, list) {
  await conn.query('DELETE FROM campaign_dispositions WHERE campaign_id = ?', [campaignId]);
  for (const [i, d] of list.entries()) {
    await conn.query(
      `INSERT INTO campaign_dispositions (campaign_id, code, label, is_final, retry_after_min, marks_dnc, is_callback, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [campaignId, d.code, d.label, d.is_final, d.retry_after_min, d.marks_dnc, d.is_callback, i]
    );
  }
}

// --- Admin: campaigns (each references one queue) ---
app.get('/admin/campaigns', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT c.*, q.name AS queue_name, q.ring_strategy, q.wait_timeout, f.name AS form_name
    FROM campaigns c
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN forms f ON f.id = c.form_id
    ORDER BY c.id DESC
  `);
  res.json(rows);
});

// Only an active form can be attached to a campaign.
async function checkCampaignForm(formId) {
  if (!formId) return null;
  const [rows] = await pool.query('SELECT status FROM forms WHERE id = ?', [formId]);
  if (!rows[0]) return 'form not found';
  if (rows[0].status !== 'active') return 'that form is inactive';
  return null;
}

app.post('/admin/campaigns', requireRole('admin'), async (req, res) => {
  const { name, queueId, outboundCallerId, autoAnswer, formId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const formError = await checkCampaignForm(formId);
  if (formError) return res.status(400).json({ error: formError });
  const { error, settings } = parseCampaignSettings(req.body);
  if (error) return res.status(400).json({ error });
  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    [result] = await conn.query(
      'INSERT INTO campaigns SET ?',
      [{ tenant_id: 1, name, queue_id: queueId || null, outbound_caller_id: outboundCallerId || null,
        auto_answer: autoAnswer ? 1 : 0, form_id: formId || null, ...settings }]
    );
    await replaceDispositions(conn, result.insertId, DEFAULT_DISPOSITIONS);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[campaign create failed]', err);
    return res.status(500).json({ error: 'failed to create campaign' });
  } finally {
    conn.release();
  }
  res.status(201).json({ id: result.insertId, name });
});

app.put('/admin/campaigns/:id', requireRole('admin'), async (req, res) => {
  const { name, queueId, outboundCallerId, autoAnswer, status, formId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'campaign not found' });
  const formError = await checkCampaignForm(formId);
  if (formError) return res.status(400).json({ error: formError });
  const { error, settings } = parseCampaignSettings(req.body);
  if (error) return res.status(400).json({ error });

  await pool.query('UPDATE campaigns SET ? WHERE id = ?', [
    { name, queue_id: queueId || null, outbound_caller_id: outboundCallerId || null, auto_answer: autoAnswer ? 1 : 0,
      status: status || 'active', form_id: formId || null, ...settings },
    req.params.id,
  ]);
  if (settings.dial_mode === 'manual') {
    await pool.query("UPDATE campaigns SET dialer_state = 'stopped' WHERE id = ? AND dialer_state <> 'stopped'", [req.params.id]);
  }
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
  const [responseRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM form_responses WHERE campaign_id = ?', [req.params.id]);
  const [callbackRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM callbacks WHERE campaign_id = ?', [req.params.id]);

  const blockers = [];
  if (didRefs.length) blockers.push(`${didRefs.length} DID number(s) (${didRefs.map((d) => d.number).join(', ')})`);
  if (leadRefs[0].cnt > 0) blockers.push(`${leadRefs[0].cnt} lead(s)`);
  if (callRefs[0].cnt > 0) blockers.push(`${callRefs[0].cnt} call record(s)`);
  if (responseRefs[0].cnt > 0) blockers.push(`${responseRefs[0].cnt} form response(s)`);
  if (callbackRefs[0].cnt > 0) blockers.push(`${callbackRefs[0].cnt} callback(s)`);
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

// is_active decides whether the dialer takes leads from a list;
// priority orders lists within a campaign (higher first).
function parseListPriority(v) {
  const n = v === undefined || v === '' ? 0 : Number(v);
  return Number.isInteger(n) && n >= -100 && n <= 100 ? n : null;
}

app.post('/admin/lists', requireRole('admin'), async (req, res) => {
  const { name, campaignId, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const priority = parseListPriority(req.body.priority);
  if (priority === null) return res.status(400).json({ error: 'priority must be a whole number -100..100' });
  const [result] = await pool.query(
    'INSERT INTO lists (tenant_id, campaign_id, name, is_active, priority) VALUES (1, ?, ?, ?, ?)',
    [campaignId, name, isActive === false ? 0 : 1, priority]
  );
  res.status(201).json({ id: result.insertId, name, campaignId });
});

app.put('/admin/lists/:id', requireRole('admin'), async (req, res) => {
  const { name, campaignId, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const priority = parseListPriority(req.body.priority);
  if (priority === null) return res.status(400).json({ error: 'priority must be a whole number -100..100' });
  const [rows] = await pool.query('SELECT id FROM lists WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'list not found' });
  await pool.query('UPDATE lists SET name = ?, campaign_id = ?, is_active = ?, priority = ? WHERE id = ?',
    [name, campaignId, isActive === false ? 0 : 1, priority, req.params.id]);
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

// --- Admin: custom forms (fields an agent fills in per call) ---
const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'email', 'phone', 'date', 'dropdown', 'radio', 'checkbox'];
const FIELD_TYPES_WITH_OPTIONS = ['dropdown', 'radio', 'checkbox'];

// Returns an error string, or null plus the cleaned field list. Checked
// server-side because a bad field_key or a dropdown with no options would
// otherwise only show up later as a broken agent screen.
function validateFormFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return { error: 'a form needs at least one field' };
  const seen = new Set();
  const cleaned = [];
  for (const [i, f] of fields.entries()) {
    const key = String(f.fieldKey || '').trim();
    const label = String(f.label || '').trim();
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key)) {
      return { error: `field ${i + 1}: key "${key}" must be lowercase letters, digits, underscores, starting with a letter` };
    }
    if (seen.has(key)) return { error: `field key "${key}" is used twice` };
    seen.add(key);
    if (!label) return { error: `field "${key}" needs a label` };
    if (!FORM_FIELD_TYPES.includes(f.fieldType)) return { error: `field "${key}" has an unknown type` };
    let options = null;
    if (FIELD_TYPES_WITH_OPTIONS.includes(f.fieldType)) {
      options = (f.options || []).map((o) => String(o).trim()).filter(Boolean);
      if (options.length === 0) return { error: `field "${key}" (${f.fieldType}) needs at least one option` };
    }
    cleaned.push({ key, label, type: f.fieldType, options, required: f.isRequired ? 1 : 0, order: i });
  }
  return { fields: cleaned };
}

async function loadFormsWithFields(whereSql = '', params = []) {
  const [forms] = await pool.query(`SELECT * FROM forms ${whereSql} ORDER BY id DESC`, params);
  if (forms.length === 0) return [];
  const [fields] = await pool.query(
    'SELECT * FROM form_fields WHERE form_id IN (?) ORDER BY sort_order, id', [forms.map((f) => f.id)]
  );
  return forms.map((form) => ({ ...form, fields: fields.filter((f) => f.form_id === form.id) }));
}

app.get('/admin/forms', requireRole('admin'), async (req, res) => {
  const forms = await loadFormsWithFields();
  const [usage] = await pool.query(
    'SELECT form_id, GROUP_CONCAT(name ORDER BY name SEPARATOR \', \') AS campaigns FROM campaigns WHERE form_id IS NOT NULL GROUP BY form_id'
  );
  const [counts] = await pool.query('SELECT form_id, COUNT(*) AS cnt FROM form_responses GROUP BY form_id');
  res.json(forms.map((f) => ({
    ...f,
    campaigns: (usage.find((u) => u.form_id === f.id) || {}).campaigns || null,
    response_count: (counts.find((c) => c.form_id === f.id) || {}).cnt || 0,
  })));
});

// Create and edit replace the whole field list in one transaction. Old
// responses are stored by field_key, so re-creating field rows is safe.
async function saveForm(formId, { name, description, status, fields }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (formId) {
      await conn.query('UPDATE forms SET name = ?, description = ?, status = ? WHERE id = ?',
        [name, description || null, status || 'active', formId]);
      await conn.query('DELETE FROM form_fields WHERE form_id = ?', [formId]);
    } else {
      const [result] = await conn.query('INSERT INTO forms (tenant_id, name, description, status) VALUES (1, ?, ?, ?)',
        [name, description || null, status || 'active']);
      formId = result.insertId;
    }
    for (const f of fields) {
      await conn.query(
        'INSERT INTO form_fields (form_id, field_key, label, field_type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [formId, f.key, f.label, f.type, f.options ? JSON.stringify(f.options) : null, f.required, f.order]
      );
    }
    await conn.commit();
    return formId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function handleFormSave(req, res, formId) {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { error, fields } = validateFormFields(req.body.fields);
  if (error) return res.status(400).json({ error });
  // Deactivating a form a campaign still points at would silently remove
  // the form from agents' screens - make the admin unlink it first.
  if (formId && req.body.status === 'inactive') {
    const [refs] = await pool.query('SELECT name FROM campaigns WHERE form_id = ?', [formId]);
    if (refs.length) {
      return res.status(409).json({ error: `Cannot deactivate - used by campaign(s): ${refs.map((r) => r.name).join(', ')}. Pick another form for them first.` });
    }
  }
  try {
    const id = await saveForm(formId, { ...req.body, name, fields });
    res.status(formId ? 200 : 201).json({ id, name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'a form with that name already exists' });
    console.error('[form save failed]', err);
    res.status(500).json({ error: 'failed to save form' });
  }
}

app.post('/admin/forms', requireRole('admin'), (req, res) => handleFormSave(req, res, null));

app.put('/admin/forms/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM forms WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'form not found' });
  return handleFormSave(req, res, Number(req.params.id));
});

// Blocked while referenced: a campaign using it, or saved responses
// (those are real call data - deactivate the form instead).
app.delete('/admin/forms/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM forms WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'form not found' });
  const [campRefs] = await pool.query('SELECT name FROM campaigns WHERE form_id = ?', [req.params.id]);
  const [respRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM form_responses WHERE form_id = ?', [req.params.id]);
  const blockers = [];
  if (campRefs.length) blockers.push(`campaign(s) ${campRefs.map((c) => c.name).join(', ')}`);
  if (respRefs[0].cnt > 0) blockers.push(`${respRefs[0].cnt} saved response(s) - set it Inactive instead`);
  if (blockers.length) return res.status(409).json({ error: `Cannot delete - still referenced by ${blockers.join(' and ')}.` });
  await pool.query('DELETE FROM forms WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

app.get('/admin/forms/:id/responses', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT r.id, r.data, r.created_at, r.lead_id, r.call_id, u.username, c.name AS campaign_name, l.phone AS lead_phone
    FROM form_responses r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN campaigns c ON c.id = r.campaign_id
    LEFT JOIN leads l ON l.id = r.lead_id
    WHERE r.form_id = ?
    ORDER BY r.id DESC LIMIT 200
  `, [req.params.id]);
  res.json(rows);
});

// --- Agent: the form for the campaign they're currently working ---
app.get('/agent/form', requireAuth, async (req, res) => {
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign || !campaign.form_id) return res.json(null);
  const [form] = await loadFormsWithFields('WHERE id = ? AND status = \'active\'', [campaign.form_id]);
  res.json(form || null);
});

// Values are re-checked against the form definition here - the browser's
// "required" attribute is a convenience, not a guarantee.
function validateFormData(fields, data) {
  const clean = {};
  for (const f of fields) {
    let v = data[f.field_key];
    const options = f.options || [];
    if (f.field_type === 'checkbox') {
      v = Array.isArray(v) ? v.map(String) : [];
      if (v.some((x) => !options.includes(x))) return { error: `"${f.label}" has an invalid choice` };
      if (f.is_required && v.length === 0) return { error: `"${f.label}" is required` };
      clean[f.field_key] = v;
      continue;
    }
    v = v == null ? '' : String(v).trim();
    if (v === '') {
      if (f.is_required) return { error: `"${f.label}" is required` };
      clean[f.field_key] = null;
      continue;
    }
    if (f.field_type === 'number' && !Number.isFinite(Number(v))) return { error: `"${f.label}" must be a number` };
    if (f.field_type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: `"${f.label}" must be an email` };
    if (f.field_type === 'phone' && !/^\+?[0-9]{6,15}$/.test(v)) return { error: `"${f.label}" must be a phone number` };
    if (f.field_type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: `"${f.label}" must be a date` };
    if (['dropdown', 'radio'].includes(f.field_type) && !options.includes(v)) return { error: `"${f.label}" has an invalid choice` };
    clean[f.field_key] = f.field_type === 'number' ? Number(v) : v;
  }
  return { data: clean };
}

app.post('/agent/form-responses', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign || !campaign.form_id) return res.status(400).json({ error: 'your current campaign has no form' });
  const [form] = await loadFormsWithFields('WHERE id = ? AND status = \'active\'', [campaign.form_id]);
  if (!form) return res.status(400).json({ error: 'your current campaign has no active form' });

  const { leadId, callId } = req.body;
  // The lead must belong to the campaign being worked, and the call must
  // be one this agent placed/took - otherwise answers could be attached
  // to someone else's record.
  if (leadId) {
    const [leads] = await pool.query('SELECT id FROM leads WHERE id = ? AND campaign_id = ?', [leadId, campaign.id]);
    if (!leads[0]) return res.status(400).json({ error: 'that lead is not in your current campaign' });
  }
  if (callId) {
    const [calls] = await pool.query('SELECT id FROM calls WHERE id = ? AND from_extension = ?', [callId, req.session.user.extensionName]);
    if (!calls[0]) return res.status(400).json({ error: 'that call is not yours' });
  }

  const { error, data } = validateFormData(form.fields, req.body.data || {});
  if (error) return res.status(400).json({ error });
  const [result] = await pool.query(
    'INSERT INTO form_responses (tenant_id, form_id, campaign_id, lead_id, call_id, user_id, data) VALUES (1, ?, ?, ?, ?, ?, ?)',
    [form.id, campaign.id, leadId || null, callId || null, req.session.user.id, JSON.stringify(data)]
  );
  res.status(201).json({ id: result.insertId });
});

// --- Admin: dialer control + live view (the engine itself is the
// separate dialer-engine.js process; these only flip state / read status) ---
app.post('/admin/campaigns/:id/dialer', requireRole('admin'), async (req, res) => {
  const { action } = req.body;
  const [rows] = await pool.query('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  const next = { start: 'running', pause: 'paused', stop: 'stopped' }[action];
  if (!next) return res.status(400).json({ error: 'action must be start, pause or stop' });
  if (action === 'start') {
    if (c.dial_mode === 'manual') return res.status(400).json({ error: 'set a dial mode other than Manual first (Campaigns → Edit)' });
    if (c.status !== 'active') return res.status(400).json({ error: 'campaign status must be Active' });
    if (!c.queue_id) return res.status(400).json({ error: 'campaign needs a queue' });
  }
  if (action === 'pause' && c.dialer_state !== 'running') return res.status(400).json({ error: 'only a running campaign can be paused' });
  await pool.query(
    'UPDATE campaigns SET dialer_state = ?, dialer_state_changed_at = NOW(), dialer_state_changed_by = ? WHERE id = ?',
    [next, req.session.user.id, c.id]
  );
  res.json({ status: 'ok', dialerState: next });
});

app.get('/admin/dialer', requireRole('admin'), async (req, res) => {
  // Row 0 is the engine's heartbeat: no tick for 15s+ means it's down.
  const [engineRows] = await pool.query(
    'SELECT note AS engine_id, last_tick_at, TIMESTAMPDIFF(SECOND, last_tick_at, NOW()) AS age_sec FROM dialer_status WHERE campaign_id = 0'
  );
  const engine = engineRows[0];
  const [campaigns] = await pool.query(`
    SELECT c.id, c.name, c.status, c.dial_mode, c.dial_ratio, c.max_dial_ratio, c.dialer_state, c.dialer_state_changed_at,
      u.username AS changed_by, q.name AS queue_name,
      s.hopper_ready, s.hopper_locked, s.idle_agents, s.would_dial, s.in_flight, s.active_calls, s.note, s.last_tick_at
    FROM campaigns c
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN users u ON u.id = c.dialer_state_changed_by
    LEFT JOIN dialer_status s ON s.campaign_id = c.id
    ORDER BY c.dialer_state = 'running' DESC, c.dialer_state = 'paused' DESC, c.name
  `);
  // Today = since midnight in India (server clock is UTC).
  const [stats] = await pool.query(`
    SELECT campaign_id, COUNT(*) AS attempts,
      SUM(answered_at IS NOT NULL) AS answered,
      SUM(result = 'connected') AS connected,
      SUM(result = 'abandoned' OR result = 'customer_hangup') AS abandoned,
      SUM(result IN ('no_answer', 'busy', 'congestion', 'failed', 'invalid')) AS not_reached,
      SUM(result = 'machine') AS machine
    FROM dial_attempts
    WHERE started_at >= CONVERT_TZ(DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')), '+05:30', '+00:00')
    GROUP BY campaign_id
  `);
  res.json({
    engine: engine ? { ...engine, alive: engine.age_sec <= 15 } : { alive: false },
    campaigns: campaigns.map((c) => ({ ...c, today: stats.find((x) => x.campaign_id === c.id) || null })),
  });
});

app.get('/admin/campaigns/:id/hopper', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT h.*, l.name, ls.name AS list_name, u.username AS reserved_for
    FROM dial_hopper h
    JOIN leads l ON l.id = h.lead_id
    LEFT JOIN lists ls ON ls.id = h.list_id
    LEFT JOIN users u ON u.id = h.reserved_user_id
    WHERE h.campaign_id = ?
    ORDER BY h.status = 'locked' DESC, h.is_callback DESC, h.list_priority DESC, h.lead_priority DESC, h.attempts, h.lead_id
    LIMIT 200
  `, [req.params.id]);
  res.json(rows);
});

// --- Agent: the dialer call they're on right now (screen pop, D7) ---
// The dialer's customer reaches the agent through Queue(), so the browser
// only sees "a call came in"; this tells it which lead it is.
app.get('/agent/active-call', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const [rows] = await pool.query(`
    SELECT c.id AS call_id, c.lead_id, l.name, l.phone, l.alt_phone, l.status, l.attempts, l.custom_data, ls.name AS list_name
    FROM calls c
    JOIN leads l ON l.id = c.lead_id
    LEFT JOIN lists ls ON ls.id = l.list_id
    WHERE c.from_extension = ? AND c.end_time IS NULL AND c.dial_attempt_id IS NOT NULL
      AND c.start_time > NOW() - INTERVAL 3 HOUR
    ORDER BY c.id DESC LIMIT 1
  `, [req.session.user.extensionName]);
  res.json(rows[0] || null);
});

app.get('/agent/campaign-info', requireAuth, async (req, res) => {
  const c = await findCurrentCampaign(req.session.user.id);
  res.json(c ? { id: c.id, name: c.name, dialMode: c.dial_mode, wrapupSec: c.wrapup_sec, dialerState: c.dialer_state } : null);
});

// --- Agent: Preview mode (D6) ---
// The agent "claims" the next hopper lead: the row is locked to them
// (locked_by = user:<id>) so no other agent or the dialer can take it,
// they read it, then Dial (normal click2call) or Skip.
const previewLockOwner = (userId) => `user:${userId}`;

async function currentAgentStatus(userId) {
  const [rows] = await pool.query(
    'SELECT status FROM agent_status_log WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [userId]
  );
  return rows[0] ? rows[0].status : 'offline';
}

// Locks are given back to the hopper when the agent stops working that
// campaign (break, ACW, logout, switching queue) - otherwise a lead would
// sit locked until the engine's 10-minute stale-lock expiry.
async function releasePreviewLocks(userId, keepCampaignId) {
  await pool.query(
    `UPDATE dial_hopper SET status = 'ready', locked_at = NULL, locked_by = NULL
     WHERE locked_by = ? AND (? IS NULL OR campaign_id <> ?)`,
    [previewLockOwner(userId), keepCampaignId || null, keepCampaignId || null]
  );
}

async function previewLeadDetails(hopperRow) {
  const [rows] = await pool.query(`
    SELECT l.id, l.name, l.phone, l.alt_phone, l.status, l.attempts, l.custom_data, ls.name AS list_name,
      cb.callback_at, cb.note AS callback_note
    FROM leads l
    LEFT JOIN lists ls ON ls.id = l.list_id
    LEFT JOIN callbacks cb ON cb.lead_id = l.id AND cb.status = 'pending'
    WHERE l.id = ?
  `, [hopperRow.lead_id]);
  return rows[0] ? { ...rows[0], is_callback: !!hopperRow.is_callback } : null;
}

// Why the agent can't get a preview lead right now (null = they can).
async function previewBlocker(userId, campaign) {
  if (!campaign) return 'pick a queue first';
  if (campaign.dial_mode !== 'preview') return 'not a preview campaign';
  if (campaign.dialer_state !== 'running') return `dialer is ${campaign.dialer_state} for this campaign`;
  if (!isWithinCallWindow(campaign)) return 'outside calling hours';
  if ((await currentAgentStatus(userId)) !== 'available') return 'go Available to get leads';
  return null;
}

app.get('/agent/preview', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign || campaign.dial_mode !== 'preview') return res.json({ enabled: false });
  const [held] = await pool.query('SELECT * FROM dial_hopper WHERE locked_by = ? AND campaign_id = ? LIMIT 1',
    [previewLockOwner(req.session.user.id), campaign.id]);
  res.json({
    enabled: true,
    blocker: await previewBlocker(req.session.user.id, campaign),
    autodialSec: campaign.preview_autodial_sec || 0,
    lead: held[0] ? await previewLeadDetails(held[0]) : null,
  });
});

app.post('/agent/preview/next', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const userId = req.session.user.id;
  const campaign = await findCurrentCampaign(userId);
  const blocker = await previewBlocker(userId, campaign);
  if (blocker) return res.json({ lead: null, blocker });

  const owner = previewLockOwner(userId);
  // Already holding one (e.g. page refresh) - give the same lead back.
  const [held] = await pool.query('SELECT * FROM dial_hopper WHERE locked_by = ? AND campaign_id = ? LIMIT 1', [owner, campaign.id]);
  if (held[0]) return res.json({ lead: await previewLeadDetails(held[0]) });

  // FOR UPDATE SKIP LOCKED: two agents asking at the same moment each get
  // a different row instead of one waiting on (or stealing) the other's.
  const conn = await pool.getConnection();
  let row = null;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(`
      SELECT * FROM dial_hopper
      WHERE campaign_id = ? AND status = 'ready' AND (reserved_user_id IS NULL OR reserved_user_id = ?)
      ORDER BY (reserved_user_id = ?) DESC, is_callback DESC, list_priority DESC, lead_priority DESC, attempts, lead_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `, [campaign.id, userId, userId]);
    row = rows[0] || null;
    if (row) {
      await conn.query("UPDATE dial_hopper SET status = 'locked', locked_at = NOW(), locked_by = ? WHERE id = ?", [owner, row.id]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[preview next failed]', err);
    return res.status(500).json({ error: 'failed to get next lead' });
  } finally {
    conn.release();
  }
  if (!row) return res.json({ lead: null, blocker: 'no leads waiting - the hopper is empty' });
  res.json({ lead: await previewLeadDetails(row) });
});

// Skip: lead leaves the hopper and isn't offered again for 15 minutes.
app.post('/agent/preview/skip', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const [held] = await pool.query('SELECT id, lead_id FROM dial_hopper WHERE locked_by = ?', [previewLockOwner(req.session.user.id)]);
  if (!held[0]) return res.status(404).json({ error: 'you have no preview lead' });
  await pool.query('DELETE FROM dial_hopper WHERE id = ?', [held[0].id]);
  await pool.query('UPDATE leads SET next_call_at = NOW() + INTERVAL 15 MINUTE WHERE id = ?', [held[0].lead_id]);
  res.json({ status: 'ok' });
});

// --- Admin: per-campaign dispositions ---
app.get('/admin/campaigns/:id/dispositions', requireRole('admin'), async (req, res) => {
  res.json(await getDispositions(Number(req.params.id)));
});

// Replaces the whole set. Leads keep whatever code they already have -
// a removed code just shows as its raw code in lists.
app.put('/admin/campaigns/:id/dispositions', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'campaign not found' });
  const { error, dispositions } = validateDispositions(req.body.dispositions);
  if (error) return res.status(400).json({ error });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await replaceDispositions(conn, req.params.id, dispositions);
    await conn.commit();
    res.json({ status: 'ok' });
  } catch (err) {
    await conn.rollback();
    console.error('[dispositions save failed]', err);
    res.status(500).json({ error: 'failed to save dispositions' });
  } finally {
    conn.release();
  }
});

// --- Agent: dispositions + callbacks for the campaign they're working ---
app.get('/agent/dispositions', requireAuth, async (req, res) => {
  const campaign = await findCurrentCampaign(req.session.user.id);
  res.json(await getDispositions(campaign ? campaign.id : null));
});

// Pending callbacks the agent should see: their own, plus "anyone"
// callbacks in the campaign they're currently working.
app.get('/agent/callbacks', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const campaign = await findCurrentCampaign(req.session.user.id);
  const [rows] = await pool.query(`
    SELECT cb.id, cb.lead_id, cb.callback_at, cb.note, cb.user_id, l.name, l.phone, c.name AS campaign_name
    FROM callbacks cb
    JOIN leads l ON l.id = cb.lead_id
    LEFT JOIN campaigns c ON c.id = cb.campaign_id
    WHERE cb.status = 'pending'
      AND (cb.user_id = ? OR (cb.user_id IS NULL AND cb.campaign_id = ?))
    ORDER BY cb.callback_at
    LIMIT 100
  `, [req.session.user.id, campaign ? campaign.id : -1]);
  res.json(rows);
});

app.get('/admin/callbacks', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT cb.id, cb.callback_at, cb.status, cb.note, l.name, l.phone, c.name AS campaign_name,
      u.username AS assigned_to, cu.username AS created_by_name
    FROM callbacks cb
    JOIN leads l ON l.id = cb.lead_id
    LEFT JOIN campaigns c ON c.id = cb.campaign_id
    LEFT JOIN users u ON u.id = cb.user_id
    JOIN users cu ON cu.id = cb.created_by
    ORDER BY cb.status = 'pending' DESC, cb.callback_at
    LIMIT 300
  `);
  res.json(rows);
});

app.post('/admin/callbacks/:id/cancel', requireRole('admin'), async (req, res) => {
  const [result] = await pool.query("UPDATE callbacks SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'no pending callback with that id' });
  res.json({ status: 'ok' });
});

// --- Admin: DNC list ---
app.get('/admin/dnc', requireRole('admin'), async (req, res) => {
  const q = normalizePhone(req.query.q || '');
  const [rows] = await pool.query(`
    SELECT d.id, d.phone, d.source, d.created_at, u.username AS created_by_name
    FROM dnc_numbers d LEFT JOIN users u ON u.id = d.created_by
    WHERE d.tenant_id = 1 ${q ? 'AND d.phone LIKE ?' : ''}
    ORDER BY d.id DESC LIMIT 500
  `, q ? [`%${q}%`] : []);
  const [count] = await pool.query('SELECT COUNT(*) AS cnt FROM dnc_numbers WHERE tenant_id = 1');
  res.json({ total: count[0].cnt, rows });
});

// Bulk add: one number per line (or comma-separated).
app.post('/admin/dnc', requireRole('admin'), async (req, res) => {
  const entries = String(req.body.phones || '').split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  if (entries.length === 0) return res.status(400).json({ error: 'enter at least one number' });
  if (entries.length > 5000) return res.status(400).json({ error: 'max 5000 numbers per add' });
  let added = 0;
  let existing = 0;
  let invalid = 0;
  for (const p of entries) {
    const n = normalizePhone(p);
    if (n.length < 3 || n.length > 15) { invalid++; continue; }
    if (await addDnc(n, 'manual', req.session.user.id)) added++;
    else existing++;
  }
  res.json({ added, existing, invalid });
});

app.delete('/admin/dnc/:id', requireRole('admin'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM dnc_numbers WHERE id = ? AND tenant_id = 1', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
  res.json({ status: 'ok' });
});

// --- Admin: teams (a group of agents + the campaigns they may work) ---
// Members and campaigns come back as id arrays so the edit form can
// pre-tick its checkboxes, plus names for the table.
app.get('/admin/teams', requireRole('admin'), async (req, res) => {
  const [teams] = await pool.query('SELECT * FROM teams ORDER BY id DESC');
  const [members] = await pool.query(
    'SELECT tm.team_id, u.id, u.username FROM team_members tm JOIN users u ON u.id = tm.user_id ORDER BY u.username'
  );
  const [campaigns] = await pool.query(
    'SELECT tc.team_id, c.id, c.name FROM team_campaigns tc JOIN campaigns c ON c.id = tc.campaign_id ORDER BY c.name'
  );
  res.json(teams.map((t) => ({
    ...t,
    members: members.filter((m) => m.team_id === t.id).map(({ id, username }) => ({ id, username })),
    campaigns: campaigns.filter((c) => c.team_id === t.id).map(({ id, name }) => ({ id, name })),
  })));
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
      const [result] = await conn.query(
        'INSERT INTO teams (tenant_id, name, status) VALUES (1, ?, ?)', [name, status || 'active']
      );
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

app.post('/admin/teams', requireRole('admin'), async (req, res) => {
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

app.put('/admin/teams/:id', requireRole('admin'), async (req, res) => {
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
app.delete('/admin/teams/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM teams WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'team not found' });
  await pool.query('DELETE FROM teams WHERE id = ?', [req.params.id]);
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

// --- Lead disposition: the actual outcome of a call, set by the agent
// right after it ends. What it does comes from the campaign's own
// disposition config: final (lead done), retry after N minutes, schedule a
// callback, and/or add the number to the DNC list (click2call then refuses it).
app.post('/leads/:id/disposition', requireAuth, async (req, res) => {
  const { status, callbackAt, callbackMine, note } = req.body;
  const [leadRows] = await pool.query('SELECT id, phone, campaign_id FROM leads WHERE id = ?', [req.params.id]);
  const lead = leadRows[0];
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  if (req.session.user.role === 'agent') {
    const campaign = await findCurrentCampaign(req.session.user.id);
    if (lead.campaign_id && (!campaign || campaign.id !== lead.campaign_id)) {
      return res.status(403).json({ error: 'that lead is not in your current campaign' });
    }
  }
  const dispositions = await getDispositions(lead.campaign_id);
  const d = dispositions.find((x) => x.code === status);
  if (!d) return res.status(400).json({ error: `status must be one of: ${dispositions.map((x) => x.code).join(', ')}` });

  let nextCallAt = null;
  let when = null;
  if (d.is_callback) {
    when = new Date(callbackAt);
    if (!callbackAt || Number.isNaN(when.getTime())) return res.status(400).json({ error: 'pick a callback date and time' });
    if (when < new Date(Date.now() - 60 * 1000)) return res.status(400).json({ error: 'callback time is in the past' });
    if (when > new Date(Date.now() + 90 * 24 * 3600 * 1000)) return res.status(400).json({ error: 'callback must be within 90 days' });
    nextCallAt = when;
  } else if (d.retry_after_min) {
    nextCallAt = new Date(Date.now() + d.retry_after_min * 60 * 1000);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'UPDATE leads SET status = ?, updated_by = ?, is_final = ?, next_call_at = ? WHERE id = ?',
      [d.code, req.session.user.id, d.is_final ? 1 : 0, nextCallAt, lead.id]
    );
    // Any earlier pending callback for this lead is now handled.
    await conn.query("UPDATE callbacks SET status = 'done' WHERE lead_id = ? AND status = 'pending'", [lead.id]);
    if (d.is_callback) {
      await conn.query(
        'INSERT INTO callbacks (tenant_id, lead_id, campaign_id, user_id, callback_at, note, created_by) VALUES (1, ?, ?, ?, ?, ?, ?)',
        [lead.id, lead.campaign_id, callbackMine ? req.session.user.id : null, when, note ? String(note).slice(0, 255) : null, req.session.user.id]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[disposition failed]', err);
    return res.status(500).json({ error: 'failed to save disposition' });
  } finally {
    conn.release();
  }
  if (d.marks_dnc) await addDnc(lead.phone, 'disposition', req.session.user.id);
  res.json({ status: 'ok' });
});

// --- Admin: full lead edit/delete (distinct from the agent-facing
// disposition endpoint above, which only ever touches status) ---
app.put('/admin/leads/:id', requireRole('admin'), async (req, res) => {
  const { name, phone, campaignId, listId, status } = req.body;
  if (!phone || !/^\+?[0-9]{7,15}$/.test(phone)) {
    return res.status(400).json({ error: 'a valid phone is required' });
  }
  if (status && status !== 'new') {
    const codes = (await getDispositions(campaignId || null)).map((x) => x.code);
    if (!codes.includes(status)) return res.status(400).json({ error: `status must be new or one of: ${codes.join(', ')}` });
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
  const [responseRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM form_responses WHERE lead_id = ?', [req.params.id]);
  if (responseRefs[0].cnt > 0) {
    return res.status(409).json({ error: `Cannot delete - ${responseRefs[0].cnt} form response(s) reference this lead.` });
  }
  const [callbackRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM callbacks WHERE lead_id = ?', [req.params.id]);
  if (callbackRefs[0].cnt > 0) {
    return res.status(409).json({ error: `Cannot delete - ${callbackRefs[0].cnt} callback(s) reference this lead.` });
  }

  await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

// --- Admin: lead upload (.xlsx or .csv) into a list ---
// Fixed columns every upload understands; on top of these, every field
// key of the list's campaign form is accepted and stored in custom_data.
const LEAD_BASE_COLUMNS = [
  { key: 'phone', required: true, help: 'Mobile/landline. +91, 0 and spaces are fine - stored as digits.' },
  { key: 'name', required: false, help: 'Customer name' },
  { key: 'alt_phone', required: false, help: 'Second number (optional)' },
  { key: 'priority', required: false, help: 'Whole number -100..100, higher is dialed first (default 0)' },
];
const MAX_IMPORT_ROWS = 20000;

// An Excel cell can be a plain value, a Date, rich text, a hyperlink or
// a formula - flatten all of them to the string a person sees.
function excelCellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return excelCellToString(v.result);
    if ('text' in v) return excelCellToString(v.text);
    return '';
  }
  return String(v);
}

// Returns { headers, rows: [{ rowNum, values: {header: string} }] } or { error }.
async function readLeadUpload(file) {
  const isXlsx = /\.xlsx$/i.test(file.originalname) || file.buffer.subarray(0, 2).toString() === 'PK';
  let table = [];
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer);
    } catch {
      return { error: 'could not read that Excel file - save it as .xlsx and try again' };
    }
    const ws = wb.worksheets[0];
    if (!ws) return { error: 'the Excel file has no sheets' };
    ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
      const cells = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(excelCellToString(row.getCell(c).value).trim());
      table.push({ rowNum, cells });
    });
  } else {
    const lines = file.buffer.toString('utf-8').replace(/^﻿/, '').split(/\r?\n/);
    table = lines.map((l, i) => ({ rowNum: i + 1, cells: parseCsvLine(l).map((c) => c.trim()) }))
      .filter((r) => r.cells.some((c) => c !== ''));
  }
  if (table.length < 2) return { error: 'the file has no data rows (row 1 must be the column headers)' };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { error: `max ${MAX_IMPORT_ROWS} rows per upload - split the file` };
  const headers = table[0].cells.map((h) => h.toLowerCase().trim());
  const rows = table.slice(1).map(({ rowNum, cells }) => ({
    rowNum,
    values: Object.fromEntries(headers.map((h, i) => [h, cells[i] || ''])),
  }));
  return { headers, rows };
}

// Lead data is pre-call information, so values are checked for type/choice
// like form answers, but "required" doesn't apply.
function parseLeadCustomValue(field, raw) {
  const opts = field.options || [];
  switch (field.field_type) {
    case 'number':
      return Number.isFinite(Number(raw)) ? { value: Number(raw) } : { error: 'must be a number' };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { value: raw } : { error: 'must be a date (YYYY-MM-DD)' };
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? { value: raw } : { error: 'must be an email' };
    case 'phone': {
      const n = normalizePhone(raw);
      return n.length >= 6 && n.length <= 15 ? { value: n } : { error: 'must be a phone number' };
    }
    case 'dropdown':
    case 'radio':
      return opts.includes(raw) ? { value: raw } : { error: `must be one of: ${opts.join(', ')}` };
    case 'checkbox': {
      const picked = raw.split(',').map((x) => x.trim()).filter(Boolean);
      const bad = picked.filter((x) => !opts.includes(x));
      return bad.length ? { error: `"${bad[0]}" is not one of: ${opts.join(', ')}` } : { value: picked };
    }
    default:
      return { value: raw };
  }
}

async function getCampaignFormFields(campaignId) {
  const [rows] = await pool.query('SELECT form_id FROM campaigns WHERE id = ?', [campaignId]);
  if (!rows[0] || !rows[0].form_id) return [];
  const [form] = await loadFormsWithFields('WHERE id = ?', [rows[0].form_id]);
  return form ? form.fields : [];
}

// Upload errors (e.g. too large) answered as JSON, not Express's HTML page.
function receiveLeadFile(req, res, next) {
  leadUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file is larger than 5 MB' : err.message });
  });
}

app.post('/admin/leads/import', requireRole('admin'), receiveLeadFile, async (req, res) => {
  const { listId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'choose an .xlsx or .csv file' });
  if (!listId) return res.status(400).json({ error: 'listId is required - create a list first' });
  const [listRows] = await pool.query('SELECT * FROM lists WHERE id = ?', [listId]);
  const list = listRows[0];
  if (!list) return res.status(400).json({ error: 'list not found' });
  const campaignId = list.campaign_id;

  const parsed = await readLeadUpload(req.file);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { headers, rows } = parsed;

  const fields = await getCampaignFormFields(campaignId);
  const known = new Set([...LEAD_BASE_COLUMNS.map((c) => c.key), ...fields.map((f) => f.field_key)]);
  if (!headers.includes('phone')) return res.status(400).json({ error: 'the file must have a "phone" column' });
  const unknown = headers.filter((h) => h && !known.has(h));
  if (unknown.length) {
    return res.status(400).json({
      error: `unknown column(s): ${unknown.join(', ')}. Allowed: ${[...known].join(', ')} - download the template for this list.`,
    });
  }

  // Duplicates and DNC compared on the normalised number, so "+91 98400
  // 12345" in the file matches "9840012345" already in the campaign.
  const [existingRows] = await pool.query('SELECT phone FROM leads WHERE campaign_id = ?', [campaignId]);
  const existing = new Set(existingRows.map((r) => normalizePhone(r.phone)));
  const [dncRows] = await pool.query('SELECT phone FROM dnc_numbers WHERE tenant_id = 1');
  const dnc = new Set(dncRows.map((r) => r.phone));

  const summary = { total: rows.length, imported: 0, duplicates: 0, dnc: 0, invalid: 0 };
  const errors = [];
  const toInsert = [];
  const rowError = (rowNum, reason) => {
    summary.invalid++;
    if (errors.length < 50) errors.push({ row: rowNum, reason });
  };

  for (const { rowNum, values } of rows) {
    const phone = normalizePhone(values.phone);
    if (phone.length < 7 || phone.length > 15) { rowError(rowNum, `invalid phone "${values.phone}"`); continue; }
    let altPhone = null;
    if (values.alt_phone) {
      altPhone = normalizePhone(values.alt_phone);
      if (altPhone.length < 7 || altPhone.length > 15) { rowError(rowNum, `invalid alt_phone "${values.alt_phone}"`); continue; }
    }
    let priority = 0;
    if (values.priority) {
      priority = Number(values.priority);
      if (!Number.isInteger(priority) || priority < -100 || priority > 100) { rowError(rowNum, 'priority must be a whole number -100..100'); continue; }
    }
    const custom = {};
    let bad = null;
    for (const f of fields) {
      const raw = values[f.field_key];
      if (!raw) continue;
      const r = parseLeadCustomValue(f, raw);
      if (r.error) { bad = `${f.field_key} ${r.error}`; break; }
      custom[f.field_key] = r.value;
    }
    if (bad) { rowError(rowNum, bad); continue; }
    if (dnc.has(phone)) { summary.dnc++; continue; }
    if (existing.has(phone)) { summary.duplicates++; continue; }
    existing.add(phone);
    toInsert.push([1, phone, altPhone, values.name || null, campaignId, list.id, priority,
      Object.keys(custom).length ? JSON.stringify(custom) : null]);
  }

  // One transaction, multi-row INSERTs in chunks - all or nothing, and
  // far fewer round-trips than one INSERT per lead.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < toInsert.length; i += 500) {
      await conn.query(
        'INSERT INTO leads (tenant_id, phone, alt_phone, name, campaign_id, list_id, priority, custom_data) VALUES ?',
        [toInsert.slice(i, i + 500)]
      );
    }
    await conn.commit();
    summary.imported = toInsert.length;
  } catch (err) {
    await conn.rollback();
    console.error('[lead import failed]', err);
    return res.status(500).json({ error: 'import failed - nothing was saved' });
  } finally {
    conn.release();
  }
  res.json({ ...summary, errors });
});

// Template built from the list's campaign form, so the columns always
// match what the import accepts. xlsx (default) adds an Instructions sheet.
app.get('/admin/leads/template', requireRole('admin'), async (req, res) => {
  let fields = [];
  let fileName = 'leads-template';
  if (req.query.listId) {
    const [rows] = await pool.query('SELECT l.name, l.campaign_id FROM lists l WHERE l.id = ?', [req.query.listId]);
    if (!rows[0]) return res.status(404).json({ error: 'list not found' });
    fields = await getCampaignFormFields(rows[0].campaign_id);
    fileName = `leads-${rows[0].name.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
  }
  const headers = [...LEAD_BASE_COLUMNS.map((c) => c.key), ...fields.map((f) => f.field_key)];
  const example = { phone: '9840012345', name: 'Ravi Kumar', alt_phone: '', priority: '0' };
  for (const f of fields) {
    const o = f.options || [];
    example[f.field_key] = { number: '50000', date: '2026-12-31', email: 'ravi@example.com', phone: '9840012346',
      dropdown: o[0], radio: o[0], checkbox: o.slice(0, 2).join(', ') }[f.field_type] || '';
  }

  if (req.query.format === 'csv') {
    const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.csv"`);
    return res.send(`${headers.join(',')}\n${headers.map((h) => esc(example[h] || '')).join(',')}\n`);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.addRow(headers).font = { bold: true };
  ws.addRow(headers.map((h) => example[h] || ''));
  ws.columns.forEach((col) => { col.width = 18; });
  ws.getColumn(1).numFmt = '@';  // keep phone numbers as text (no 9.84E+09)
  ws.getColumn(3).numFmt = '@';
  const info = wb.addWorksheet('Instructions');
  info.addRow(['Column', 'Required', 'Type', 'Allowed values / notes']).font = { bold: true };
  for (const c of LEAD_BASE_COLUMNS) info.addRow([c.key, c.required ? 'yes' : 'no', 'text', c.help]);
  for (const f of fields) {
    info.addRow([f.field_key, 'no', f.field_type,
      `${f.label}${(f.options || []).length ? ' - one of: ' + f.options.join(', ') : ''}${f.field_type === 'checkbox' ? ' (comma-separate several)' : ''}${f.field_type === 'date' ? ' (YYYY-MM-DD)' : ''}`]);
  }
  info.addRow([]);
  info.addRow(['Row 2 of the Leads sheet is an example - replace or delete it. Numbers on the DNC list and numbers already in the campaign are skipped.']);
  info.columns.forEach((col, i) => { col.width = [16, 10, 12, 70][i]; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// Old template URL kept working for bookmarks.
app.get('/admin/leads/csv-template', requireRole('admin'), (req, res) => res.redirect('/admin/leads/template?format=csv'));

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

  if (await isDnc(toNumber)) {
    return res.status(403).json({ error: 'this number is on the Do Not Call list' });
  }

  const campaign =
    req.session.user.role === 'agent' ? await findCurrentCampaign(req.session.user.id) : null;

  // Calling hours only apply to real outside calls through the trunk,
  // not to internal extension-to-extension test calls.
  const [extRows] = await pool.query('SELECT 1 FROM extensions WHERE name = ? LIMIT 1', [toNumber]);
  if (campaign && extRows.length === 0 && !isWithinCallWindow(campaign)) {
    return res.status(403).json({
      error: `outside this campaign's calling hours (${campaign.call_window_start.slice(0, 5)}-${campaign.call_window_end.slice(0, 5)} ${campaign.timezone})`,
    });
  }

  if (leadId) {
    const [inHopper] = await pool.query('SELECT locked_by FROM dial_hopper WHERE lead_id = ?', [leadId]);
    if (inHopper[0] && inHopper[0].locked_by && inHopper[0].locked_by !== previewLockOwner(req.session.user.id)) {
      return res.status(409).json({ error: 'another agent is previewing this lead right now' });
    }
    await pool.query('DELETE FROM dial_hopper WHERE lead_id = ?', [leadId]);
    await pool.query('UPDATE leads SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = ?', [leadId]);
  }

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
// Inbound calls are in the in-memory map; dialer calls are placed by the
// separate engine process, so they're found by channel name in the DB.
async function findQueueCall(channelName) {
  const callId = queueCallChannels.get(channelName);
  if (callId) return { callId, attemptId: null };
  if (!channelName) return null;
  const [rows] = await pool.query(
    'SELECT id, dial_attempt_id FROM calls WHERE channel_name = ? ORDER BY id DESC LIMIT 1', [channelName]
  );
  return rows[0] ? { callId: rows[0].id, attemptId: rows[0].dial_attempt_id } : null;
}

ami.on('AgentConnect', async (fields) => {
  try {
    const found = await findQueueCall(fields.Channel);
    if (!found) return;
    const { callId, attemptId } = found;
    const match = (fields.Interface || '').match(/PJSIP\/([^\s,]+)/i);
    const extensionName = match ? match[1] : null;
    if (!extensionName) return;
    // Dialer calls already have answer_time (when the customer picked up).
    await pool.query('UPDATE calls SET from_extension = ?, answer_time = COALESCE(answer_time, NOW()) WHERE id = ?', [extensionName, callId]);
    await logEvent(callId, 'agent_answered', { extensionName, interface: fields.Interface });
    if (attemptId) {
      await pool.query(
        "UPDATE dial_attempts SET status = 'connected', result = 'connected', connected_at = NOW(), agent_user_id = ? WHERE id = ? AND result IS NULL",
        [await findAgentIdByExtension(extensionName), attemptId]
      );
    }
  } catch (err) {
    console.error('[AMI AgentConnect handling error]', err);
  }
});

ami.on('AgentComplete', async (fields) => {
  try {
    const found = await findQueueCall(fields.Channel);
    if (!found) return;
    const { callId, attemptId } = found;
    queueCallChannels.delete(fields.Channel);
    if (attemptId) {
      await pool.query("UPDATE dial_attempts SET status = 'ended', ended_at = NOW() WHERE id = ?", [attemptId]);
    }
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
    const found = await findQueueCall(fields.Channel);
    if (!found) return;
    const { callId, attemptId } = found;
    queueCallChannels.delete(fields.Channel);
    await pool.query("UPDATE calls SET end_time = NOW(), disposition = 'abandoned' WHERE id = ?", [callId]);
    await logEvent(callId, 'abandoned', {});
    // Customer hung up while waiting for an agent.
    if (attemptId) await finishAttempt(pool, attemptId, 'customer_hangup', null);
  } catch (err) {
    console.error('[AMI QueueCallerAbandon handling error]', err);
  }
});

// Reported by the [dialer-answered] dialplan: no agent within the max
// wait (abandoned), or answering machine detected.
ami.on('UserEvent', async (fields) => {
  try {
    if (fields.UserEvent !== 'DialForgeDialer') return;
    const attemptId = Number(fields.Attempt);
    if (!attemptId || !['abandoned', 'machine'].includes(fields.Result)) return;
    if (await finishAttempt(pool, attemptId, fields.Result, null)) {
      const [[a]] = await pool.query('SELECT call_id FROM dial_attempts WHERE id = ?', [attemptId]);
      if (a && a.call_id) await logEvent(a.call_id, fields.Result, { queueStatus: fields.QueueStatus || null });
    }
  } catch (err) {
    console.error('[AMI UserEvent handling error]', err);
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
