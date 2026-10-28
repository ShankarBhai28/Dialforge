// express-session store in MySQL (table `sessions`), so logins survive a
// backend restart or deploy. Small on purpose - the same choice as ari.js
// and ami.js: a handful of queries isn't worth a dependency.
// Cloud edition (tenants: true): one table in the platform database for every
// company's sessions, with the company in tenant_code (user ids repeat).
const session = require('express-session');
const tenancy = require('../tenancy');

class MySqlSessionStore extends session.Store {
  constructor({ pool, cleanupMs = 15 * 60 * 1000, tenants = false } = {}) {
    super();
    this.pool = pool;
    this.tenants = tenants;
    // Expired rows are ignored on read and removed now and then.
    if (cleanupMs) {
      this.timer = setInterval(() => this.cleanup().catch(() => {}), cleanupMs);
      this.timer.unref();
    }
  }

  expiresOf(sess) {
    const ms = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
    return new Date(ms);
  }

  get(sid, cb) {
    this.pool
      .query('SELECT data FROM sessions WHERE sid = ? AND expires > NOW()', [sid])
      .then(([rows]) => cb(null, rows[0] ? JSON.parse(rows[0].data) : null))
      .catch((err) => cb(err));
  }

  set(sid, sess, cb = () => {}) {
    const userId = sess.user ? sess.user.id : null;
    const values = [sid, userId, this.expiresOf(sess), JSON.stringify(sess)];
    this.pool
      .query(
        this.tenants
          ? `INSERT INTO sessions (sid, user_id, expires, data, tenant_code) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), expires = VALUES(expires), data = VALUES(data),
               tenant_code = VALUES(tenant_code)`
          : `INSERT INTO sessions (sid, user_id, expires, data) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), expires = VALUES(expires), data = VALUES(data)`,
        this.tenants ? [...values, sess.tenant || ''] : values,
      )
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  touch(sid, sess, cb = () => {}) {
    this.pool
      .query('UPDATE sessions SET expires = ? WHERE sid = ?', [this.expiresOf(sess), sid])
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  destroy(sid, cb = () => {}) {
    this.pool
      .query('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  /** Ends every session of one user of the current company (they must log in again). */
  async destroyUser(userId) {
    if (this.tenants) {
      await this.pool.query('DELETE FROM sessions WHERE user_id = ? AND tenant_code = ?', [userId, tenancy.key()]);
    } else {
      await this.pool.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
    }
  }

  async cleanup() {
    await this.pool.query('DELETE FROM sessions WHERE expires <= NOW()');
  }
}

module.exports = { MySqlSessionStore };
