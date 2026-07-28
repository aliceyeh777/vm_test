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

  -- Uploaded OTA firmware images (Ameba main firmware or SIM7500 LTE delta)
  CREATE TABLE IF NOT EXISTS ota_files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    filename       TEXT NOT NULL,
    stored_path    TEXT NOT NULL,
    size           INTEGER,
    sha256         TEXT,
    kind           TEXT,            -- 'ameba' | 'lte' (auto-detected by OTA1 magic)
    is_valid_ameba INTEGER DEFAULT 0,
    target_version TEXT,            -- version device will report after this OTA
    img_len        INTEGER,         -- parsed from OTA1 header (ameba only)
    checksum       TEXT,            -- parsed OTA1 checksum, hex (ameba only)
    download_count INTEGER DEFAULT 0,
    last_download_at TEXT,
    uploaded_at    TEXT DEFAULT (datetime('now'))
  );

  -- Per-terminal armed OTA target + progress state.
  -- imei = '*' means "offer to any terminal" (broadcast default).
  CREATE TABLE IF NOT EXISTS ota_targets (
    imei           TEXT PRIMARY KEY,
    file_id        INTEGER NOT NULL,
    transport      TEXT NOT NULL,   -- 'ameba' | 'lte'
    target_version TEXT,
    state          TEXT DEFAULT 'armed', -- armed|offered|downloading|downloaded|verified|already_current
    offered_count  INTEGER DEFAULT 0,
    bytes_sent     INTEGER DEFAULT 0,
    armed_at       TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
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

// ─── OTA files ──────────────────────────────────────────────────────────────

function insertOtaFile(meta) {
  const info = db.prepare(`
    INSERT INTO ota_files
      (filename, stored_path, size, sha256, kind, is_valid_ameba, target_version, img_len, checksum)
    VALUES (@filename, @stored_path, @size, @sha256, @kind, @is_valid_ameba, @target_version, @img_len, @checksum)
  `).run(meta);
  return info.lastInsertRowid;
}

function listOtaFiles() {
  return db.prepare(`SELECT * FROM ota_files ORDER BY uploaded_at DESC`).all();
}

function getOtaFile(id) {
  return db.prepare(`SELECT * FROM ota_files WHERE id = ?`).get(id);
}

function deleteOtaFile(id) {
  db.prepare(`DELETE FROM ota_targets WHERE file_id = ?`).run(id);
  return db.prepare(`DELETE FROM ota_files WHERE id = ?`).run(id).changes;
}

function bumpOtaDownload(id, bytes) {
  db.prepare(`
    UPDATE ota_files
       SET download_count = download_count + 1,
           last_download_at = datetime('now')
     WHERE id = ?
  `).run(id);
}

// ─── OTA targets (armed state per terminal) ─────────────────────────────────

function armOta(imei, fileId, transport, targetVersion) {
  db.prepare(`
    INSERT INTO ota_targets (imei, file_id, transport, target_version, state, offered_count, bytes_sent, armed_at, updated_at)
    VALUES (?, ?, ?, ?, 'armed', 0, 0, datetime('now'), datetime('now'))
    ON CONFLICT(imei) DO UPDATE SET
      file_id = excluded.file_id,
      transport = excluded.transport,
      target_version = excluded.target_version,
      state = 'armed',
      offered_count = 0,
      bytes_sent = 0,
      armed_at = datetime('now'),
      updated_at = datetime('now')
  `).run(imei, fileId, transport, targetVersion);
}

function disarmOta(imei) {
  return db.prepare(`DELETE FROM ota_targets WHERE imei = ?`).run(imei).changes;
}

// Resolve the armed target for a terminal: exact imei match first, then the
// wildcard '*' broadcast row as fallback.
function getArmedTarget(imei) {
  return db.prepare(`SELECT * FROM ota_targets WHERE imei = ?`).get(imei)
      || db.prepare(`SELECT * FROM ota_targets WHERE imei = '*'`).get();
}

function setOtaTargetState(imei, state, patch = {}) {
  const fields = ['state = @state', "updated_at = datetime('now')"];
  const params = { imei, state };
  if (patch.offered_count_inc) fields.push('offered_count = offered_count + 1');
  if (patch.bytes_sent != null) { fields.push('bytes_sent = @bytes_sent'); params.bytes_sent = patch.bytes_sent; }
  db.prepare(`UPDATE ota_targets SET ${fields.join(', ')} WHERE imei = @imei`).run(params);
}

// Update any target(s) pointing at a given file — used by the download endpoint,
// which cannot know the terminal's imei from the raw firmware GET.
function setOtaTargetStateByFile(fileId, fromStates, state, patch = {}) {
  const placeholders = fromStates.map(() => '?').join(',');
  const extra = patch.bytes_sent != null ? `, bytes_sent = ${Number(patch.bytes_sent)}` : '';
  return db.prepare(`
    UPDATE ota_targets
       SET state = ?, updated_at = datetime('now')${extra}
     WHERE file_id = ? AND state IN (${placeholders})
  `).run(state, fileId, ...fromStates).changes;
}

function listOtaTargets() {
  return db.prepare(`
    SELECT t.*, f.filename, f.size, f.kind
      FROM ota_targets t LEFT JOIN ota_files f ON f.id = t.file_id
     ORDER BY t.updated_at DESC
  `).all();
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
  insertOtaFile,
  listOtaFiles,
  getOtaFile,
  deleteOtaFile,
  bumpOtaDownload,
  armOta,
  disarmOta,
  getArmedTarget,
  setOtaTargetState,
  setOtaTargetStateByFile,
  listOtaTargets,
};
