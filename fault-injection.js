// fault-injection.js
// Global fault injection: intercept any route and simulate failures.
// Usage in a route: if (fi.applyFault(res, 'notify')) return;

const TIMEOUT_CLEANUP_MS = 10000; // clean up hanging response after 10s
const BIG_PAD_LEN = 1500;          // 'big': JSON over 1024 bytes → several +CHTTPSRECV DATA frames
const SPLIT_BODY_DELAY_MS = 800;   // 'split': body sent this long after the HTTP header

const faults = {};

// Modes available per route (for reference by UI)
const ROUTE_CONFIG = {
  notify:  ['500', 'timeout', 'bad_json', 'close', 'big', 'split'],
  batch:   ['500', 'timeout', 'bad_json', 'close'],
  confirm: ['500', 'timeout', 'big', 'split'],
  product: ['500', 'timeout', 'big', 'split'],
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

// Send a successful JSON response, shaped by the response modes 'big' / 'split'
// (applyFault() does not handle them: the request itself succeeds).
// 'big' pads the JSON so the terminal's module returns it in several frames;
// 'split' sends the HTTP header first, so the module may hold only the header
// when the terminal starts reading.
function sendResponse(res, route, obj) {
  const mode = faults[route];

  if (mode === 'big') {
    obj = { ...obj, _pad: 'x'.repeat(BIG_PAD_LEN) };
  }

  if (mode === 'split') {
    const body = JSON.stringify(obj);
    res.status(200)
      .set('Content-Type', 'application/json; charset=utf-8')
      .set('Content-Length', Buffer.byteLength(body));
    res.flushHeaders();
    setTimeout(() => {
      try { res.end(body); } catch (_) {}
    }, SPLIT_BODY_DELAY_MS);
    return;
  }

  res.json(obj);
}

function getFaults() {
  return Object.fromEntries(
    Object.keys(ROUTE_CONFIG).map(r => [r, faults[r] || null])
  );
}

module.exports = { setFault, applyFault, sendResponse, getFaults, ROUTE_CONFIG };
