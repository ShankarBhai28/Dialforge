// Transfer and conference for live calls: blind transfer, warm (consult)
// transfer and conference, to another agent, a queue or an outside number.
//
// Everything here works on calls whose channels sit in a bridge OUR ARI
// app controls. Click-to-call calls already do (server.js bridges them);
// dialer and inbound calls were connected by Asterisk's native Queue(), so
// the first transfer/conference request "takes control" of them: AMI
// Redirect moves both legs into the [df-control] dialplan, which puts them
// into this app's Stasis, and we bridge them again ourselves.
//
// State lives in memory (like activeCalls in server.js): a backend restart
// mid-transfer leaves the channels talking in their bridge, but hanging up
// one side no longer hangs up the rest.
//
// A call's parties:
//   customer   - the person the call is about (always present)
//   agent      - the controlling agent (whose screen has the controls)
//   parties    - everyone else: a consult target (warm transfer), a blind
//                transfer target still ringing, conference members
// owner (calls.from_extension) is the agent the call belongs to - they
// get the outcome popup and after-call work when it ends.

const RING_TIMEOUT_SEC = 30;
const ADOPT_TIMEOUT_MS = 6000;

let d = null; // dependencies from server.js (pool, ari, ami, helpers)
const calls = new Map(); // callId -> state
const channelCall = new Map(); // channelId -> callId (every channel we manage)
const adopting = new Map(); // callId -> { cust, agent, resolve, reject, timer }
let partySeq = 0;

function init(deps) {
  d = deps;
}

// Queue events (AgentComplete etc.) must ignore calls we've taken over -
// taking control breaks the Queue() bridge, which looks like a call end.
function isControlled(callId) {
  return calls.has(Number(callId)) || adopting.has(Number(callId));
}

const quiet = (p) => Promise.resolve(p).catch(() => {});

function stateForAgent(ext) {
  for (const st of calls.values()) if (st.agent && st.agent.ext === ext) return st;
  return null;
}

// The call this agent is on right now (DB view - works before we control it).
async function currentCallId(ext) {
  const [rows] = await d.pool.query(
    `SELECT id FROM calls WHERE from_extension = ? AND end_time IS NULL
       AND start_time > NOW() - INTERVAL 3 HOUR ORDER BY id DESC LIMIT 1`,
    [ext],
  );
  return rows[0] ? rows[0].id : null;
}

function newState(callId, row, { bridgeId, customer, customerName, agentChannel, agentExt }) {
  const st = {
    callId,
    bridgeId,
    holdBridgeId: null,
    ringPlaybackId: null,
    customer,
    customerName,
    customerNumber: row.to_number,
    campaignId: row.campaign_id,
    attemptId: row.dial_attempt_id,
    agent: { channelId: agentChannel, ext: agentExt },
    ownerExt: agentExt,
    parties: new Map(),
  };
  calls.set(callId, st);
  channelCall.set(customer, callId);
  channelCall.set(agentChannel, callId);
  return st;
}

// --- Taking control of a call ---
async function takeControl(ext) {
  const existing = stateForAgent(ext);
  if (existing) return existing;
  const callId = await currentCallId(ext);
  if (!callId) throw httpError(409, 'you are not on a call');
  const [[row]] = await d.pool.query(
    'SELECT id, to_number, campaign_id, dial_attempt_id, channel_name, agent_channel FROM calls WHERE id = ?',
    [callId],
  );

  const c2c = d.activeCalls.get(callId);
  if (c2c) {
    // Click-to-call: already bridged by our app - just take the bookkeeping over.
    if (!c2c.bridgeId || !c2c.destChannelId) throw httpError(409, 'wait until the customer answers');
    d.activeCalls.delete(callId);
    const ch = await d.ari.getChannel(c2c.destChannelId);
    return newState(callId, row, {
      bridgeId: c2c.bridgeId,
      customer: c2c.destChannelId,
      customerName: ch ? ch.name : null,
      agentChannel: c2c.agentChannelId,
      agentExt: ext,
    });
  }

  if (!row.channel_name || !row.agent_channel) {
    throw httpError(
      409,
      "this call can't be transferred (its channels are unknown - was it answered before the last restart?)",
    );
  }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      adopting.delete(callId);
      reject(httpError(504, 'taking over the call timed out'));
    }, ADOPT_TIMEOUT_MS);
    adopting.set(callId, { cust: null, agent: null, resolve, reject, timer, row, ext });
  });
  try {
    await d.ami.redirect(
      row.channel_name,
      { context: 'df-control', exten: `cus${callId}` },
      { channel: row.agent_channel, context: 'df-control', exten: `agt${callId}` },
    );
  } catch (err) {
    const a = adopting.get(callId);
    if (a) {
      clearTimeout(a.timer);
      adopting.delete(callId);
    }
    throw httpError(502, 'could not take over the call: ' + err.message);
  }
  await d.logEvent(callId, 'control_taken', { by: ext });
  return ready;
}

async function onAdoptStart(event) {
  const callId = Number(event.args[1]);
  const leg = event.args[2];
  const a = adopting.get(callId);
  if (!a) {
    await quiet(d.ari.hangup(event.channel.id));
    return;
  }
  if (leg === 'cust') {
    a.cust = event.channel.id;
    a.custName = event.channel.name;
  } else a.agent = event.channel.id;
  if (!a.cust || !a.agent) return;
  clearTimeout(a.timer);
  adopting.delete(callId);
  try {
    const bridge = await d.ari.createBridge();
    await d.ari.addChannelToBridge(bridge.id, a.cust);
    await d.ari.addChannelToBridge(bridge.id, a.agent);
    a.resolve(
      newState(callId, a.row, {
        bridgeId: bridge.id,
        customer: a.cust,
        customerName: a.custName,
        agentChannel: a.agent,
        agentExt: a.ext,
      }),
    );
  } catch (err) {
    a.reject(httpError(502, 'could not re-bridge the call: ' + err.message));
  }
}

// --- Targets ---
// Resolves what the agent picked into something we can dial.
async function resolveTarget(st, { targetType, target }, mode, me) {
  if (targetType === 'agent') {
    const agent = await agentByUserId(Number(target));
    if (!agent) throw httpError(404, 'that agent is not logged in');
    if (agent.ext === me) throw httpError(400, "you can't transfer to yourself");
    if (!(await d.ari.isEndpointOnline(`PJSIP/${agent.ext}`)))
      throw httpError(409, `${agent.username}'s phone is not connected`);
    if (agent.busy) throw httpError(409, `${agent.username} is on another call`);
    return agentTarget(st, agent, agent.username);
  }
  if (targetType === 'queue') {
    const [[q]] = await d.pool.query(
      `SELECT q.id, q.name, q.asterisk_name, c.id AS campaign_id FROM queues q
       JOIN campaigns c ON c.queue_id = q.id
       WHERE q.id = ? AND q.status = 'active' LIMIT 1`,
      [Number(target)],
    );
    if (!q) throw httpError(404, 'queue not found');
    if (mode === 'blind') return { kind: 'queue', queue: q, label: q.name };
    // Warm / conference need someone to talk to now: pick a free agent in it.
    const free = (await listAgents(me)).filter((a) => a.queueId === q.id && !a.busy && a.status === 'available');
    for (const a of free) {
      if (await d.ari.isEndpointOnline(`PJSIP/${a.ext}`)) return agentTarget(st, a, `${a.username} (${q.name})`);
    }
    throw httpError(409, `no free agent in ${q.name} right now - use a blind transfer to queue the customer`);
  }
  if (targetType === 'number') {
    const number = String(target || '').replace(/[^\d]/g, '');
    if (number.length < 3 || number.length > 15) throw httpError(400, 'enter a valid number');
    const [[camp]] = await d.pool.query('SELECT outbound_caller_id FROM campaigns WHERE id = ?', [st.campaignId || 0]);
    const { endpoint, callerId } = await d.resolveDestination(number, camp ? camp.outbound_caller_id : null);
    return { kind: 'number', endpoint, callerId, label: number };
  }
  throw httpError(400, 'targetType must be agent, queue or number');
}

function agentTarget(st, agent, label) {
  // The receiving agent sees the customer's number as the caller.
  return {
    kind: 'agent',
    ext: agent.ext,
    endpoint: `PJSIP/${agent.ext}`,
    callerId: `"Transfer" <${st.customerNumber || ''}>`,
    label,
  };
}

// Logged-in agents (an open, non-offline status row) and whether they're
// on a call right now.
async function listAgents(excludeExt) {
  const [rows] = await d.pool.query(
    `SELECT u.id AS userId, u.username, asl.extension_name AS ext, asl.status, asl.queue_id AS queueId,
       EXISTS (SELECT 1 FROM calls c WHERE (c.from_extension = asl.extension_name OR c.transfer_ext = asl.extension_name)
               AND c.end_time IS NULL AND c.start_time > NOW() - INTERVAL 3 HOUR) AS busy
     FROM agent_status_log asl JOIN users u ON u.id = asl.user_id
     WHERE asl.ended_at IS NULL AND asl.status <> 'offline' AND asl.extension_name IS NOT NULL
       AND u.role = 'agent' AND asl.extension_name <> ?
     ORDER BY u.username`,
    [excludeExt || ''],
  );
  return rows.map((r) => ({ ...r, busy: !!Number(r.busy) }));
}

async function agentByUserId(userId) {
  return (await listAgents(null)).find((a) => a.userId === userId) || null;
}

// --- Dialing a new party into the call ---
async function dialParty(st, target, role) {
  const channelId = `dfx-${st.callId}-${++partySeq}`;
  st.parties.set(channelId, {
    id: channelId,
    label: target.label,
    kind: target.kind,
    ext: target.ext || null,
    state: 'ringing',
    role,
  });
  channelCall.set(channelId, st.callId);
  if (target.ext) await d.pool.query('UPDATE calls SET transfer_ext = ? WHERE id = ?', [target.ext, st.callId]);
  try {
    await d.ari.originate({
      endpoint: target.endpoint,
      app: d.APP_NAME,
      appArgs: `xfer,${st.callId}`,
      callerId: target.callerId,
      timeout: RING_TIMEOUT_SEC,
      channelId,
    });
  } catch (err) {
    st.parties.delete(channelId);
    channelCall.delete(channelId);
    if (target.ext) await d.pool.query('UPDATE calls SET transfer_ext = NULL WHERE id = ?', [st.callId]);
    throw httpError(502, `could not call ${target.label}: ${err.message}`);
  }
  await d.logEvent(st.callId, 'party_dialed', { role, label: target.label, kind: target.kind });
  return channelId;
}

async function startRingback(st) {
  st.ringPlaybackId = `dfr-${st.callId}-${++partySeq}`;
  await quiet(d.ari.playOnBridge(st.bridgeId, 'tone:ring;tonezone=in', st.ringPlaybackId));
}

async function stopRingback(st) {
  if (!st.ringPlaybackId) return;
  const id = st.ringPlaybackId;
  st.ringPlaybackId = null;
  await quiet(d.ari.stopPlayback(id));
}

// Customer to a holding bridge (music on hold) / back to the main bridge.
async function parkCustomer(st) {
  if (st.holdBridgeId) return;
  const hold = await d.ari.createBridge('holding');
  st.holdBridgeId = hold.id;
  await quiet(d.ari.removeChannelFromBridge(st.bridgeId, st.customer));
  await d.ari.addChannelToBridge(hold.id, st.customer);
  await quiet(d.ari.startBridgeMoh(hold.id));
}

async function unparkCustomer(st) {
  if (!st.holdBridgeId) return;
  const hold = st.holdBridgeId;
  st.holdBridgeId = null;
  await quiet(d.ari.removeChannelFromBridge(hold, st.customer));
  await quiet(d.ari.addChannelToBridge(st.bridgeId, st.customer));
  await quiet(d.ari.destroyBridge(hold));
}

// A dialed party answered.
async function onPartyStart(event) {
  const callId = Number(event.args[1]);
  const st = calls.get(callId);
  const p = st && st.parties.get(event.channel.id);
  if (!p) {
    await quiet(d.ari.hangup(event.channel.id));
    return;
  }
  p.state = 'up';
  await d.logEvent(callId, 'party_answered', { role: p.role, label: p.label });
  if (p.role === 'blind') {
    await quiet(d.ari.stopBridgeMoh(st.bridgeId));
    await d.ari.addChannelToBridge(st.bridgeId, p.id);
    p.role = 'member';
    if (p.kind === 'agent') await promoteToController(st, p);
  } else {
    await stopRingback(st);
    await d.ari.addChannelToBridge(st.bridgeId, p.id);
    if (p.role === 'conference') p.role = 'member'; // warm stays 'warm' until complete/merge
  }
}

// --- What the agent can do ---
async function transfer(me, { mode, targetType, target }) {
  if (!['blind', 'warm', 'conference'].includes(mode)) throw httpError(400, 'mode must be blind, warm or conference');
  const st = await takeControl(me);
  if (st.agent.ext !== me) throw httpError(403, 'only the agent handling the call can do this');
  if ([...st.parties.values()].some((p) => p.role === 'warm' || p.role === 'blind' || p.state === 'ringing')) {
    throw httpError(409, 'finish the transfer in progress first');
  }
  const t = await resolveTarget(st, { targetType, target }, mode, me);

  if (mode === 'blind') {
    if (t.kind === 'queue') {
      if (st.parties.size) throw httpError(409, 'drop the other conference members before transferring to a queue');
      await blindToQueue(st, t.queue);
      return { status: 'transferred', to: t.label };
    }
    // Ring the target first (if that fails the agent is still connected),
    // then drop the agent - the customer hears music until the target answers.
    await dialParty(st, t, 'blind');
    await d.ari.startBridgeMoh(st.bridgeId).catch(() => {});
    await agentLeaves(st, { hangup: true, reason: 'blind_transfer' });
    return { status: 'transferring', to: t.label };
  }
  if (mode === 'warm') {
    await parkCustomer(st);
    try {
      await dialParty(st, t, 'warm');
    } catch (err) {
      await unparkCustomer(st);
      throw err;
    }
    await startRingback(st);
    return { status: 'consulting', to: t.label };
  }
  await dialParty(st, t, 'conference');
  await startRingback(st);
  return { status: 'adding', to: t.label };
}

function consultOf(st) {
  return [...st.parties.values()].find((p) => p.role === 'warm') || null;
}

async function controlledBy(me) {
  const st = stateForAgent(me);
  if (!st) throw httpError(409, 'no transfer or conference in progress');
  return st;
}

// Warm transfer: hand the customer to the consulted person and leave.
async function completeTransfer(me) {
  const st = await controlledBy(me);
  const c = consultOf(st);
  if (!c) throw httpError(409, 'no transfer in progress');
  if (c.state !== 'up') {
    // Still ringing: finish it as a blind transfer.
    await stopRingback(st);
    await unparkCustomer(st);
    c.role = 'blind';
    await d.ari.startBridgeMoh(st.bridgeId).catch(() => {});
    await agentLeaves(st, { hangup: true, reason: 'blind_transfer' });
    return { status: 'transferring' };
  }
  await unparkCustomer(st);
  c.role = 'member';
  await d.logEvent(st.callId, 'transfer_completed', { to: c.label });
  if (c.kind === 'agent') await promoteToController(st, c);
  await agentLeaves(st, { hangup: true, reason: 'warm_transfer' });
  return { status: 'transferred' };
}

// Warm transfer -> 3-way: customer joins the agent and the consulted person.
async function merge(me) {
  const st = await controlledBy(me);
  const c = consultOf(st);
  if (!c || c.state !== 'up') throw httpError(409, 'wait until they answer');
  await unparkCustomer(st);
  c.role = 'member';
  await d.logEvent(st.callId, 'conference_merged', { with: c.label });
  return { status: 'conference' };
}

// Warm transfer cancelled: drop the consulted person, back to the customer.
async function cancelConsult(me) {
  const st = await controlledBy(me);
  const c = consultOf(st);
  if (!c) throw httpError(409, 'no transfer in progress');
  await dropPartyChannel(st, c, 'cancelled');
  return { status: 'back_to_customer' };
}

async function dropParty(me, channelId) {
  const st = await controlledBy(me);
  const p = st.parties.get(channelId);
  if (!p) throw httpError(404, 'not on this call');
  await dropPartyChannel(st, p, 'dropped');
  return { status: 'dropped' };
}

// Agent leaves a conference; the others keep talking.
async function leave(me) {
  const st = await controlledBy(me);
  const others = [...st.parties.values()].filter((p) => p.state === 'up' && p.role === 'member');
  if (!others.length) throw httpError(409, 'nobody else is on the call - just hang up');
  await agentLeaves(st, { hangup: true, reason: 'left_conference' });
  return { status: 'left' };
}

// --- Leaving / ending ---
async function dropPartyChannel(st, p, reason) {
  st.parties.delete(p.id);
  channelCall.delete(p.id);
  await quiet(d.ari.hangup(p.id));
  await afterPartyGone(st, p, reason);
}

async function afterPartyGone(st, p, reason) {
  await d.logEvent(st.callId, 'party_left', { label: p.label, role: p.role, reason });
  if (p.ext)
    await d.pool.query('UPDATE calls SET transfer_ext = NULL WHERE id = ? AND transfer_ext = ?', [st.callId, p.ext]);
  if (p.state === 'ringing') await stopRingback(st);

  if (p.role === 'warm') {
    await unparkCustomer(st);
    return;
  } // back to the customer
  if (p.role === 'blind') {
    // Nobody answered the blind transfer: put the customer back in the
    // campaign's own queue rather than leaving them on hold music.
    await quiet(d.ari.stopBridgeMoh(st.bridgeId));
    const [[q]] = await d.pool.query(
      `SELECT q.id, q.name, q.asterisk_name, c.id AS campaign_id FROM campaigns c JOIN queues q ON q.id = c.queue_id WHERE c.id = ?`,
      [st.campaignId || 0],
    );
    if (q && !st.agent) {
      await blindToQueue(st, q);
      return;
    }
    if (!st.agent) {
      await endCall(st, 'transfer_failed');
      return;
    }
    return;
  }
  if (p.kind === 'agent' && p.ext === st.ownerExt) await afterCallWork(p.ext);
  // Only the customer left with nobody to talk to -> end.
  if (!st.agent && ![...st.parties.values()].some((x) => x.state === 'up')) await endCall(st, 'everyone_left');
}

// The controlling agent goes; if a member agent remains they take over.
async function agentLeaves(st, { hangup, reason }) {
  const a = st.agent;
  if (!a) return;
  st.agent = null;
  channelCall.delete(a.channelId);
  await quiet(d.ari.removeChannelFromBridge(st.bridgeId, a.channelId));
  if (hangup) await quiet(d.ari.hangup(a.channelId));
  await d.logEvent(st.callId, 'agent_left', { ext: a.ext, reason });
  const next = [...st.parties.values()].find((p) => p.kind === 'agent' && p.state === 'up' && p.role === 'member');
  if (next) await promoteToController(st, next);
  await afterCallWork(a.ext);
  if (!st.agent && ![...st.parties.values()].some((x) => x.state === 'up' || x.role === 'blind')) {
    await endCall(st, 'agent_left');
  }
}

// An agent party becomes the call's controlling agent and owner (their
// screen gets the controls, the outcome popup and after-call work).
async function promoteToController(st, p) {
  if (st.agent) {
    // The current controller stays until they leave; ownership moves now.
  } else {
    st.agent = { channelId: p.id, ext: p.ext };
    st.parties.delete(p.id);
  }
  st.ownerExt = p.ext;
  const userId = await d.findAgentIdByExtension(p.ext);
  await d.pool.query('UPDATE calls SET from_extension = ?, transfer_ext = NULL WHERE id = ?', [p.ext, st.callId]);
  if (st.attemptId)
    await d.pool.query('UPDATE dial_attempts SET agent_user_id = ? WHERE id = ?', [userId, st.attemptId]);
  await d.logEvent(st.callId, 'transferred', { to: p.ext });
}

async function blindToQueue(st, q) {
  await agentLeavesQuietly(st);
  for (const p of st.parties.values()) {
    channelCall.delete(p.id);
    await quiet(d.ari.hangup(p.id));
  }
  calls.delete(st.callId);
  channelCall.delete(st.customer);
  if (st.holdBridgeId) await quiet(d.ari.removeChannelFromBridge(st.holdBridgeId, st.customer));
  await quiet(d.ari.removeChannelFromBridge(st.bridgeId, st.customer));
  await quiet(d.ari.destroyBridge(st.bridgeId));
  if (st.holdBridgeId) await quiet(d.ari.destroyBridge(st.holdBridgeId));
  // From here it's a normal queue call again - the AMI handlers in
  // server.js record who answers and when it ends.
  if (st.customerName) d.queueCallChannels.set(st.customerName, st.callId);
  await d.pool.query(
    'UPDATE calls SET from_extension = NULL, agent_channel = NULL, transfer_ext = NULL, campaign_id = ? WHERE id = ?',
    [q.campaign_id, st.callId],
  );
  await d.ari.setChannelVar(st.customer, 'QUEUENAME', q.asterisk_name);
  await d.ari.continueInDialplan(st.customer, { context: 'queue-dispatch', extension: 's', priority: 1 });
  await d.logEvent(st.callId, 'transferred_to_queue', { queue: q.name });
}

async function agentLeavesQuietly(st) {
  const a = st.agent;
  if (!a) return;
  st.agent = null;
  channelCall.delete(a.channelId);
  await quiet(d.ari.removeChannelFromBridge(st.bridgeId, a.channelId));
  await quiet(d.ari.hangup(a.channelId));
  await d.logEvent(st.callId, 'agent_left', { ext: a.ext, reason: 'transfer_to_queue' });
  await afterCallWork(a.ext);
}

async function endCall(st, reason) {
  if (!calls.has(st.callId)) return;
  calls.delete(st.callId);
  const agentExts = new Set();
  if (st.agent) agentExts.add(st.agent.ext);
  for (const p of st.parties.values()) if (p.kind === 'agent' && p.state === 'up') agentExts.add(p.ext);
  const channels = [st.customer, st.agent && st.agent.channelId, ...st.parties.keys()].filter(Boolean);
  channels.forEach((c) => channelCall.delete(c));
  for (const c of channels) await quiet(d.ari.hangup(c));
  await quiet(d.ari.destroyBridge(st.bridgeId));
  if (st.holdBridgeId) await quiet(d.ari.destroyBridge(st.holdBridgeId));
  await d.pool.query(
    "UPDATE calls SET end_time = NOW(), disposition = 'ended', transfer_ext = NULL WHERE id = ? AND end_time IS NULL",
    [st.callId],
  );
  if (st.attemptId)
    await d.pool.query("UPDATE dial_attempts SET status = 'ended', ended_at = COALESCE(ended_at, NOW()) WHERE id = ?", [
      st.attemptId,
    ]);
  await d.logEvent(st.callId, 'ended', { reason });
  for (const ext of agentExts) await afterCallWork(ext);
}

async function afterCallWork(ext) {
  const userId = await d.findAgentIdByExtension(ext);
  if (userId) await quiet(d.setAgentStatus(userId, 'acw', null, null, ext));
}

// A managed channel hung up / was destroyed.
async function onChannelGone(channelId) {
  const callId = channelCall.get(channelId);
  if (!callId) return false;
  channelCall.delete(channelId);
  const st = calls.get(callId);
  if (!st) return true;
  if (channelId === st.customer) {
    await endCall(st, 'customer_hangup');
    return true;
  }
  if (st.agent && channelId === st.agent.channelId) {
    const c = consultOf(st);
    if (c) {
      // Agent hung up during a warm transfer = complete it.
      channelCall.set(channelId, callId); // agentLeaves expects to remove it
      await stopRingback(st);
      await unparkCustomer(st);
      c.role = c.state === 'up' ? 'member' : 'blind';
      if (c.state === 'up' && c.kind === 'agent') await promoteToController(st, c);
      if (c.role === 'blind') await d.ari.startBridgeMoh(st.bridgeId).catch(() => {});
      await agentLeaves(st, { hangup: false, reason: 'hung_up_during_transfer' });
    } else {
      channelCall.set(channelId, callId);
      await agentLeaves(st, { hangup: false, reason: 'hung_up' });
    }
    return true;
  }
  const p = st.parties.get(channelId);
  if (p) {
    st.parties.delete(channelId);
    await afterPartyGone(st, p, 'hung_up');
  }
  return true;
}

// Called first by server.js's ARI handler; true = handled here.
async function onAriEvent(event) {
  if (event.type === 'StasisStart') {
    const tag = event.args && event.args[0];
    if (tag === 'adopt') {
      await onAdoptStart(event);
      return true;
    }
    if (tag === 'xfer') {
      await onPartyStart(event);
      return true;
    }
    return false;
  }
  if (event.type === 'StasisEnd' || event.type === 'ChannelDestroyed') {
    return onChannelGone(event.channel.id);
  }
  return false;
}

// What the agent's in-call panel shows.
function viewFor(me) {
  const st = stateForAgent(me);
  if (!st) return { controlled: false };
  return {
    controlled: true,
    callId: st.callId,
    customerOnHold: !!st.holdBridgeId,
    parties: [...st.parties.values()].map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      state: p.state,
      role: p.role,
    })),
  };
}

async function transferTargets(me) {
  const agents = await listAgents(me);
  const [queues] = await d.pool.query(
    `SELECT q.id, q.name, c.name AS campaign_name FROM queues q JOIN campaigns c ON c.queue_id = q.id
     WHERE q.status = 'active' AND c.status = 'active' ORDER BY q.name`,
  );
  return {
    agents: agents.map((a) => ({
      userId: a.userId,
      username: a.username,
      ext: a.ext,
      status: a.busy ? 'on a call' : a.status,
    })),
    queues: queues.map((q) => ({
      id: q.id,
      name: q.name,
      campaign: q.campaign_name,
      freeAgents: agents.filter((a) => a.queueId === q.id && !a.busy && a.status === 'available').length,
    })),
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  init,
  isControlled,
  onAriEvent,
  viewFor,
  transferTargets,
  transfer,
  completeTransfer,
  merge,
  cancelConsult,
  dropParty,
  leave,
};
