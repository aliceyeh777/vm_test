const { Router } = require('express');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  insertOtaFile, listOtaFiles, getOtaFile, deleteOtaFile,
  armOta, disarmOta, listOtaTargets,
} = require('../db');
const wsHandler = require('../ws/handler');

const router = Router();

// Where uploaded OTA images live on disk.
const OTA_DIR = path.join(__dirname, '..', 'data', 'ota');
if (!fs.existsSync(OTA_DIR)) fs.mkdirSync(OTA_DIR, { recursive: true });

// ─── OTA1 header parsing ─────────────────────────────────────────────────────
// The FOTA file (EW7712ACL_v<ver>.bin) carries a 16-byte Realtek OTA frame
// header:  FF FF FF FF 01 00 00 00 "OTA1" 18 00 00 00
// Relative to the "OTA1" magic (4F 54 41 31):
//   +8  = Checksum (u32 LE)   +12 = ImgLen (u32 LE)
function parseOtaHeader(buf) {
  const magic = Buffer.from([0x4f, 0x54, 0x41, 0x31]); // "OTA1"
  const m = buf.indexOf(magic);
  if (m < 0 || m + 16 > buf.length) return { is_valid_ameba: 0 };
  return {
    is_valid_ameba: 1,
    checksum: '0x' + buf.readUInt32LE(m + 8).toString(16).padStart(8, '0'),
    img_len: buf.readUInt32LE(m + 12),
  };
}

// Parse a version like "9.280" / "3.280" out of a filename (EW7712ACL_v9.280.bin).
function versionFromFilename(name) {
  const m = String(name).match(/v?(\d+\.\d{1,4})/i);
  return m ? m[1] : '';
}

function fileToJson(f) {
  return {
    id: f.id,
    filename: f.filename,
    size: f.size,
    sha256: f.sha256,
    kind: f.kind,
    is_valid_ameba: !!f.is_valid_ameba,
    target_version: f.target_version,
    img_len: f.img_len,
    checksum: f.checksum,
    download_count: f.download_count,
    last_download_at: f.last_download_at,
    uploaded_at: f.uploaded_at,
  };
}

// ─── POST /ctrl/ota/upload?name=EW7712ACL_v9.280.bin ─────────────────────────
// Body is the raw binary firmware image (express.raw, see below).
router.post('/upload', express.raw({ type: '*/*', limit: '32mb' }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).json({ error: 'empty body — send the .bin as the raw request body' });
  }

  const rawName = (req.query.name || req.headers['x-ota-filename'] || `ota_${Date.now()}.bin`).toString();
  const safeName = path.basename(rawName).replace(/[^\w.\-]/g, '_');

  const hdr = parseOtaHeader(buf);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  // OTA1 magic present → Ameba main firmware; otherwise assume LTE delta package.
  const kind = hdr.is_valid_ameba ? 'ameba' : 'lte';

  // Stored filename is prefixed so multiple uploads of the same name coexist.
  const storedName = `${sha256.slice(0, 8)}_${safeName}`;
  const storedPath = path.join(OTA_DIR, storedName);
  fs.writeFileSync(storedPath, buf);

  const id = insertOtaFile({
    filename: safeName,
    stored_path: storedPath,
    size: buf.length,
    sha256,
    kind,
    is_valid_ameba: hdr.is_valid_ameba || 0,
    target_version: versionFromFilename(safeName),
    img_len: hdr.img_len || null,
    checksum: hdr.checksum || null,
  });

  console.log(`[OTA] uploaded #${id} ${safeName} (${buf.length}B, kind=${kind}, valid=${!!hdr.is_valid_ameba})`);
  res.json({ ok: true, file: fileToJson(getOtaFile(id)) });
});

// ─── GET /ctrl/ota/files ─────────────────────────────────────────────────────
router.get('/files', (_req, res) => {
  res.json(listOtaFiles().map(fileToJson));
});

// ─── DELETE /ctrl/ota/files/:id ──────────────────────────────────────────────
router.delete('/files/:id', (req, res) => {
  const f = getOtaFile(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(f.stored_path); } catch { /* already gone */ }
  deleteOtaFile(f.id);
  res.json({ ok: true });
});

// ─── POST /ctrl/ota/arm ──────────────────────────────────────────────────────
// { imei: "<IMEI>" | "*", file_id, transport?: 'ameba'|'lte', target_version? }
router.post('/arm', (req, res) => {
  const { imei, file_id } = req.body || {};
  if (!imei || !file_id) return res.status(400).json({ error: 'imei and file_id required' });

  const f = getOtaFile(Number(file_id));
  if (!f) return res.status(404).json({ error: 'file not found' });

  const transport = (req.body.transport || f.kind || 'ameba');
  const targetVersion = (req.body.target_version || f.target_version || '').toString();
  if (!targetVersion) {
    return res.status(400).json({ error: 'target_version required (could not parse from filename)' });
  }

  armOta(imei, f.id, transport, targetVersion);
  console.log(`[OTA] armed ${imei} → #${f.id} ${f.filename} (${transport}, target ${targetVersion})`);
  res.json({ ok: true, imei, file_id: f.id, transport, target_version: targetVersion });
});

// ─── POST /ctrl/ota/disarm  { imei } ─────────────────────────────────────────
router.post('/disarm', (req, res) => {
  const { imei } = req.body || {};
  if (!imei) return res.status(400).json({ error: 'imei required' });
  const changes = disarmOta(imei);
  res.json({ ok: true, removed: changes });
});

// ─── POST /ctrl/ota/trigger  { imei } ────────────────────────────────────────
// Push a WebSocket firmware_update so the device queries immediately instead of
// waiting for the next boot / periodic check.
router.post('/trigger', (req, res) => {
  const { imei } = req.body || {};
  if (!imei) return res.status(400).json({ error: 'imei required' });
  const ok = wsHandler.pushToTerminal(imei, 'firmware_update', {});
  console.log(`[OTA] trigger firmware_update → ${imei}  ok=${ok}`);
  res.json({ ok, imei });
});

// ─── GET /ctrl/ota/status ────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  res.json({ files: listOtaFiles().map(fileToJson), targets: listOtaTargets() });
});

module.exports = router;
