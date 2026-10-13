// Call recording: when a recording starts, where it goes, and what may be played.
const assert = require('node:assert');
const { test } = require('node:test');
const { BASE, playableFile, recordingBase, startRecording } = require('../src/services/recording');

const NOW = new Date('2026-10-13T10:15:07Z');
function deps({ recordCalls = 1, existing = null, campaignId = 4, failAmi = false } = {}) {
  const sql = [];
  const mixed = [];
  return {
    sql,
    mixed,
    now: () => NOW,
    ami: {
      mixMonitor: async (o) => {
        if (failAmi) throw new Error('AMI not ready');
        mixed.push(o);
      },
    },
    pool: {
      async query(s, p) {
        sql.push([s, p]);
        if (s.startsWith('SELECT campaign_id, recording_path FROM calls'))
          return [[{ campaign_id: campaignId, recording_path: existing }]];
        if (s.startsWith('SELECT record_calls FROM campaigns')) return [[{ record_calls: recordCalls }]];
        return [{ affectedRows: 1 }];
      },
    },
  };
}

test('file name: by day, call id and time', () => {
  assert.strictEqual(recordingBase(42, NOW), `${BASE}/2026/10/13/call-42-20261013-101507`);
});

test("records the customer's channel, only while bridged, converts to MP3 afterwards", async () => {
  const d = deps();
  const file = await startRecording({ callId: 42, channelName: 'PJSIP/dialforge-nxtra1-0000002a' }, d);
  assert.strictEqual(file, `${BASE}/2026/10/13/call-42-20261013-101507.mp3`);
  assert.deepStrictEqual(d.mixed[0], {
    channel: 'PJSIP/dialforge-nxtra1-0000002a',
    file: `${BASE}/2026/10/13/call-42-20261013-101507.wav`,
    options: 'b',
    command: `/usr/local/bin/dialforge-recording-done ${BASE}/2026/10/13/call-42-20261013-101507.wav`,
  });
  assert.ok(d.sql.some(([s, p]) => /UPDATE calls SET recording_path/.test(s) && p[0] === file && p[1] === 42));
});

test('not recorded: campaign switched off, already recording (transfer), or no channel', async () => {
  for (const d of [deps({ recordCalls: 0 }), deps({ existing: '/x.mp3' })]) {
    assert.strictEqual(await startRecording({ callId: 42, channelName: 'PJSIP/x-1' }, d), null);
    assert.strictEqual(d.mixed.length, 0);
  }
  assert.strictEqual(await startRecording({ callId: 42, channelName: null }, deps()), null);
});

test('a recording problem never breaks the call', async () => {
  assert.strictEqual(await startRecording({ callId: 42, channelName: 'PJSIP/x-1' }, deps({ failAmi: true })), null);
});

test('playback: the MP3, else the WAV; nothing outside the recordings folder; null when gone', () => {
  const mp3 = `${BASE}/2026/10/13/call-42-x.mp3`;
  assert.deepStrictEqual(
    playableFile(mp3, (f) => f === mp3),
    { file: mp3, type: 'audio/mpeg' },
  );
  const wav = mp3.replace('.mp3', '.wav');
  assert.deepStrictEqual(
    playableFile(mp3, (f) => f === wav),
    { file: wav, type: 'audio/wav' },
  );
  assert.strictEqual(
    playableFile(mp3, () => false),
    null,
  );
  assert.strictEqual(
    playableFile('/etc/passwd', () => true),
    null,
  );
  assert.strictEqual(
    playableFile(`${BASE}/../../../etc/passwd`, () => true),
    null,
  );
  assert.strictEqual(playableFile(null), null);
});
