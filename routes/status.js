const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');

const router = Router();

// POST /api/v1/terminal/status
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const reason = body.reason || '';

  upsertTerminal(imei);

  // Real server returns empty object {}
  const response = {};
  logApi(imei, 'status', req.path, body, response, 200);
  console.log(`[HTTPS] status  ${imei}  reason=${reason}`);
  res.json(response);
});

module.exports = router;
