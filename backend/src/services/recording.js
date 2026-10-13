// Call recording.
//
// When a customer is connected to an agent, the backend asks Asterisk (AMI
// MixMonitor) to record the CUSTOMER's channel: both directions, and it
// follows the customer through transfers and conferences. Option b = only
// while bridged (no ringing / waiting in queue). When the call ends,
// Asterisk runs /usr/local/bin/dialforge-recording-done, which turns the
// WAV into an MP3. calls.recording_path holds the MP3 path; playback falls
// back to the WAV if the conversion didn't happen.
//
// Recorded: calls of campaigns with record_calls = 1 (the default), and
// calls without a campaign unless RECORD_CALLS_WITHOUT_CAMPAIGN=0.
// Files: /var/spool/asterisk/monitor/dialforge/YYYY/MM/DD/call-<id>-<time>.mp3,
// removed after RECORDING_RETENTION_DAYS (ops/backup.sh).
const fs = require('fs');
const path = require('path');
const pool = require('../../db');
const ami = require('../../ami');

const BASE = process.env.RECORDINGS_DIR || '/var/spool/asterisk/monitor/dialforge';
const DONE_COMMAND = '/usr/local/bin/dialforge-recording-done';

/** call-42-20261013-101500 in YYYY/MM/DD (UTC). */
function recordingBase(callId, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${now.getUTCFullYear()}/${p(now.getUTCMonth() + 1)}/${p(now.getUTCDate())}`;
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return path.posix.join(BASE, day, `call-${Number(callId)}-${stamp}`);
}

async function shouldRecord(campaignId, deps = { pool }) {
  if (!campaignId) return process.env.RECORD_CALLS_WITHOUT_CAMPAIGN !== '0';
  const [rows] = await deps.pool.query('SELECT record_calls FROM campaigns WHERE id = ?', [campaignId]);
  return !rows[0] || !!rows[0].record_calls;
}

/**
 * Starts recording a call on the customer's channel (channel NAME, as AMI
 * knows it). Never throws: a recording problem must not affect the call.
 */
async function startRecording({ callId, channelName, campaignId }, deps = { pool, ami, now: () => new Date() }) {
  try {
    if (!channelName) return null;
    const [rows] = await deps.pool.query('SELECT campaign_id, recording_path FROM calls WHERE id = ?', [callId]);
    // Already recording: it follows the customer's channel through
    // transfers, so a second agent taking the call doesn't start another.
    if (rows[0] && rows[0].recording_path) return null;
    if (campaignId === undefined) campaignId = rows[0] ? rows[0].campaign_id : null;
    if (!(await shouldRecord(campaignId, deps))) return null;
    const base = recordingBase(callId, deps.now());
    await deps.ami.mixMonitor({
      channel: channelName,
      file: `${base}.wav`,
      options: 'b',
      command: `${DONE_COMMAND} ${base}.wav`,
    });
    // Only the first recording of a call is kept as "the" recording.
    await deps.pool.query('UPDATE calls SET recording_path = ? WHERE id = ? AND recording_path IS NULL', [
      `${base}.mp3`,
      callId,
    ]);
    return `${base}.mp3`;
  } catch (err) {
    console.error(`[recording] call ${callId}: ${err.message}`);
    return null;
  }
}

/**
 * The file to play for a stored recording path: the MP3, else the WAV it
 * came from (conversion pending / failed). Null when gone (retention) or
 * outside the recordings folder (never serve anything else).
 */
function playableFile(recordingPath, exists = fs.existsSync) {
  if (!recordingPath) return null;
  const resolved = path.posix.resolve(recordingPath);
  if (!resolved.startsWith(BASE + '/')) return null;
  if (exists(resolved)) return { file: resolved, type: 'audio/mpeg' };
  const wav = resolved.replace(/\.mp3$/, '.wav');
  if (exists(wav)) return { file: wav, type: 'audio/wav' };
  return null;
}

module.exports = { BASE, recordingBase, shouldRecord, startRecording, playableFile };
