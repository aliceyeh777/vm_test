const { Router } = require('express');
const fi = require('../fault-injection');

const router = Router();

// GET /ctrl/fault — current fault status for all routes
router.get('/', (_req, res) => {
  res.json(fi.getFaults());
});

// POST /ctrl/fault — set or clear a fault
// body: { route: 'notify', mode: '500' | 'timeout' | 'bad_json' | 'close' | null }
router.post('/', (req, res) => {
  const { route, mode } = req.body || {};
  if (!route) return res.status(400).json({ error: 'route required' });
  const ok = fi.setFault(route, mode || null);
  if (!ok) return res.status(400).json({ error: `unknown route: ${route}` });
  console.log(`[FAULT] set ${route} → ${mode || 'normal'}`);
  res.json({ ok: true, faults: fi.getFaults() });
});

module.exports = router;
