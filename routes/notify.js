const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');
const fi = require('../fault-injection');

const router = Router();

// POST /api/v1/terminal/collation/notify
// Called after each CL or cash transaction to upload POS data
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';

  upsertTerminal(imei);

  if (fi.applyFault(res, 'notify')) return;

  const response = { result: 0, message: 'notify accepted' };
  logApi(imei, 'notify', req.path, body, response, 200);
  console.log(`[HTTPS] notify  ${imei}  payment_id=${body.payment_id || '-'}`);
  res.json(response);
});

module.exports = router;
