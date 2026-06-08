const { logWs } = require('../db');

// imei → WebSocket client
const clients = new Map();

function extractTerminalId(req) {
  const raw = req.url || '';
  // Use regex to handle both relative (/?terminal_id=X) and absolute (wss://host/?terminal_id=X)
  // Also handles cases where Railway proxy may modify URL format
  const m = raw.match(/[?&]terminal_id=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);

  // Fallback: try standard URL parsing
  try {
    const base = raw.startsWith('http') ? raw : `http://x${raw}`;
    const u = new URL(base);
    const tid = u.searchParams.get('terminal_id');
    if (tid) return tid;
  } catch {}

  return 'unknown';
}

function init(wss) {
  wss.on('connection', (ws, req) => {
    // Real device connects: GET wss://host/?terminal_id=IMEI&token=TOKEN
    let imei = extractTerminalId(req);

    // Debug: log raw URL so we can diagnose Railway proxy behavior
    console.log(`[WS] Connected: imei=${imei}  url=${req.url}  host=${req.headers.host}`);
    clients.set(imei, ws);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // WebSocket protocol Ping frame (0x89) is handled automatically by 'ws' library.
        // Any other binary frame just log it.
        console.log(`[WS] Binary frame from ${imei}, len=${data.length}`);
        return;
      }

      const raw = data.toString();
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        console.log(`[WS] Non-JSON from ${imei}: ${raw}`);
        return;
      }

      const type = msg.type || 'unknown';
      console.log(`[WS] RECV ← ${imei}  type=${type}`);
      logWs(imei, 'recv', type, msg);

      // Update imei if terminal identifies itself
      if (msg.terminal_id && msg.terminal_id !== imei) {
        clients.delete(imei);
        imei = msg.terminal_id;
        clients.set(imei, ws);
      }

      // Handle log upload (device sends debug log)
      if (type === 'log') {
        console.log(`[WS] LOG from ${imei}:`, msg.messages);
      }
    });

    ws.on('ping', () => {
      // 'ws' library auto-responds with Pong; just log it
      console.log(`[WS] Ping from ${imei}`);
    });

    ws.on('close', () => {
      console.log(`[WS] Disconnected: ${imei}`);
      clients.delete(imei);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error from ${imei}:`, err.message);
    });
  });
}

// Push a command to a specific terminal by IMEI
function pushToTerminal(imei, type, extra = {}) {
  const ws = clients.get(imei);
  if (!ws || ws.readyState !== 1 /* OPEN */) {
    console.warn(`[WS] Push failed: ${imei} not connected`);
    return false;
  }
  const payload = { type, ...extra };
  ws.send(JSON.stringify(payload));
  logWs(imei, 'send', type, payload);
  console.log(`[WS] SEND → ${imei}  type=${type}`);
  return true;
}

// Broadcast to all connected terminals
function broadcast(type, extra = {}) {
  const payload = JSON.stringify({ type, ...extra });
  let count = 0;
  for (const [imei, ws] of clients.entries()) {
    if (ws.readyState === 1) {
      ws.send(payload);
      logWs(imei, 'send', type, { type, ...extra });
      count++;
    }
  }
  return count;
}

function getConnectedTerminals() {
  return [...clients.keys()];
}

module.exports = { init, pushToTerminal, broadcast, getConnectedTerminals };
