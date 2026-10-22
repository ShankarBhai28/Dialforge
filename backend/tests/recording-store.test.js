// Recordings: played from the server while the file is there, else fetched
// from S3 (the app server may not have the files at all).
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

process.env.RECORDINGS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'viztex-rec-'));
const { findRecording, relativePath, s3Prefix } = require('../src/services/recordingStore');
const { doneCommand } = require('../src/services/recording');

const REC = '/var/spool/asterisk/monitor/dialforge/2026/10/22/call-7-20261022-101500.mp3';
const PREFIX = 's3://acme-backups/dialforge/ip-10-0-0-5/recordings';

test('where recordings live in S3: the bucket, the recording server, the day folders', () => {
  assert.strictEqual(s3Prefix({}, 'ip-10-0-0-5'), null, 'no bucket: no S3');
  assert.strictEqual(s3Prefix({ BACKUP_S3_BUCKET: 'acme-backups' }, 'ip-10-0-0-5.ec2.internal'), PREFIX);
  // Split servers: the app names the telephony server; a separate bucket wins.
  assert.strictEqual(
    s3Prefix({ BACKUP_S3_BUCKET: 'b', RECORDINGS_S3_BUCKET: 'rec', RECORDINGS_HOST: 'tel1' }, 'app1'),
    's3://rec/dialforge/tel1/recordings',
  );
  assert.strictEqual(relativePath(REC), '2026/10/22/call-7-20261022-101500.mp3');
  assert.strictEqual(relativePath('/etc/passwd'), null, 'nothing outside the recordings folder');
  assert.strictEqual(relativePath('/var/spool/asterisk/monitor/dialforge/../../../../etc/passwd'), null);
});

test('Asterisk is told to upload right after converting, only when there is a bucket', () => {
  const base = '/var/spool/asterisk/monitor/dialforge/2026/10/22/call-7-20261022-101500';
  assert.strictEqual(doneCommand(base, PREFIX), `/usr/local/bin/dialforge-recording-done ${base}.wav ${PREFIX}`);
  assert.strictEqual(doneCommand(base, null), `/usr/local/bin/dialforge-recording-done ${base}.wav`);
});

test('the local file wins; nothing is fetched', async () => {
  let fetched = false;
  const r = await findRecording(REC, {
    playableFile: () => ({ file: REC, type: 'audio/mpeg' }),
    s3Prefix: () => PREFIX,
    s3Copy: async () => (fetched = true),
  });
  assert.deepStrictEqual(r, { file: REC, type: 'audio/mpeg', from: 'local' });
  assert.strictEqual(fetched, false);
});

test('not on this server: the MP3 is fetched from S3 once and then served from the cache', async () => {
  const asked = [];
  const deps = {
    playableFile: () => null,
    s3Prefix: () => PREFIX,
    s3Copy: async (from, to) => {
      asked.push(from);
      fs.writeFileSync(to, 'mp3 bytes');
      return true;
    },
  };
  const r = await findRecording(REC, deps);
  assert.strictEqual(r.type, 'audio/mpeg');
  assert.strictEqual(r.from, 's3');
  assert.deepStrictEqual(asked, [`${PREFIX}/2026/10/22/call-7-20261022-101500.mp3`]);
  assert.strictEqual(fs.readFileSync(r.file, 'utf8'), 'mp3 bytes');
  assert.ok(!fs.existsSync(`${r.file}.part`), 'no half-downloaded file left');
  // Second play: from the cache, S3 not asked again.
  await findRecording(REC, deps);
  assert.strictEqual(asked.length, 1);
});

test('the MP3 is not in S3 but the WAV is (conversion failed); neither -> null; no bucket -> null', async () => {
  const other = REC.replace('call-7', 'call-8');
  const r = await findRecording(other, {
    playableFile: () => null,
    s3Prefix: () => PREFIX,
    s3Copy: async (from, to) => {
      if (!from.endsWith('.wav')) return false;
      fs.writeFileSync(to, 'wav bytes');
      return true;
    },
  });
  assert.strictEqual(r.type, 'audio/wav');
  const gone = REC.replace('call-7', 'call-9');
  assert.strictEqual(
    await findRecording(gone, { playableFile: () => null, s3Prefix: () => PREFIX, s3Copy: async () => false }),
    null,
  );
  assert.strictEqual(await findRecording(gone, { playableFile: () => null, s3Prefix: () => null }), null);
});
