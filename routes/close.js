const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');

const router = Router();

// POST /api/v1/terminal/close
// Called on DC16 (cash register close / end-of-day)
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';

  upsertTerminal(imei);

  const response = { result: 0, message: 'close accepted' };
  logApi(imei, 'close', req.path, body, response, 200);
  console.log(`[HTTPS] close  ${imei}`);
  res.json(response);
});

module.exports = router;
