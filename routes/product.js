const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');

const router = Router();

// Latest product state per terminal: imei → { payment_id, column, price }
const latestProduct = new Map();

// POST /api/v1/terminal/payment/product
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';
  const paymentId = body.payment_id || '';
  const column = body.column_number || '?';
  const price = body.price || 0;

  upsertTerminal(imei);

  // Track latest product selection for this terminal
  latestProduct.set(imei, { payment_id: paymentId, column, price });

  const response = { payment_id: paymentId, press_count: -1 };
  logApi(imei, 'product', req.path, body, response, 200);
  console.log(`[HTTPS] product  ${imei}  payment_id=${paymentId}  col=${column}  price=${price}`);
  res.json(response);
});

// Clear on cancel
function clearPendingConfirm(imei) {
  latestProduct.delete(imei);
}

// Get latest product state (used by control panel UI)
function getLatestProduct(imei) {
  return latestProduct.get(imei) || null;
}

function getAllLatestProducts() {
  return Object.fromEntries(latestProduct);
}

module.exports = router;
module.exports.clearPendingConfirm = clearPendingConfirm;
module.exports.getAllLatestProducts = getAllLatestProducts;
