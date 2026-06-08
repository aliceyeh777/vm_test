const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');
const wsHandler = require('../ws/handler');

const router = Router();

// Delay before auto-pushing payment_confirm_request (ms)
// Simulates the time between product selection and NFC card tap
const AUTO_CONFIRM_DELAY_MS = parseInt(process.env.AUTO_CONFIRM_DELAY_MS || '4000');

// imei → { timer, payment_id }
// Tracks pending auto-confirm per terminal.
// If consumer changes selection (new product API with same payment_id), timer resets.
const pendingConfirms = new Map();

// POST /api/v1/terminal/payment/product
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const paymentId = body.payment_id || '';
  const column = body.column_number || '?';
  const price = body.price || 0;

  upsertTerminal(imei);

  const response = {
    payment_id: paymentId,
    press_count: -1,
  };

  logApi(imei, 'product', req.path, body, response, 200);
  console.log(`[HTTPS] product  ${imei}  payment_id=${paymentId}  col=${column}  price=${price}`);
  res.json(response);

  // ── Auto payment_confirm_request ────────────────────────────────────────────
  // Clear previous timer (consumer changed selection)
  const existing = pendingConfirms.get(imei);
  if (existing) {
    clearTimeout(existing.timer);
    console.log(`[AUTO] Reset confirm timer for ${imei} (col changed to ${column})`);
  }

  // Schedule new confirm push
  const timer = setTimeout(() => {
    pendingConfirms.delete(imei);
    const ok = wsHandler.pushToTerminal(imei, 'payment_confirm_request', { payment_id: paymentId });
    if (ok) {
      console.log(`[AUTO] payment_confirm_request → ${imei}  payment_id=${paymentId}`);
    } else {
      console.log(`[AUTO] Skipped: ${imei} not connected via WS`);
    }
  }, AUTO_CONFIRM_DELAY_MS);

  pendingConfirms.set(imei, { timer, paymentId });
});

// Allow cancel API to clear pending confirm (avoid pushing after cancel)
function clearPendingConfirm(imei) {
  const existing = pendingConfirms.get(imei);
  if (existing) {
    clearTimeout(existing.timer);
    pendingConfirms.delete(imei);
    console.log(`[AUTO] Cancelled confirm timer for ${imei}`);
  }
}

module.exports = router;
module.exports.clearPendingConfirm = clearPendingConfirm;
