const express = require('express');
const callControl = require('../../call-control');
const { requireCaller } = require('../middleware/auth');

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
  requireCaller,
  callControlRoute((ext) => callControl.transferTargets(ext)),
);

router.get(
  '/agent/call/control',
  requireCaller,
  callControlRoute(async (ext) => callControl.viewFor(ext)),
);

router.post(
  '/agent/call/transfer',
  requireCaller,
  callControlRoute((ext, req) => callControl.transfer(ext, req.body || {})),
);

router.post(
  '/agent/call/complete',
  requireCaller,
  callControlRoute((ext) => callControl.completeTransfer(ext)),
);

router.post(
  '/agent/call/merge',
  requireCaller,
  callControlRoute((ext) => callControl.merge(ext)),
);

router.post(
  '/agent/call/cancel',
  requireCaller,
  callControlRoute((ext) => callControl.cancelConsult(ext)),
);

router.post(
  '/agent/call/drop',
  requireCaller,
  callControlRoute((ext, req) => callControl.dropParty(ext, String((req.body || {}).partyId || ''))),
);

router.post(
  '/agent/call/leave',
  requireCaller,
  callControlRoute((ext) => callControl.leave(ext)),
);

module.exports = router;
