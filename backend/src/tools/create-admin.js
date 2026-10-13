// Creates a Super Admin login - the first account on a new install.
//
//   npm run create-admin -- --username boss
//
// The password comes from the ADMIN_PASSWORD environment variable, or, if
// that isn't set, a random one is made and printed once (store it safely,
// then change it after the first login). Refuses an existing username.
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { MIN_PASSWORD } = require('../services/users');

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,50}$/;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** A readable random password: 16 characters, no look-alikes (0/O, 1/l). */
function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 16 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

async function createAdmin(pool, username, password) {
  if (!USERNAME_RE.test(username || ''))
    throw new Error('--username: 3-50 letters, digits, dots, dashes or underscores');
  if (password.length < MIN_PASSWORD) throw new Error(`the password must be at least ${MIN_PASSWORD} characters`);
  const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
  if (existing.length) throw new Error(`"${username}" already exists`);
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.query(
    "INSERT INTO users (tenant_id, username, password_hash, role, status) VALUES (1, ?, ?, 'admin', 'active')",
    [username, hash],
  );
  return r.insertId;
}

module.exports = { createAdmin, randomPassword };

if (require.main === module) {
  const pool = require('../../db');
  (async () => {
    const username = arg('username');
    const given = process.env.ADMIN_PASSWORD;
    const password = given || randomPassword();
    try {
      const id = await createAdmin(pool, username, password);
      console.log(`Created Super Admin "${username}" (id ${id}).`);
      if (!given) console.log(`Password (shown once - store it safely, change it after logging in): ${password}`);
    } catch (err) {
      console.error(`ERROR ${err.message}`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
