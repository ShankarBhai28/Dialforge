// Extension (SIP line) rules, kept pure so they're easy to test.
// Asterisk reads extensions from the database (views ps_endpoints / ps_auths
// / ps_aors, migration 0002), so a row here IS the line.
const crypto = require('crypto');

const NAME_RE = /^[0-9]{3,8}$/;
const PASSWORD_RE = /^[A-Za-z0-9]{12,64}$/;

/** A strong SIP password: 24 letters and digits (safe in every SIP client and config). */
function generateSipPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 24 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

/** POST /admin/extensions body -> { error } or { extension } (a password is generated when none is given). */
function parseNewExtension(body) {
  const name = String(body.name ?? '').trim();
  if (!NAME_RE.test(name)) return { error: 'extension number must be 3-8 digits' };
  const label = body.label ? String(body.label).trim().slice(0, 100) : null;
  let password = body.password ? String(body.password) : '';
  if (password && !PASSWORD_RE.test(password)) return { error: 'SIP password: 12-64 letters and digits' };
  if (!password) password = generateSipPassword();
  return { extension: { name, label, password } };
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

module.exports = { generateSipPassword, parseNewExtension, parseExtensionUpdate, NAME_RE };
