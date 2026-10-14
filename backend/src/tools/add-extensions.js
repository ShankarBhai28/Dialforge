// Adds agent extensions (SIP lines). Extensions are the client's paid agent
// seats - one extension can't be used by two agents at the same time - so
// only the provider adds them, here on the server; the client's admin can
// only give them to users, rename, disable and re-key them in the app.
//
//   npm run ext:add -- --from 1001 --count 10        # 1001..1010
//   npm run ext:add -- --from 1011 --count 5 --label "Night shift"
//   npm run ext:add -- --list                         # what exists now
//
// Numbers that already exist are skipped. Passwords are generated; the
// agent screen gets its own, so nothing needs to be noted down.
// Never more than the licence's seats (/etc/viztex/licence.json): raise
// them with install/set-licence.sh first.
require('dotenv').config();
const { NAME_RE, generateSipPassword } = require('../services/extensions');
const { getLicence } = require('../services/licence');

const MAX_AT_ONCE = 500;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** --from / --count -> the numbers to add, or throws with a plain message. */
function planNumbers(from, count) {
  if (!NAME_RE.test(String(from ?? ''))) throw new Error('--from: the first extension number, 3-8 digits');
  const n = Number(count ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > MAX_AT_ONCE) throw new Error(`--count: 1-${MAX_AT_ONCE}`);
  const width = String(from).length;
  const numbers = [];
  for (let i = 0; i < n; i++) {
    const name = String(Number(from) + i).padStart(width, '0');
    if (!NAME_RE.test(name)) throw new Error(`${name} is not a valid extension number (3-8 digits)`);
    numbers.push(name);
  }
  return numbers;
}

/** Refuses when the new extensions would go past the licensed seats (null seats = no limit). */
async function checkSeats(pool, numbers, seats) {
  if (!seats) return;
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM extensions WHERE deleted_at IS NULL');
  const [existing] = await pool.query('SELECT name FROM extensions WHERE deleted_at IS NULL AND name IN (?)', [
    numbers,
  ]);
  const after = Number(row.n) + numbers.length - existing.length;
  if (after > seats)
    throw new Error(
      `the licence allows ${seats} seats; ${row.n} extensions exist, so at most ${Math.max(seats - row.n, 0)} more - raise seats with set-licence.sh first`,
    );
}

async function addExtensions(pool, numbers, label, seats = null) {
  await checkSeats(pool, numbers, seats);
  const added = [];
  const skipped = [];
  for (const name of numbers) {
    const [exists] = await pool.query('SELECT id FROM extensions WHERE name = ? AND deleted_at IS NULL', [name]);
    if (exists.length) {
      skipped.push(name);
      continue;
    }
    await pool.query('INSERT INTO extensions (tenant_id, name, label, sip_password, enabled) VALUES (1, ?, ?, ?, 1)', [
      name,
      label ? String(label).trim().slice(0, 100) : null,
      generateSipPassword(),
    ]);
    added.push(name);
  }
  return { added, skipped };
}

module.exports = { planNumbers, addExtensions, checkSeats };

if (require.main === module) {
  const pool = require('../../db');
  (async () => {
    try {
      if (process.argv.includes('--list')) {
        const [rows] = await pool.query(
          `SELECT e.name, e.enabled, COALESCE(e.label, '') AS label,
                  (SELECT GROUP_CONCAT(u.username) FROM users u WHERE u.extension_id = e.id) AS used_by
           FROM extensions e WHERE e.deleted_at IS NULL ORDER BY e.name`,
        );
        for (const r of rows)
          console.log(`${r.name}  ${r.enabled ? 'enabled ' : 'DISABLED'}  ${r.label}  ${r.used_by || '-'}`);
        const { seats } = getLicence();
        console.log(
          `${rows.length} extension(s) (${rows.filter((r) => r.enabled).length} enabled)${seats ? `, licence: ${seats} seats` : ''}`,
        );
        return;
      }
      const { added, skipped } = await addExtensions(
        pool,
        planNumbers(arg('from'), arg('count')),
        arg('label'),
        getLicence().seats,
      );
      if (added.length) console.log(`Added ${added.length}: ${added.join(', ')}`);
      if (skipped.length) console.log(`Already there, skipped: ${skipped.join(', ')}`);
    } catch (err) {
      console.error(`ERROR ${err.message}`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
