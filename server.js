require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const { getRecentLogs, getRecentWsMessages, getAllTerminals } = require('./db');
const routes = require('./routes');
const wsHandler = require('./ws/handler');
const productRoute = require('./routes/product');

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

// ─── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// WebSocket server shares the same HTTP server (same port)
const wss = new WebSocketServer({ server });
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
