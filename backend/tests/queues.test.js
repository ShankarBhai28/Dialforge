// Queue settings are written into Asterisk's queues.conf, so only known
// values may get through (a newline in a value would inject config).
const assert = require('node:assert');
const { test } = require('node:test');
const { parseQueueSettings, QUEUE_DEFAULTS } = require('../src/services/queueConfig');

test('missing fields take the fallback (defaults on create, current row on edit)', () => {
  assert.deepStrictEqual(parseQueueSettings({}, QUEUE_DEFAULTS), { settings: QUEUE_DEFAULTS });
  const current = { ringStrategy: 'fewestcalls', waitTimeout: 20, retry: 2, announce: 'yes', timeoutRestart: 'no' };
  assert.deepStrictEqual(parseQueueSettings({ waitTimeout: '25', retry: '' }, current), {
    settings: { ...current, waitTimeout: 25 },
  });
});

test('accepts every Asterisk strategy and a retry of 0', () => {
  for (const s of ['ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'rrordered', 'linear', 'wrandom'])
    assert.ok(parseQueueSettings({ ringStrategy: s, retry: 0 }, QUEUE_DEFAULTS).settings, s);
});

test('rejects anything that could change queues.conf beyond its value', () => {
  const bad = [
    { ringStrategy: 'ringall\n[evil]' },
    { ringStrategy: 'bogus' },
    { waitTimeout: '30\ncontext = x' },
    { waitTimeout: 0 },
    { waitTimeout: 1.5 },
    { retry: -1 },
    { announce: 'maybe' },
    { timeoutRestart: 'yes\nx' },
  ];
  for (const body of bad) assert.ok(parseQueueSettings(body, QUEUE_DEFAULTS).error, JSON.stringify(body));
});
