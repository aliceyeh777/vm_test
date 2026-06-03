const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');

const router = Router();

// POST /api/v1/terminal/payment/product
// Device calls this when consumer presses a product button (DC11)
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';

  upsertTerminal(imei);

  // Real server returns only payment_id + press_count (-1 = no limit)
  const response = {
    payment_id: body.payment_id || '',
    press_count: -1,
  };

  logApi(imei, 'product', req.path, body, response, 200);
  console.log(`[HTTPS] product  ${imei}  payment_id=${response.payment_id}  price=${body.price}`);
  res.json(response);
});

module.exports = router;
