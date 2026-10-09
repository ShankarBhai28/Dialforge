const pool = require('../../db');
const ari = require('../../ari');
const ami = require('../../ami');
const callControl = require('../../call-control');
const { finishAttempt } = require('../../dialer-common');
const { APP_NAME } = require('../config');
const { findAgentIdByExtension, setAgentStatus } = require('../services/agents');
const { logEvent, resolveDestination } = require('../services/calls');
const { activeCalls, queueCallChannels } = require('../state');

// Wires Asterisk events (ARI Stasis + AMI queue events) to our call tracking.
// Called once by server.js at startup - never from tests or scripts, since
// connecting a second process to ARI app "dialforge-app" would steal its calls.
function start() {
  // --- ARI event handling: drives the click-to-call flow above ---
  callControl.init({
    pool,
    ari,
    ami,
    logEvent,
    setAgentStatus,
    findAgentIdByExtension,
    resolveDestination,
    activeCalls,
    queueCallChannels,
    APP_NAME,
  });

  ari.connectEvents(APP_NAME, async (event) => {
    try {
      // Transfer / conference channels and calls are handled there.
      if (await callControl.onAriEvent(event)) return;
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
              [dialedNumber],
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
                `[DID routing] "${dialedNumber}" has no campaign mapping - falling back to campaign ${campaign.id}. Add it under Admin > Campaigns > DID Numbers.`,
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
            `INSERT INTO calls (tenant_id, direction, to_number, campaign_id, auto_answer, channel_name)
           VALUES (1, 'inbound', ?, ?, ?, ?)`,
            [callerNumber, campaign.id, campaign.auto_answer, event.channel.name],
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
              const [campRows] = await pool.query('SELECT outbound_caller_id FROM campaigns WHERE id = ?', [
                rows[0].campaign_id,
              ]);
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
            await pool.query("UPDATE calls SET end_time = NOW(), disposition = 'ended' WHERE id = ?", [callId]);
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
      'SELECT id, dial_attempt_id FROM calls WHERE channel_name = ? ORDER BY id DESC LIMIT 1',
      [channelName],
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
      await pool.query(
        'UPDATE calls SET from_extension = ?, agent_channel = ?, answer_time = COALESCE(answer_time, NOW()) WHERE id = ?',
        [extensionName, fields.DestChannel || null, callId],
      );
      await logEvent(callId, 'agent_answered', { extensionName, interface: fields.Interface });
      if (attemptId) {
        await pool.query(
          "UPDATE dial_attempts SET status = 'connected', result = 'connected', connected_at = NOW(), agent_user_id = ? WHERE id = ? AND result IS NULL",
          [await findAgentIdByExtension(extensionName), attemptId],
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
      // Taking a call over for transfer/conference ends its Queue() bridge -
      // that's not the call ending.
      if (callControl.isControlled(callId)) return;
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
      if (callControl.isControlled(callId)) return;
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
}

module.exports = { start };
