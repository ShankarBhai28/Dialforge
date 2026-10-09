// Builds the Express app: middleware + every route module. No network
// connections are opened here, so tests can create an app freely.
const path = require('path');
const express = require('express');
const session = require('express-session');
const { mountWebApp } = require('./webApp');

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
  'dashboard',
  'reports',
];

function createSessionMiddleware() {
  return session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000, secure: true }, // 8 hour login, HTTPS-only cookie
  });
}

function createApp({ sessionMiddleware = createSessionMiddleware(), webDistDir } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  mountWebApp(app, webDistDir);
  app.use(sessionMiddleware);
  for (const name of ROUTERS) app.use(require(`./routes/${name}`));
  return app;
}

module.exports = { createApp, createSessionMiddleware, ROUTERS };
