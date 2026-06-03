const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { upsertTerminal, saveToken, logApi } = require('../db');

const router = Router();

// POST /api/v1/terminal/token
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';

  upsertTerminal(imei);

  const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  saveToken(imei, token);

  const response = { result: 0, token };
  logApi(imei, 'token', req.path, body, response, 200);
  console.log(`[HTTPS] token  ${imei} → token=${token.slice(0, 8)}...`);
  res.json(response);
});

module.exports = router;
