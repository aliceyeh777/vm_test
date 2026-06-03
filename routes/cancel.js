const { Router } = require('express');
const { upsertTerminal, logApi, logTransaction } = require('../db');

const router = Router();

// POST /api/v1/terminal/payment/cancel
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const paymentId = body.payment_id || '';

  upsertTerminal(imei);

  // Real server returns only payment_id
  const response = { payment_id: paymentId };

  logApi(imei, 'cancel', req.path, body, response, 200);
  logTransaction(imei, paymentId, 'cancel', 0, 'cancelled');
  console.log(`[HTTPS] cancel  ${imei}  payment_id=${paymentId}  reason=${response.cancel_reason}`);
  res.json(response);
});

module.exports = router;
