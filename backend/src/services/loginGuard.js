// Slows down password guessing on /auth/login.
//
//   - per username: 5 failed logins within 15 minutes lock that username
//     for 15 minutes (protects one account from being guessed);
//   - per IP address: 20 failed logins within 15 minutes block that address
//     for 15 minutes (protects against trying many usernames).
// A successful login clears the username's count. Kept in memory: a restart
// clears it, which is fine for slowing guessing down. The message never says
// whether the username exists.
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_IP = 20;

class LoginGuard {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byUser = new Map(); // key -> { fails: [ms...], lockedUntil }
    this.byIp = new Map();
  }

  entry(map, key) {
    let e = map.get(key);
    if (!e) {
      e = { fails: [], lockedUntil: 0 };
      map.set(key, e);
    }
    return e;
  }

  /** Minutes until this login may be tried again, or 0 if it may now. */
  blockedFor(username, ip) {
    const t = this.now();
    const until = Math.max(
      this.byUser.get(String(username).toLowerCase())?.lockedUntil ?? 0,
      this.byIp.get(ip)?.lockedUntil ?? 0,
    );
    return until > t ? Math.ceil((until - t) / 60000) : 0;
  }

  /** Records a failed login; true when this failure just caused a lock. */
  fail(username, ip) {
    const t = this.now();
    let locked = false;
    for (const [map, key, max] of [
      [this.byUser, String(username).toLowerCase(), MAX_PER_USER],
      [this.byIp, ip, MAX_PER_IP],
    ]) {
      const e = this.entry(map, key);
      e.fails = e.fails.filter((ms) => t - ms < WINDOW_MS);
      e.fails.push(t);
      if (e.fails.length >= max) {
        e.lockedUntil = t + LOCK_MS;
        e.fails = [];
        locked = true;
      }
    }
    this.prune(t);
    return locked;
  }

  succeed(username) {
    this.byUser.delete(String(username).toLowerCase());
  }

  /** Forget entries that no longer matter, so the maps can't grow forever. */
  prune(t) {
    for (const map of [this.byUser, this.byIp]) {
      if (map.size < 1000) continue;
      for (const [k, e] of map) if (e.lockedUntil < t && !e.fails.some((ms) => t - ms < WINDOW_MS)) map.delete(k);
    }
  }
}

module.exports = { LoginGuard, MAX_PER_USER, MAX_PER_IP, WINDOW_MS, LOCK_MS, guard: new LoginGuard() };
