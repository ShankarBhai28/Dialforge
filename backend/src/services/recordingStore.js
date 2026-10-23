// Where a call recording can be played from.
//
// Each recording is uploaded to S3 right after the call (ops/recording-done.sh)
// and again by the nightly backup's sync, both to
//   s3://<bucket>/dialforge/<recording server>/recordings/YYYY/MM/DD/<file>
// (bucket: RECORDINGS_S3_BUCKET, else BACKUP_S3_BUCKET; recording server:
// RECORDINGS_HOST, else this server's short host name - the server Asterisk
// runs on, which is this one unless the app and telephony are split).
//
// Playback uses the local file while it is there; otherwise it fetches the
// file from S3 into a small cache (kept a day) and serves that, so the app
// server doesn't need the recordings folder, and recordings older than the
// local keep period still play.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { BASE, playableFile } = require('./recording');

const CACHE_DIR = process.env.RECORDINGS_CACHE_DIR || path.join(__dirname, '..', '..', 'recording-cache');
const CACHE_HOURS = 24;

/** The S3 folder recordings live in, or null when no bucket is set. */
function s3Prefix(env = process.env, hostname = os.hostname()) {
  const bucket = env.RECORDINGS_S3_BUCKET || env.BACKUP_S3_BUCKET;
  if (!bucket) return null;
  const host = env.RECORDINGS_HOST || hostname.split('.')[0];
  return `s3://${bucket}/dialforge/${host}/recordings`;
}

/** Recording path on the Asterisk server -> its path under the recordings folder (null if outside it). */
function relativePath(recordingPath) {
  if (!recordingPath) return null;
  const resolved = path.posix.resolve(recordingPath);
  return resolved.startsWith(BASE + '/') ? resolved.slice(BASE.length + 1) : null;
}

/** The AWS command-line tool (the backup uses the same). */
function awsCli() {
  for (const p of (process.env.PATH || '').split(path.delimiter))
    if (p && fs.existsSync(path.join(p, 'aws'))) return path.join(p, 'aws');
  return '/snap/bin/aws';
}

function s3Copy(from, to) {
  return new Promise((resolve) => {
    execFile(awsCli(), ['s3', 'cp', '--only-show-errors', from, to], { timeout: 60000 }, (err) => resolve(!err));
  });
}

let lastPrune = 0;
/** Cached copies older than a day go (checked at most once an hour). */
async function pruneCache(now = Date.now()) {
  if (now - lastPrune < 3600000) return;
  lastPrune = now;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await fs.promises.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > CACHE_HOURS * 3600000) await fs.promises.unlink(p).catch(() => {});
      }
    }
  }
  await walk(CACHE_DIR);
}

/**
 * The file to play for a stored recording path: local MP3 / WAV, else a
 * copy fetched from S3. { file, type, from: 'local' | 's3' } or null.
 */
async function findRecording(recordingPath, deps = {}) {
  const local = (deps.playableFile || playableFile)(recordingPath);
  if (local) return { ...local, from: 'local' };
  const rel = relativePath(recordingPath);
  const prefix = (deps.s3Prefix || s3Prefix)();
  if (!rel || !prefix) return null;
  const copy = deps.s3Copy || s3Copy;
  const exists = deps.exists || fs.existsSync;
  for (const [name, type] of [
    [rel, 'audio/mpeg'],
    [rel.replace(/\.mp3$/, '.wav'), 'audio/wav'],
  ]) {
    const cached = path.join(CACHE_DIR, ...name.split('/'));
    if (exists(cached)) return { file: cached, type, from: 's3' };
    await fs.promises.mkdir(path.dirname(cached), { recursive: true }).catch(() => {});
    // Into a temporary name first, so a half-downloaded file is never served.
    const part = `${cached}.part`;
    if (await copy(`${prefix}/${name}`, part)) {
      await fs.promises.rename(part, cached);
      void pruneCache().catch(() => {});
      return { file: cached, type, from: 's3' };
    }
    await fs.promises.unlink(part).catch(() => {});
  }
  return null;
}

/**
 * Why a recording can't be played, for the person pressing Play. Split servers
 * without a bucket: the files are on the telephony server, which this app server
 * can't read - say so, instead of "no longer kept".
 */
function missingMessage(env = process.env, hasFolder = fs.existsSync(BASE)) {
  if (!s3Prefix(env) && !hasFolder)
    return 'the recording is on the telephony server - set an S3 bucket (BACKUP_S3_BUCKET) so this server can play it';
  return 'the recording is no longer kept (not on the server or in S3)';
}

module.exports = { CACHE_DIR, findRecording, missingMessage, relativePath, s3Prefix };
