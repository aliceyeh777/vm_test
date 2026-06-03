const { Router } = require('express');
const { upsertTerminal, logApi } = require('../db');

const router = Router();

// POST /api/v1/terminal/firmware_update
// Device queries whether a new firmware is available
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';

  upsertTerminal(imei);

  // Real response fields (from actual log):
  //   needs_update: true/false  → set false to skip OTA
  //   lte_needs_update: false   → LTE module firmware update
  const response = {
    version: body.version || '0.000',
    url: '',
    lte_version: '',
    lte_needs_update: false,
    lte_url: '',
    needs_update: false,
  };

  logApi(imei, 'ota', req.path, body, response, 200);
  console.log(`[HTTPS] ota  ${imei}  needs_update=${response.needs_update}`);
  res.json(response);
});

module.exports = router;
