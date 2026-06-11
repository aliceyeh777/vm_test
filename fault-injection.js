// fault-injection.js
// Global fault injection: intercept any route and simulate failures.
// Usage in a route: if (fi.applyFault(res, 'notify')) return;

const TIMEOUT_CLEANUP_MS = 10000; // clean up hanging response after 10s

const faults = {};

// Modes available per route (for reference by UI)
const ROUTE_CONFIG = {
  notify:  ['500', 'timeout', 'bad_json', 'close'],
  batch:   ['500', 'timeout', 'bad_json', 'close'],
  confirm: ['500', 'timeout'],
  product: ['500', 'timeout'],
  token:   ['500', 'timeout'],
};

function setFault(route, mode) {
  if (!(route in ROUTE_CONFIG)) return false;
  faults[route] = mode || null;
  return true;
}

function applyFault(res, route) {
  const mode = faults[route];
  if (!mode) return false;

  console.log(`[FAULT] ${route} → ${mode}`);

  if (mode === '500') {
    res.status(500).json({ error: 'simulated server error' });
    return true;
  }

  if (mode === 'bad_json') {
    // HTTP 200 but invalid body — device JSON parse will fail
    res.status(200).set('Content-Type', 'application/json').send('INVALID_JSON');
    return true;
  }

  if (mode === 'timeout') {
    // Don't respond — device hits GPLUS_API_TIMEOUT_MS (5s), then we clean up
    const timer = setTimeout(() => {
      try { res.status(504).end(); } catch (_) {}
    }, TIMEOUT_CLEANUP_MS);
    res.on('close', () => clearTimeout(timer));
    return true;
  }

  if (mode === 'close') {
    // 500 + Connection: close — device detects peer closed and reconnects
    res.status(500).set('Connection', 'close').end();
    return true;
  }

  return false;
}

function getFaults() {
  return Object.fromEntries(
    Object.keys(ROUTE_CONFIG).map(r => [r, faults[r] || null])
  );
}

module.exports = { setFault, applyFault, getFaults, ROUTE_CONFIG };
