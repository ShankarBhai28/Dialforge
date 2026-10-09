// One-time seed script - creates initial login accounts.
// Run manually with `node seed-users.js`, not on every server start.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function seed() {
  const [ext1001] = await pool.query("SELECT id FROM extensions WHERE name = '1001'");
  const [ext1002] = await pool.query("SELECT id FROM extensions WHERE name = '1002'");

  const required = ['ADMIN_PASSWORD', 'AGENT1001_PASSWORD', 'AGENT1002_PASSWORD'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}. Set them in .env before seeding.`);
    process.exit(1);
  }

  const accounts = [
    { username: 'admin', password: process.env.ADMIN_PASSWORD, role: 'admin', extensionId: null },
    { username: 'agent1001', password: process.env.AGENT1001_PASSWORD, role: 'agent', extensionId: ext1001[0].id },
    { username: 'agent1002', password: process.env.AGENT1002_PASSWORD, role: 'agent', extensionId: ext1002[0].id },
  ];

  for (const acc of accounts) {
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [acc.username]);
    if (existing.length > 0) {
      console.log(`Skipping ${acc.username} - already exists`);
      continue;
    }
    const hash = await bcrypt.hash(acc.password, 10);
    await pool.query(
      'INSERT INTO users (tenant_id, username, password_hash, role, extension_id) VALUES (1, ?, ?, ?, ?)',
      [acc.username, hash, acc.role, acc.extensionId],
    );
    console.log(`Created ${acc.role} account: ${acc.username}`);
  }

  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
