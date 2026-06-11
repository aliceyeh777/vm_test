const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');
const fi = require('../fault-injection');

const router = Router();

// POST /api/v1/terminal/collation/batch
// Daily batch upload for collation
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';

  upsertTerminal(imei);

  if (fi.applyFault(res, 'batch')) return;

  const response = { result: 0, message: 'batch accepted' };
  logApi(imei, 'batch', req.path, body, response, 200);
  console.log(`[HTTPS] batch  ${imei}`);
  res.json(response);
});

module.exports = router;
