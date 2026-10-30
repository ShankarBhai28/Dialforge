// A demo floor for showing Live Agents without real agents or calls (the PC
// copy, a test server before a demo). Never on a client's server.
//   npm run demo:floor -- add      (again = fresh demo, timers restart)
//   npm run demo:floor -- remove
//
// Adds 6 agents demo_agent1-6 (no password: they can't log in), extensions
// 1901-1906, queues demo_sales_q / demo_support_q, campaigns demo_Auto_Camp
// (predictive) / demo_Inbound_Camp (inbound), and open calls so every Call
// type shows: predictive, inbound, manual, callback; one agent idle, one on a
// 12-minute break (amber; red after 15). Every row is named demo… / 19xx, so
// remove deletes exactly these.
//
// Refuses when APP_ENV=production in .env. On a server with Asterisk the
// stale-call cleanup closes the fake calls after ~2 minutes (no channels);
// set STALE_CALL_CHECK_SECONDS=0 there for a longer demo.
require('dotenv').config();

const AGENTS = [
  // name, ext, status, break reason, minutes in status, queue, call
  [
    'demo_agent1',
    '1901',
    'available',
    null,
    3,
    'sales',
    { type: 'predictive', phone: '9840012345', name: 'Ravi Kumar', talkMin: 3.5 },
  ],
  ['demo_agent2', '1902', 'available', null, 4, 'sales', null],
  [
    'demo_agent3',
    '1903',
    'available',
    null,
    1,
    'support',
    { type: 'inbound', phone: '8065098690', name: 'Meena S', talkMin: 0.8 },
  ],
  ['demo_agent4', '1904', 'break', 'Tea Break', 12, 'sales', null],
  [
    'demo_agent5',
    '1905',
    'available',
    null,
    2,
    'sales',
    { type: 'manual', phone: '9884400771', name: 'Priya R', talkMin: 1.6 },
  ],
  [
    'demo_agent6',
    '1906',
    'available',
    null,
    7,
    'sales',
    { type: 'callback', phone: '9003311445', name: 'Kumar V', talkMin: 6.9 },
  ],
];
const EXTENSIONS = AGENTS.map((a) => a[1]);

/** Why it must not run, or null. */
function refusal({ env, args }) {
  if ((env.APP_ENV || '').toLowerCase() === 'production') return 'APP_ENV=production - no demo data on a real server';
  if (!['add', 'remove'].includes(args[0])) return 'say what to do: add or remove';
  return null;
}

async function remove(db) {
  const [u] = await db.query("SELECT id FROM users WHERE username LIKE 'demo\\_agent%'");
  const ids = u.map((r) => r.id);
  const [c] = await db.query("SELECT id FROM campaigns WHERE name LIKE 'demo\\_%'");
  const cids = c.map((r) => r.id);
  // Children before parents (foreign keys): calls and attempts, campaign rows, then the agents.
  if (ids.length) {
    await db.query('DELETE FROM calls WHERE agent_user_id IN (?)', [ids]);
    await db.query('DELETE FROM dial_attempts WHERE agent_user_id IN (?)', [ids]);
  }
  if (cids.length) {
    await db.query('DELETE FROM callbacks WHERE campaign_id IN (?)', [cids]);
    await db.query('DELETE FROM dial_attempts WHERE campaign_id IN (?)', [cids]);
    await db.query('DELETE FROM calls WHERE campaign_id IN (?)', [cids]);
    await db.query('DELETE FROM leads WHERE campaign_id IN (?)', [cids]);
    await db.query('DELETE FROM lists WHERE campaign_id IN (?)', [cids]);
    await db.query('DELETE FROM campaign_dispositions WHERE campaign_id IN (?)', [cids]);
    await db.query('DELETE FROM campaigns WHERE id IN (?)', [cids]);
  }
  if (ids.length) {
    await db.query('DELETE FROM agent_status_log WHERE user_id IN (?)', [ids]);
    await db.query('DELETE FROM live_agents WHERE user_id IN (?)', [ids]);
    await db.query('DELETE FROM users WHERE id IN (?)', [ids]);
  }
  await db.query("DELETE FROM queues WHERE name LIKE 'demo\\_%'");
  await db.query('DELETE FROM extensions WHERE name IN (?)', [EXTENSIONS]);
}

async function add(db, now = Date.now()) {
  await remove(db);
  const ago = (min) => new Date(now - min * 60 * 1000);
  const [[admin]] = await db.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const insert = async (table, row) => (await db.query(`INSERT INTO ${table} SET ?`, row))[0].insertId;

  const queues = {
    sales: await insert('queues', { name: 'demo_sales_q' }),
    support: await insert('queues', { name: 'demo_support_q' }),
  };
  const campaign = (name, queue, mode) =>
    insert('campaigns', { tenant_id: 1, name, queue_id: queues[queue], dial_mode: mode, status: 'active' });
  const auto = await campaign('demo_Auto_Camp', 'sales', 'predictive');
  const inbound = await campaign('demo_Inbound_Camp', 'support', 'inbound');
  const list = await insert('lists', { campaign_id: auto, name: 'demo list' });

  for (const [username, ext, status, reason, mins, queue, call] of AGENTS) {
    const extId = await insert('extensions', { tenant_id: 1, name: ext });
    const uid = await insert('users', {
      tenant_id: 1,
      username,
      password_hash: '!demo-no-login', // not a bcrypt hash: no password matches it
      role: 'agent',
      extension_id: extId,
    });
    await insert('agent_status_log', { user_id: uid, status, reason, queue_id: queues[queue], started_at: ago(mins) });
    await insert('live_agents', {
      user_id: uid,
      username,
      state: 'online',
      line: 'registered',
      login_at: ago(120),
      updated_at: new Date(now),
    });
    if (!call) continue;
    const row = {
      tenant_id: 1,
      to_number: call.phone,
      from_extension: ext,
      agent_user_id: uid,
      start_time: ago(call.talkMin + 0.2),
      answer_time: ago(call.talkMin),
      agent_connect_time: ago(call.talkMin),
      direction: call.type === 'inbound' ? 'inbound' : 'outbound',
      campaign_id: call.type === 'inbound' ? inbound : auto,
    };
    if (call.type !== 'inbound') {
      row.lead_id = await insert('leads', {
        tenant_id: 1,
        campaign_id: auto,
        list_id: list,
        name: call.name,
        phone: call.phone,
      });
    }
    if (call.type === 'predictive') {
      row.dial_attempt_id = await insert('dial_attempts', {
        tenant_id: 1,
        campaign_id: auto,
        lead_id: row.lead_id,
        phone: call.phone,
        status: 'connected',
        agent_user_id: uid,
        started_at: row.start_time,
        answered_at: row.answer_time,
        connected_at: row.agent_connect_time,
      });
    }
    if (call.type === 'callback') {
      // A pending callback due when the call started: Live Agents shows "Callback".
      await insert('callbacks', {
        tenant_id: 1,
        lead_id: row.lead_id,
        campaign_id: auto,
        callback_at: ago(call.talkMin + 1),
        status: 'pending',
        created_by: admin.id,
      });
    }
    await insert('calls', row);
  }
}

module.exports = { AGENTS, refusal, add, remove };

if (require.main === module) {
  const pool = require('../../db');
  (async () => {
    const args = process.argv.slice(2);
    const why = refusal({ env: process.env, args });
    if (why) {
      console.error(`Not done: ${why}`);
      process.exitCode = 1;
      return;
    }
    if (args[0] === 'add') {
      await add(pool);
      console.log('Demo floor added: Live Agents shows demo_agent1-6. Remove with: npm run demo:floor -- remove');
    } else {
      await remove(pool);
      console.log('Demo floor removed.');
    }
  })()
    .catch((err) => {
      console.error(`FAILED: ${err.message}`);
      process.exitCode = 2;
    })
    .finally(() => pool.end());
}
