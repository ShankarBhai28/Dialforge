// Extension (SIP line) rules, kept pure so they're easy to test.
// Asterisk reads extensions from the database (views ps_endpoints / ps_auths
// / ps_aors, migration 0002), so a row here IS the line.
const crypto = require('crypto');

const NAME_RE = /^[0-9]{3,8}$/;

/** A strong SIP password: 24 letters and digits (safe in every SIP client and config). */
function generateSipPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 24 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

/** PUT /admin/extensions/:id body -> { error } or { changes } (left-out fields keep their value). */
function parseExtensionUpdate(body, current) {
  const label = body.label === undefined ? current.label : body.label ? String(body.label).trim().slice(0, 100) : null;
  let enabled = current.enabled;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be true or false' };
    enabled = body.enabled ? 1 : 0;
  }
  return { changes: { label, enabled } };
}

module.exports = { generateSipPassword, parseExtensionUpdate, NAME_RE };
