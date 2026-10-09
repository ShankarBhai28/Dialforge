const express = require('express');
const callControl = require('../../call-control');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// --- Agent: transfer / conference (see call-control.js) ---
function callControlRoute(fn) {
  return async (req, res) => {
    if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
    const ext = req.session.user.extensionName;
    if (!ext) return res.status(409).json({ error: 'connect your extension first' });
    try {
      res.json(await fn(ext, req));
    } catch (err) {
      if (!err.status) console.error('[call control]', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'call control failed' });
    }
  };
}

router.get(
  '/agent/transfer-targets',
  requireAuth,
  callControlRoute((ext) => callControl.transferTargets(ext)),
);

router.get(
  '/agent/call/control',
  requireAuth,
  callControlRoute(async (ext) => callControl.viewFor(ext)),
);

router.post(
  '/agent/call/transfer',
  requireAuth,
  callControlRoute((ext, req) => callControl.transfer(ext, req.body || {})),
);

router.post(
  '/agent/call/complete',
  requireAuth,
  callControlRoute((ext) => callControl.completeTransfer(ext)),
);

router.post(
  '/agent/call/merge',
  requireAuth,
  callControlRoute((ext) => callControl.merge(ext)),
);

router.post(
  '/agent/call/cancel',
  requireAuth,
  callControlRoute((ext) => callControl.cancelConsult(ext)),
);

router.post(
  '/agent/call/drop',
  requireAuth,
  callControlRoute((ext, req) => callControl.dropParty(ext, String((req.body || {}).partyId || ''))),
);

router.post(
  '/agent/call/leave',
  requireAuth,
  callControlRoute((ext) => callControl.leave(ext)),
);

module.exports = router;
