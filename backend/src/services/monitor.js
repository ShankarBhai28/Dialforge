// Supervisor call monitoring: listen, whisper, barge (Live Agents).
//
// The supervisor's browser is connected with their own extension (their
// "monitoring line", Users screen). Starting a monitor makes Asterisk call
// that line (auto-answered by the browser) into the df-monitor dialplan
// context (backend/asterisk/extensions-monitor.conf), which runs ChanSpy on
// the agent's channel. While listening, the supervisor switches mode with
// keys 4 / 5 / 6 (sent by the buttons on the monitoring bar).
const pool = require('../../db');
const ari = require('../../ari');
const ami = require('../../ami');
const { onActiveCall, openStatus } = require('./agentLogout');
const names = require('../telephony/names');

const MODES = ['listen', 'whisper', 'barge'];
// q: no beep, E: end with the agent's call, d: 4/5/6 switch modes, w / B: start mode.
const SPY_OPTIONS = { listen: 'qEd', whisper: 'qEdw', barge: 'qEdB' };
/** The keys that switch mode during a monitor (ChanSpy option d). */
const MODE_KEYS = { listen: '4', whisper: '5', barge: '6' };

class MonitorError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The supervisor's own (enabled) extension, or null. */
async function monitoringExtension(userId, deps = { pool }) {
  const [rows] = await deps.pool.query(
    'SELECT e.id, e.name, e.sip_password, e.enabled FROM users u JOIN extensions e ON e.id = u.extension_id WHERE u.id = ?',
    [userId],
  );
  return rows[0] && rows[0].enabled ? rows[0] : null;
}

/**
 * Starts a monitor. Throws MonitorError(status, reason) for anything the
 * supervisor can fix. `scope` = the caller's team scope (null = all).
 */
async function startMonitor({ supervisorId, agentId, mode, scope }, deps = { pool, ari, ami }) {
  if (!MODES.includes(mode)) throw new MonitorError(400, 'mode must be listen, whisper or barge');
  const [agents] = await deps.pool.query("SELECT id, username FROM users WHERE id = ? AND role = 'agent'", [agentId]);
  const agent = agents[0];
  if (!agent || (scope && !scope.agentIds.includes(agent.id))) throw new MonitorError(404, 'agent not found');
  const open = await openStatus(agent.id, deps);
  const agentExt = open && open.extension_name;
  if (!agentExt || !(await onActiveCall(agentExt, deps))) {
    throw new MonitorError(409, `${agent.username} is not on a call right now`);
  }
  const line = await monitoringExtension(supervisorId, deps);
  if (!line) {
    throw new MonitorError(409, 'you have no monitoring line - ask a Super Admin to give you an extension (Users)');
  }
  if (line.name === agentExt) throw new MonitorError(409, "you can't monitor your own line");
  const state = await deps.ari.endpointState(names.pjsip(line.name));
  if (state !== 'online') {
    throw new MonitorError(
      409,
      `your monitoring line ${line.name} isn't connected - press "Connect monitoring line" first`,
    );
  }
  try {
    await deps.ami.originate({
      channel: names.pjsip(line.name),
      context: 'df-monitor',
      exten: names.endpoint(agentExt),
      callerId: `"Monitor ${agent.username}" <${agentExt}>`,
      variables: { DF_SPY_OPTS: SPY_OPTIONS[mode] },
    });
  } catch (err) {
    // The app's AMI login needs the "originate" write right (manager.conf, DEPLOY.md §11).
    if (/permission denied/i.test(err.message)) {
      throw new MonitorError(
        500,
        'Asterisk refused to place the monitoring call: the AMI login lacks the "originate" right (manager.conf) - ask your admin',
      );
    }
    throw new MonitorError(502, `Asterisk couldn't start the monitoring call: ${err.message}`);
  }
  return { agent: agent.username, extension: agentExt, mode, line: line.name };
}

module.exports = { MODES, SPY_OPTIONS, MODE_KEYS, MonitorError, monitoringExtension, startMonitor };
