// Serves the React app (built from web/ into backend/web-dist) at /app.
// Any /app/... URL that isn't a file gets index.html, so React Router can
// handle deep links and page refreshes.
const fs = require('fs');
const path = require('path');
const express = require('express');

function mountWebApp(app, distDir = process.env.WEB_DIST_PATH || path.join(__dirname, '..', 'web-dist')) {
  const indexFile = path.join(distDir, 'index.html');

  // Built asset names contain a content hash, so browsers may cache them for good.
  app.use(
    '/app/assets',
    express.static(path.join(distDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }),
  );
  app.use('/app', express.static(distDir, { index: false }));
  app.use('/app', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!fs.existsSync(indexFile)) {
      return res.status(503).type('text').send('The new app is not built yet. Run: npm --prefix web run build');
    }
    // Always check for a new version of the page itself (it names the current assets).
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });
}

module.exports = { mountWebApp };
