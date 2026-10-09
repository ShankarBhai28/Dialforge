function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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
    `\\n?\\[${asteriskName}\\]\\nstrategy = [^\\n]*\\ntimeout = [^\\n]*\\nretry = [^\\n]*\\ntimeoutrestart = [^\\n]*\\nannounce-frequency = [^\\n]*\\n(?:ringinuse = [^\\n]*\\n)?`,
  );
}

// Asterisk's queue strategies. Anything else would be written verbatim
// into queues.conf, so values are checked, never passed through.
const RING_STRATEGIES = [
  'ringall',
  'leastrecent',
  'fewestcalls',
  'random',
  'rrmemory',
  'rrordered',
  'linear',
  'wrandom',
];
const YES_NO = ['yes', 'no'];

// Checks the ring-behaviour fields of a queue form. A field that is
// missing (undefined / null / '') takes its value from `fallback` (the
// defaults on create, the current row on edit). Returns { error } or { settings }.
function parseQueueSettings(body, fallback) {
  const pick = (key) => (body[key] === undefined || body[key] === null || body[key] === '' ? fallback[key] : body[key]);
  const intIn = (key, label, min, max) => {
    const n = Number(pick(key));
    return Number.isInteger(n) && n >= min && n <= max ? n : `${label} must be a whole number from ${min} to ${max}`;
  };
  const settings = {
    ringStrategy: String(pick('ringStrategy')),
    waitTimeout: intIn('waitTimeout', 'Ring timeout', 1, 600),
    retry: intIn('retry', 'Retry', 0, 300),
    announce: String(pick('announce')),
    timeoutRestart: String(pick('timeoutRestart')),
  };
  if (!RING_STRATEGIES.includes(settings.ringStrategy))
    return { error: `ring strategy must be one of: ${RING_STRATEGIES.join(', ')}` };
  for (const key of ['waitTimeout', 'retry']) if (typeof settings[key] === 'string') return { error: settings[key] };
  if (!YES_NO.includes(settings.announce)) return { error: 'announce must be yes or no' };
  if (!YES_NO.includes(settings.timeoutRestart)) return { error: 'timeout restart must be yes or no' };
  return { settings };
}

const QUEUE_DEFAULTS = { ringStrategy: 'ringall', waitTimeout: 30, retry: 1, announce: 'no', timeoutRestart: 'yes' };

module.exports = { queueStanzaRegex, slugify, parseQueueSettings, QUEUE_DEFAULTS, RING_STRATEGIES };
