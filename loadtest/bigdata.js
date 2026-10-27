#!/usr/bin/env node
// Load test: fills a TEST server's database with months of fake call
// history, so the reports, Call Log and dashboard can be timed on the
// amount of data a real customer builds up (report-times.js measures them).
// Run on the app server, from the app's folder (it uses the app's .env and
// node modules):
//
//   cd ~/dialforge-backend && node ~/loadtest/bigdata.js --days 90 --yes
//   cd ~/dialforge-backend && node ~/loadtest/bigdata.js --remove --yes
//
// What it makes: a paused campaign "Big data history" (a copy of --campaign,
// default "Load test", with its outcomes and teams), one inactive list of
// --leads fake leads (default 300000, numbers 7000000000...), and for every
// working day (Mon-Sat) of the last --days days, for every agent of that
// campaign's teams (or the first --agents of them), a 9-hour shift: status
// rows (available / wrap-up / three breaks), the calls they took (talk
// 10 s - 10 min, outcomes from the campaign's list, some callbacks), the
// dialer's attempts that didn't reach anybody (about 2.3 per call: no
// answer, busy, failed), a few dropped calls, and the call events.
// About 140 calls per agent per day: 200 agents x 90 days = ~2 million
// calls, ~7 million dial attempts, ~8 million call events; ~20-40 minutes,
// ~8-10 GB on the DB server's disk.
//
// Test servers only: refuses unless the app's .env has TRUNK_ENDPOINT=loadtrunk
// (set only for a load test), and while a campaign is dialing or a call is
// open (it numbers its rows itself, so nothing else may write calls meanwhile).
// --remove deletes everything it made (its rows are marked: the campaign by
// name, status rows by extension_name 'bigdata').
const path = require('path');

const fromApp = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
fromApp('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = fromApp('mysql2/promise');

const NAME = 'Big data history';
const MARK = 'bigdata';

function args() {
  const a = { flags: new Set() };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (['--yes', '--remove'].includes(v[i])) a.flags.add(v[i].slice(2));
    else a[v[i].replace(/^--/, '')] = v[++i];
  }
  return {
    yes: a.flags.has('yes'),
    remove: a.flags.has('remove'),
    days: Number(a.days || 90),
    leads: Number(a.leads || 300000),
    agents: a.agents ? Number(a.agents) : null,
    campaign: a.campaign || 'Load test',
  };
}

// --- small helpers ---
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[pairs.length - 1][0];
}
/** Talk seconds: many short calls, some long ones. */
const talkSecs = () =>
  weighted([
    [rnd(10, 40), 30],
    [rnd(40, 180), 50],
    [rnd(180, 600), 20],
  ]);

/** Batched multi-row INSERTs (explicit ids where the table needs them). */
class Writer {
  constructor(db, table, cols, size = 1000) {
    Object.assign(this, { db, table, cols, size, rows: [], total: 0 });
  }
  async add(row) {
    this.rows.push(row);
    if (this.rows.length >= this.size) await this.flush();
  }
  async flush() {
    if (!this.rows.length) return;
    const rows = this.rows;
    this.rows = [];
    await this.db.query(`INSERT INTO ${this.table} (${this.cols.join(', ')}) VALUES ?`, [rows]);
    this.total += rows.length;
  }
}

async function refusal(db, opt) {
  if (process.env.TRUNK_ENDPOINT !== 'loadtrunk') {
    return 'TRUNK_ENDPOINT is not loadtrunk in .env - this is not a load-test server';
  }
  if (!opt.yes) return 'add --yes to confirm (see the top of this file for what it adds)';
  const [[dialing]] = await db.query("SELECT COUNT(*) AS n FROM campaigns WHERE dialer_state <> 'stopped'");
  if (Number(dialing.n)) return `${dialing.n} campaign(s) dialing - stop the dialer first`;
  const [[open]] = await db.query(
    'SELECT COUNT(*) AS n FROM calls WHERE end_time IS NULL AND start_time > NOW() - INTERVAL 3 HOUR',
  );
  if (Number(open.n)) return `${open.n} call(s) open - wait for them to end`;
  return null;
}

/** Deletes in chunks (millions of rows in one statement would hold huge locks). */
async function chunkDelete(db, label, statement, params = []) {
  let n = 0;
  for (;;) {
    const [r] = await db.query(`${statement} LIMIT 20000`, params);
    n += r.affectedRows;
    if (r.affectedRows < 20000) break;
    process.stdout.write(`\r  ${label}: ${n}   `);
  }
  console.log(`\r  ${label}: ${n} deleted   `);
}

async function remove(db) {
  const [[c]] = await db.query('SELECT id FROM campaigns WHERE name = ?', [NAME]);
  if (c) {
    const id = c.id;
    const inCalls = 'call_id IN (SELECT id FROM (SELECT id FROM calls WHERE campaign_id = ?) x)';
    await chunkDelete(db, 'call events', `DELETE FROM call_events WHERE ${inCalls}`, [id]);
    await chunkDelete(db, 'callbacks', 'DELETE FROM callbacks WHERE campaign_id = ?', [id]);
    await chunkDelete(db, 'dial attempts', 'DELETE FROM dial_attempts WHERE campaign_id = ?', [id]);
    await chunkDelete(db, 'calls', 'DELETE FROM calls WHERE campaign_id = ?', [id]);
    await chunkDelete(db, 'leads', 'DELETE FROM leads WHERE campaign_id = ?', [id]);
    await db.query('DELETE FROM lists WHERE campaign_id = ?', [id]);
    await db.query('DELETE FROM team_campaigns WHERE campaign_id = ?', [id]);
    await db.query('DELETE FROM campaign_dispositions WHERE campaign_id = ?', [id]);
    await db.query('DELETE FROM campaigns WHERE id = ?', [id]);
  }
  await chunkDelete(db, 'agent status rows', 'DELETE FROM agent_status_log WHERE extension_name = ?', [MARK]);
  console.log(`"${NAME}" removed.`);
}

/** The campaign copy, its outcomes, teams, list and leads -> what the history needs. */
async function setup(db, opt) {
  const [[src]] = await db.query('SELECT * FROM campaigns WHERE name = ? AND deleted_at IS NULL', [opt.campaign]);
  if (!src) throw new Error(`campaign "${opt.campaign}" not found (--campaign)`);
  const [[exists]] = await db.query('SELECT id FROM campaigns WHERE name = ?', [NAME]);
  if (exists) throw new Error(`"${NAME}" already exists - run with --remove first`);

  const { id: srcId, ...copy } = src;
  Object.assign(copy, { name: NAME, status: 'paused', dialer_state: 'stopped', created_at: new Date() });
  for (const k of ['dialer_state_changed_at', 'dialer_state_changed_by', 'deleted_at', 'deleted_by'])
    if (k in copy) copy[k] = null;
  const [ins] = await db.query('INSERT INTO campaigns SET ?', [copy]);
  const campaignId = ins.insertId;
  await db.query(
    `INSERT INTO campaign_dispositions (campaign_id, code, label, is_final, retry_after_min, marks_dnc, is_callback, sort_order, is_success)
     SELECT ?, code, label, is_final, retry_after_min, marks_dnc, is_callback, sort_order, is_success
     FROM campaign_dispositions WHERE campaign_id = ?`,
    [campaignId, srcId],
  );
  await db.query(
    'INSERT INTO team_campaigns (team_id, campaign_id) SELECT team_id, ? FROM team_campaigns WHERE campaign_id = ?',
    [campaignId, srcId],
  );
  const [outcomes] = await db.query(
    'SELECT code, is_callback, is_success FROM campaign_dispositions WHERE campaign_id = ?',
    [campaignId],
  );
  if (!outcomes.length) throw new Error(`campaign "${opt.campaign}" has no outcomes`);

  const [agents] = await db.query(
    `SELECT DISTINCT u.id, e.name AS ext, e.id AS ext_id FROM users u
     JOIN team_members tm ON tm.user_id = u.id JOIN team_campaigns tc ON tc.team_id = tm.team_id
     LEFT JOIN extensions e ON e.id = u.extension_id
     WHERE tc.campaign_id = ? AND u.role = 'agent' ORDER BY u.id ${opt.agents ? 'LIMIT ?' : ''}`,
    [srcId, ...(opt.agents ? [opt.agents] : [])],
  );
  if (!agents.length) throw new Error(`no agents in the teams of "${opt.campaign}"`);

  const [list] = await db.query('INSERT INTO lists (campaign_id, name, is_active) VALUES (?, ?, 0)', [
    campaignId,
    NAME,
  ]);
  const leads = new Writer(
    db,
    'leads',
    ['tenant_id', 'phone', 'name', 'status', 'campaign_id', 'list_id', 'is_final'],
    5000,
  );
  for (let i = 0; i < opt.leads; i++) {
    await leads.add([1, String(7000000000 + i), `History ${i + 1}`, 'new', campaignId, list.insertId, 1]);
    if (i % 50000 === 0) process.stdout.write(`\r  leads: ${i}   `);
  }
  await leads.flush();
  const [leadRows] = await db.query('SELECT id, phone FROM leads WHERE list_id = ? ORDER BY id', [list.insertId]);
  console.log(`\r  leads: ${leadRows.length}   `);
  return { campaignId, outcomes, agents, leads: leadRows };
}

async function seed(db, opt) {
  const t0 = Date.now();
  // Batches of calls and attempts point at each other and fill at different speeds;
  // every id they use is made here, so the checks would only cost time.
  await db.query('SET SESSION foreign_key_checks = 0');
  console.log(`== setup ("${NAME}", copy of "${opt.campaign}")`);
  const { campaignId, outcomes, agents, leads } = await setup(db, opt);
  const plain = outcomes.filter((o) => !o.is_callback);
  const callbackCodes = outcomes.filter((o) => o.is_callback).map((o) => o.code);
  const outcomeOf = () =>
    callbackCodes.length && Math.random() < 0.04 ? pick(callbackCodes) : pick(plain.length ? plain : outcomes).code;

  // Ids are numbered here (calls <-> attempts <-> events point at each other); start well above today's.
  const [[mx]] = await db.query(
    'SELECT (SELECT COALESCE(MAX(id), 0) FROM calls) AS calls, (SELECT COALESCE(MAX(id), 0) FROM dial_attempts) AS attempts',
  );
  let callId = Number(mx.calls) + 1000;
  let attemptId = Number(mx.attempts) + 1000;

  const W = {
    status: new Writer(db, 'agent_status_log', [
      'user_id',
      'status',
      'reason',
      'started_at',
      'ended_at',
      'extension_name',
    ]),
    calls: new Writer(db, 'calls', [
      'id',
      'tenant_id',
      'lead_id',
      'extension_id',
      'direction',
      'from_extension',
      'to_number',
      'disposition',
      'start_time',
      'answer_time',
      'end_time',
      'campaign_id',
      'auto_answer',
      'dial_attempt_id',
      'agent_user_id',
      'agent_connect_time',
      'outcome',
      'outcome_at',
    ]),
    attempts: new Writer(db, 'dial_attempts', [
      'id',
      'tenant_id',
      'campaign_id',
      'lead_id',
      'call_id',
      'phone',
      'status',
      'result',
      'agent_user_id',
      'ratio_at_dial',
      'started_at',
      'answered_at',
      'connected_at',
      'ended_at',
    ]),
    events: new Writer(db, 'call_events', ['call_id', 'event_type', 'created_at'], 4000),
    callbacks: new Writer(db, 'callbacks', [
      'tenant_id',
      'lead_id',
      'campaign_id',
      'user_id',
      'callback_at',
      'status',
      'created_by',
      'created_at',
    ]),
  };
  // Calls and attempts point at each other: write calls first, attempts after them.
  const flushAll = async () => {
    await W.calls.flush();
    await W.attempts.flush();
    await W.events.flush();
    await W.callbacks.flush();
    await W.status.flush();
  };

  const ratio = () => (1.5 + Math.random()).toFixed(2);
  const unanswered = async (lead, at) => {
    const result = weighted([
      ['no_answer', 60],
      ['busy', 25],
      ['congestion', 10],
      ['invalid', 5],
    ]);
    const ring = result === 'no_answer' ? rnd(25, 30) : rnd(1, 6);
    await W.attempts.add([
      attemptId++,
      1,
      campaignId,
      lead.id,
      null,
      lead.phone,
      'ended',
      result,
      null,
      ratio(),
      sql(at),
      null,
      null,
      sql(at + ring * 1000),
    ]);
  };

  const now = Date.now();
  const firstDay = new Date(now - opt.days * 86400000);
  firstDay.setUTCHours(0, 0, 0, 0);
  let days = 0;
  for (let day = firstDay.getTime(); day < now - 86400000; day += 86400000) {
    if (new Date(day + 5.5 * 3600000).getUTCDay() === 0) continue; // Sunday (India)
    days++;
    for (const ag of agents) {
      // Shift 09:15-09:45 IST (= 03:45-04:15 UTC) for about 9 hours; breaks after 2, 4 (lunch) and 6.5 hours.
      const login = day + (3 * 60 + 45) * 60000 + rnd(0, 1800) * 1000;
      const logout = login + rnd(510, 560) * 60000;
      const breaks = [
        [login + 2 * 3600000, rnd(10, 15) * 60, 'Tea'],
        [login + 4 * 3600000, rnd(25, 35) * 60, 'Lunch'],
        [login + 6.5 * 3600000, rnd(10, 15) * 60, 'Tea'],
      ];
      let t = login;
      while (t < logout) {
        if (breaks.length && t >= breaks[0][0]) {
          const [, len, why] = breaks.shift();
          await W.status.add([ag.id, 'break', why, sql(t), sql(t + len * 1000), MARK]);
          t += len * 1000;
          continue;
        }
        const lead = pick(leads);
        const connect = t + rnd(5, 60) * 1000;
        const answer = connect - rnd(1, 4) * 1000;
        const ringStart = answer - rnd(5, 25) * 1000;
        const end = connect + talkSecs() * 1000;
        const wrap = rnd(5, 25) * 1000;
        const outcome = outcomeOf();
        const id = callId++;
        await W.calls.add([
          id,
          1,
          lead.id,
          ag.ext_id,
          'outbound',
          ag.ext,
          lead.phone,
          'ended',
          sql(answer),
          sql(answer),
          sql(end),
          campaignId,
          1,
          attemptId,
          ag.id,
          sql(connect),
          outcome,
          sql(end + wrap),
        ]);
        await W.attempts.add([
          attemptId++,
          1,
          campaignId,
          lead.id,
          id,
          lead.phone,
          'ended',
          'connected',
          ag.id,
          ratio(),
          sql(ringStart),
          sql(answer),
          sql(connect),
          sql(end),
        ]);
        for (const [ev, at] of [
          ['queued', answer],
          ['agent_answered', connect],
          ['bridged', connect],
          ['ended', end],
        ])
          await W.events.add([id, ev, sql(at)]);
        if (callbackCodes.includes(outcome)) {
          const due = end + rnd(1, 48) * 3600000;
          const status =
            due > now
              ? 'pending'
              : weighted([
                  ['done', 80],
                  ['pending', 12],
                  ['cancelled', 8],
                ]);
          await W.callbacks.add([1, lead.id, campaignId, ag.id, sql(due), status, ag.id, sql(end + wrap)]);
        }
        // What else the dialer did meanwhile for this agent: numbers that didn't answer, now and then a drop.
        for (
          let k = weighted([
            [1, 30],
            [2, 30],
            [3, 25],
            [4, 15],
          ]);
          k > 0;
          k--
        )
          await unanswered(pick(leads), ringStart - rnd(0, 60) * 1000);
        if (Math.random() < 0.02) {
          const l = pick(leads);
          const a = ringStart - rnd(0, 30) * 1000;
          const drop = callId++;
          await W.calls.add([
            drop,
            1,
            l.id,
            null,
            'outbound',
            null,
            l.phone,
            'abandoned',
            sql(a),
            sql(a),
            sql(a + 5000),
            campaignId,
            1,
            attemptId,
            null,
            null,
            null,
            null,
          ]);
          await W.attempts.add([
            attemptId++,
            1,
            campaignId,
            l.id,
            drop,
            l.phone,
            'ended',
            'abandoned',
            null,
            ratio(),
            sql(a - 15000),
            sql(a),
            null,
            sql(a + 5000),
          ]);
          for (const [ev, at] of [
            ['queued', a],
            ['abandoned', a + 5000],
          ])
            await W.events.add([drop, ev, sql(at)]);
        }
        await W.status.add([ag.id, 'available', null, sql(t), sql(end), MARK]);
        await W.status.add([ag.id, 'acw', null, sql(end), sql(end + wrap), MARK]);
        t = end + wrap;
      }
    }
    await flushAll();
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(
      `  day ${days} (${sql(day).slice(0, 10)}): calls ${W.calls.total}, attempts ${W.attempts.total}, events ${W.events.total}, status rows ${W.status.total} - ${mins} min`,
    );
  }

  console.log('== lead attempts (List Penetration)');
  await db.query(
    `UPDATE leads l JOIN (SELECT lead_id, COUNT(*) AS n, MAX(started_at) AS last FROM dial_attempts WHERE campaign_id = ? GROUP BY lead_id) a
       ON a.lead_id = l.id
     SET l.attempts = a.n, l.last_attempt_at = a.last`,
    [campaignId],
  );
  console.log(
    `done in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${days} days x ${agents.length} agents - calls ${W.calls.total}, ` +
      `attempts ${W.attempts.total}, events ${W.events.total}, status rows ${W.status.total}, callbacks ${W.callbacks.total}`,
  );
}

(async () => {
  const opt = args();
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    const why = await refusal(db, opt);
    if (why) {
      console.error(`refused: ${why}`);
      process.exitCode = 2;
      return;
    }
    await (opt.remove ? remove(db) : seed(db, opt));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
