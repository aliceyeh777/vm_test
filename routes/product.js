const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');
const fi = require('../fault-injection');

const router = Router();

// Latest product state per terminal: imei → { payment_id, column, price, at }
const latestProduct = new Map();

// POST /api/v1/terminal/payment/product
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const paymentId = body.payment_id || '';
  const column = body.column_number || '?';
  const price = body.price || 0;

  upsertTerminal(imei);

  if (fi.applyFault(res, 'product')) return;

  // Track latest product selection for this terminal
  latestProduct.set(imei, { payment_id: paymentId, column, price, at: Date.now() });

  const response = { payment_id: paymentId, press_count: -1 };
  logApi(imei, 'product', req.path, body, response, 200);
  console.log(`[HTTPS] product  ${imei}  payment_id=${paymentId}  col=${column}  price=${price}`);
  fi.sendResponse(res, 'product', response);

  // Notify browser via SSE
  const sseEmit = req.app.locals.sseEmit;
  if (sseEmit) {
    sseEmit('product', { imei, payment_id: paymentId, column, price });
  }
});

// Clear on cancel
function clearPendingConfirm(imei) {
  latestProduct.delete(imei);
}

// Get latest product state (used by control panel UI)
function getLatestProduct(imei) {
  return latestProduct.get(imei) || null;
}

// age_ms is computed here so the browser does not depend on its own clock
function getAllLatestProducts() {
  const now = Date.now();
  const out = {};
  for (const [imei, p] of latestProduct) out[imei] = { ...p, age_ms: now - p.at };
  return out;
}

module.exports = router;
module.exports.clearPendingConfirm = clearPendingConfirm;
module.exports.getAllLatestProducts = getAllLatestProducts;
