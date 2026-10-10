// The audit log (table audit_log): who changed what, when, and what it was
// before. Every admin-side change is recorded by auditMiddleware (below)
// without each route doing anything; logins / logouts and system actions
// call audit() directly. Writing the log never breaks the request.
const pool = require('../../db');

// Fields never stored: secrets in requests and in row snapshots.
const SECRET_KEYS = new Set(['password', 'password_hash', 'sip_password', 'sipPassword', 'secret']);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.has(k) ? '[hidden]' : redact(v);
    return out;
  }
  return value;
}

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(redact(v)));

/** Writes one audit row. `user` = the session user, or null for the system. */
async function audit(entry, deps = { pool }) {
  const {
    user = null,
    action,
    entity = null,
    entityId = null,
    status = null,
    summary = null,
    request,
    before,
    after,
    ip,
  } = entry;
  // A failed login has no user yet - keep the name that was typed.
  const username = user ? user.username : entry.username || 'system';
  try {
    await deps.pool.query(
      `INSERT INTO audit_log (user_id, username, action, entity, entity_id, status, summary, request_json, before_json, after_json, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user ? user.id : null,
        username,
        action,
        entity,
        entityId == null ? null : String(entityId),
        status,
        summary ? String(summary).slice(0, 255) : null,
        json(request),
        json(before),
        json(after),
        ip || null,
      ],
    );
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

// --- Automatic recording of admin-side changes ---
//
// /admin/<resource>[/<id>[/<sub>]] -> the table whose row is snapshotted
// before and after. Sub-resources (dispositions, recycle-rules, password,
// dialer, ...) still record the parent row and the request.
const TABLES = {
  campaigns: 'campaigns',
  users: 'users',
  roles: 'roles',
  teams: 'teams',
  queues: 'queues',
  dids: 'dids',
  dnc: 'dnc_numbers',
  forms: 'forms',
  lists: 'lists',
  leads: 'leads',
  callbacks: 'callbacks',
  'live-agents': 'users',
};
// Row snapshots: never secrets (redact() also hides them, this keeps them out of memory).
const COLUMNS = {
  users: 'id, username, role, role_id, status, extension_id',
};

function parseAdminPath(path) {
  const m = /^\/admin\/([a-z-]+)(?:\/([^/]+))?(?:\/([a-z-]+))?\/?$/.exec(path);
  if (!m) return null;
  const [, resource, id, sub] = m;
  return {
    resource,
    table: TABLES[resource] || null,
    id: id && /^\d+$/.test(id) ? id : null,
    sub: sub || (id && !/^\d+$/.test(id) ? id : null),
  };
}

const VERBS = { POST: 'create', PUT: 'edit', DELETE: 'delete' };

/** "campaigns.edit", "campaigns.dialer", "users.password", "leads.import", ... */
function actionName(method, p) {
  if (p.sub) return `${p.resource}.${p.sub}`;
  if (method === 'POST' && p.id) return `${p.resource}.update`;
  return `${p.resource}.${VERBS[method] || method.toLowerCase()}`;
}

async function snapshot(table, id, deps) {
  if (!table || !id) return null;
  try {
    const [rows] = await deps.pool.query(`SELECT ${COLUMNS[table] || '*'} FROM ${table} WHERE id = ?`, [id]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Records every POST / PUT / DELETE under /admin (and agent outcomes) after it
 * finishes, refused ones included (status 403 / 400 shows attempts).
 */
function auditMiddleware(deps = { pool }) {
  return async (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const p = parseAdminPath(req.path);
    if (!p) return next();
    const before = await snapshot(p.table, p.id, deps);
    // The created row's id comes back in the response body ({ id, ... }).
    let responseBody = null;
    const json = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return json(body);
    };
    res.on('finish', async () => {
      const user = req.session && req.session.user;
      const ok = res.statusCode < 400;
      const id = p.id || (ok && responseBody && responseBody.id ? responseBody.id : null);
      const after = ok && req.method !== 'DELETE' ? await snapshot(p.table, id, deps) : null;
      const request = { ...(req.body || {}) };
      if (req.file) request.file = { name: req.file.originalname, bytes: req.file.size };
      await audit(
        {
          user: user ? { id: user.id, username: user.username } : null,
          action: actionName(req.method, p),
          entity: p.table || p.resource,
          entityId: id,
          status: res.statusCode,
          summary: !ok && responseBody && responseBody.error ? `refused: ${responseBody.error}` : null,
          request: Object.keys(request).length ? request : null,
          before,
          after,
          ip: req.ip,
        },
        deps,
      );
    });
    next();
  };
}

module.exports = { audit, auditMiddleware, redact, parseAdminPath, actionName };
