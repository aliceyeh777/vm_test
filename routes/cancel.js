const { Router } = require('express');
const { upsertTerminal, logApi, logTransaction } = require('../db');
const { clearPendingConfirm } = require('./product');

const router = Router();

// POST /api/v1/terminal/payment/cancel
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const paymentId = body.payment_id || '';

  upsertTerminal(imei);

  // Real server returns only payment_id
  const response = { payment_id: paymentId };

  clearPendingConfirm(imei);  // cancel 時清掉 auto confirm 計時器
  logApi(imei, 'cancel', req.path, body, response, 200);
  logTransaction(imei, paymentId, 'cancel', 0, 'cancelled');
  console.log(`[HTTPS] cancel  ${imei}  payment_id=${paymentId}  reason=${body.reason || '-'}`);
  res.json(response);
});

module.exports = router;
