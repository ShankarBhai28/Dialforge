const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');

// --- D3: phone normalisation, DNC, calling window, campaign dial settings,
// per-campaign dispositions ---

async function isDnc(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const [rows] = await pool.query('SELECT 1 FROM dnc_numbers WHERE tenant_id = 1 AND phone = ? LIMIT 1', [normalized]);
  return rows.length > 0;
}

async function addDnc(phone, source, userId) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const [result] = await pool.query(
    'INSERT IGNORE INTO dnc_numbers (tenant_id, phone, source, created_by) VALUES (1, ?, ?, ?)',
    [normalized, source, userId || null],
  );
  return result.affectedRows > 0;
}

module.exports = { addDnc, isDnc };
