const { Router } = require('express');
const { upsertTerminal, logApi, logTransaction } = require('../db');
const fi = require('../fault-injection');

const router = Router();

// Per-terminal reject flag: imei → 'reject'|'conflict'|null
const rejectNext = new Map();

function setRejectNext(imei, mode) {
  rejectNext.set(imei, mode);  // 'reject'=402, 'conflict'=409
}

function getRejectMode(imei) {
  return rejectNext.get(imei) || null;
}

// POST /api/v1/terminal/payment/confirm
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const paymentId = body.payment_id || '';

  upsertTerminal(imei);

  if (fi.applyFault(res, 'confirm')) return;

  const mode = rejectNext.get(imei);
  if (mode) {
    rejectNext.delete(imei);  // one-shot

    if (mode === 'conflict') {
      // 409 → device will retry confirm
      const response = { error: 'conflict', payment_id: paymentId };
      logApi(imei, 'confirm', req.path, body, response, 409);
      logTransaction(imei, paymentId, 'confirm', 0, 'conflict');
      console.log(`[HTTPS] confirm REJECTED(409)  ${imei}  payment_id=${paymentId}`);
      return res.status(409).json(response);
    } else {
      // 402 → device treats as rejected, goes to PAYMENT_CONFIRM_TIMEOUT
      const response = { error: 'payment declined', payment_id: paymentId };
      logApi(imei, 'confirm', req.path, body, response, 402);
      logTransaction(imei, paymentId, 'confirm', 0, 'declined');
      console.log(`[HTTPS] confirm REJECTED(402)  ${imei}  payment_id=${paymentId}`);
      return res.status(402).json(response);
    }
  }

  // Normal: payment success
  const response = { balance: 0, payment_id: paymentId };
  logApi(imei, 'confirm', req.path, body, response, 200);
  logTransaction(imei, paymentId, 'confirm', body.price || 0, 'success');
  console.log(`[HTTPS] confirm OK  ${imei}  payment_id=${paymentId}`);
  res.json(response);
});

module.exports = router;
module.exports.setRejectNext = setRejectNext;
module.exports.getRejectMode = getRejectMode;
