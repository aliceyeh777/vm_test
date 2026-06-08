require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const { getRecentLogs, getRecentWsMessages, getAllTerminals } = require('./db');
const routes = require('./routes');
const wsHandler = require('./ws/handler');
const productRoute = require('./routes/product');
const confirmRoute = require('./routes/confirm');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTPS Mock APIs ─────────────────────────────────────────────────────────
app.use('/api/v1/terminal', routes);

// ─── Control Panel APIs (used by the web UI) ─────────────────────────────────

// Push a WS command to a specific terminal
app.post('/ctrl/push', (req, res) => {
  const { imei, type, ...extra } = req.body || {};
  if (!imei || !type) return res.status(400).json({ error: 'imei and type required' });
  const ok = wsHandler.pushToTerminal(imei, type, extra);
  res.json({ ok });
});

// Broadcast a WS command to all connected terminals
app.post('/ctrl/broadcast', (req, res) => {
  const { type, ...extra } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  const count = wsHandler.broadcast(type, extra);
  res.json({ ok: true, count });
});

// List connected terminals (live WS)
app.get('/ctrl/terminals', (_req, res) => {
  res.json(wsHandler.getConnectedTerminals());
});

// List all known terminals (DB)
app.get('/ctrl/terminals/all', (_req, res) => {
  res.json(getAllTerminals());
});

// Recent HTTPS API logs
app.get('/ctrl/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(getRecentLogs(limit));
});

// Recent WS messages
app.get('/ctrl/ws-messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(getRecentWsMessages(limit));
});

// Latest product selection per terminal (for payment_confirm button)
app.get('/ctrl/latest-products', (_req, res) => {
  res.json(productRoute.getAllLatestProducts());
});

// Set next confirm response to reject (one-shot per terminal)
// mode: 'reject'=402 payment declined, 'conflict'=409 retry
app.post('/ctrl/confirm-reject', (req, res) => {
  const { imei, mode } = req.body || {};
  if (!imei) return res.status(400).json({ error: 'imei required' });
  confirmRoute.setRejectNext(imei, mode || 'reject');
  console.log(`[CTRL] Next confirm for ${imei} will be rejected (${mode || 'reject'})`);
  res.json({ ok: true, imei, mode: mode || 'reject' });
});

// Get current reject mode for a terminal
app.get('/ctrl/confirm-reject/:imei', (req, res) => {
  res.json({ mode: confirmRoute.getRejectMode(req.params.imei) });
});

// ─── SSE: real-time events to browser ────────────────────────────────────────
const sseClients = new Set();

app.get('/ctrl/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function sseEmit(eventType, data) {
  const payload = `data: ${JSON.stringify({ type: eventType, ...data })}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Export so routes can use it
app.locals.sseEmit = sseEmit;

// ─── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// WebSocket server shares the same HTTP server (same port)
const wss = new WebSocketServer({ server });

// Railway's proxy normalizes header names to Title-Case:
//   upgrade: websocket  →  Upgrade: websocket
// The firmware checks with case-sensitive strstr("upgrade: websocket").
// Fix: inject a custom header whose VALUE contains the exact string the
// firmware looks for. Railway preserves header values, only title-cases names.
wss.on('headers', (headers) => {
  headers.push('X-WS-Compat: upgrade: websocket');
});

wsHandler.init(wss);

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  Mock Jihan Server  →  http://localhost:${PORT}  ║
╚══════════════════════════════════════════════╝
  HTTPS APIs : /api/v1/terminal/*
  WebSocket  : ws://localhost:${PORT}/<IMEI>
  Control UI : http://localhost:${PORT}
`);
});
