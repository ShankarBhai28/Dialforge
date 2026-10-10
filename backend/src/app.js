// Builds the Express app: middleware + every route module. No network
// connections are opened here, so tests can create an app freely.
const express = require('express');
const session = require('express-session');
const { mountWebApp } = require('./webApp');
const { auditMiddleware } = require('./services/audit');

// Order matters only where two routes could match the same URL; the
// original single-file order is preserved for those (see tests/routes.test.js).
const ROUTERS = [
  'health',
  'auth',
  'agent',
  'queues',
  'campaigns',
  'dids',
  'lists',
  'recycle',
  'forms',
  'dialer',
  'callControl',
  'preview',
  'callbacks',
  'dnc',
  'teams',
  'leads',
  'calls',
  'users',
  'roles',
  'audit',
  'dashboard',
  'reports',
];

/** Logins kept in MySQL (services/sessionStore.js), so a restart or deploy doesn't log anyone out. */
function createSessionMiddleware(store) {
  return session({
    store,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000, secure: true }, // 8 hour login, HTTPS-only cookie
  });
}

// audit: false only for tests without a database (the audit log needs one).
function createApp({ sessionMiddleware = createSessionMiddleware(), webDistDir, audit = true } = {}) {
  const app = express();
  app.use(express.json());
  mountWebApp(app, webDistDir);
  app.use(sessionMiddleware);
  if (audit) app.use(auditMiddleware());
  for (const name of ROUTERS) app.use(require(`./routes/${name}`));
  return app;
}

module.exports = { createApp, createSessionMiddleware, ROUTERS };
