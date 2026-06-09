require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/mock.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS terminals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    imei      TEXT UNIQUE NOT NULL,
    token     TEXT,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    imei          TEXT,
    api_name      TEXT,
    path          TEXT,
    request_body  TEXT,
    response_body TEXT,
    status_code   INTEGER,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ws_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    imei       TEXT,
    direction  TEXT,
    type       TEXT,
    payload    TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    imei       TEXT,
    payment_id TEXT,
    api_type   TEXT,
    amount     INTEGER,
    status     TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── helpers ────────────────────────────────────────────────────────────────

function upsertTerminal(imei) {
  db.prepare(`
    INSERT INTO terminals (imei, last_seen)
    VALUES (?, datetime('now'))
    ON CONFLICT(imei) DO UPDATE SET last_seen = datetime('now')
  `).run(imei);
}

function saveToken(imei, token) {
  db.prepare(`UPDATE terminals SET token = ? WHERE imei = ?`).run(token, imei);
}

function logApi(imei, apiName, reqPath, reqBody, resBody, statusCode) {
  db.prepare(`
    INSERT INTO api_logs (imei, api_name, path, request_body, response_body, status_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(imei, apiName, reqPath, JSON.stringify(reqBody), JSON.stringify(resBody), statusCode);
}

function logWs(imei, direction, type, payload) {
  db.prepare(`
    INSERT INTO ws_messages (imei, direction, type, payload)
    VALUES (?, ?, ?, ?)
  `).run(imei, direction, type, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function logTransaction(imei, paymentId, apiType, amount, status) {
  db.prepare(`
    INSERT INTO transactions (imei, payment_id, api_type, amount, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(imei, paymentId, apiType, amount, status);
}

function getRecentLogs(limit = 100, imei = null) {
  if (imei) {
    return db.prepare(`SELECT * FROM api_logs WHERE imei = ? ORDER BY created_at DESC LIMIT ?`).all(imei, limit);
  }
  return db.prepare(`SELECT * FROM api_logs ORDER BY created_at DESC LIMIT ?`).all(limit);
}

function getRecentWsMessages(limit = 100, imei = null) {
  if (imei) {
    return db.prepare(`SELECT * FROM ws_messages WHERE imei = ? ORDER BY created_at DESC LIMIT ?`).all(imei, limit);
  }
  return db.prepare(`SELECT * FROM ws_messages ORDER BY created_at DESC LIMIT ?`).all(limit);
}

function getAllTerminals() {
  return db.prepare(`SELECT * FROM terminals ORDER BY last_seen DESC`).all();
}

module.exports = {
  db,
  upsertTerminal,
  saveToken,
  logApi,
  logWs,
  logTransaction,
  getRecentLogs,
  getRecentWsMessages,
  getAllTerminals,
};
