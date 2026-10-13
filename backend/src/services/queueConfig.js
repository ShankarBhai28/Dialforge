function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Asterisk's queue strategies. Asterisk reads these values straight from
// the database (ast_queues view), so only known values are stored.
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

module.exports = { slugify, parseQueueSettings, QUEUE_DEFAULTS, RING_STRATEGIES };
