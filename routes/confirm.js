const { Router } = require('express');
const { upsertTerminal, logApi, logTransaction } = require('../db');

const router = Router();

// POST /api/v1/terminal/payment/confirm
// Device calls this after NFC card is read successfully
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const paymentId = body.payment_id || '';

  upsertTerminal(imei);

  // Real server returns balance + payment_id
  const response = {
    balance: 0,
    payment_id: paymentId,
  };

  logApi(imei, 'confirm', req.path, body, response, 200);
  logTransaction(imei, paymentId, 'confirm', 150, 'success');
  console.log(`[HTTPS] confirm  ${imei}  payment_id=${paymentId}`);
  res.json(response);
});

module.exports = router;
