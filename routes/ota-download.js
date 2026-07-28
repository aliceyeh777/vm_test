const { Router } = require('express');
const fs = require('fs');

const {
  getOtaFile, bumpOtaDownload, setOtaTargetStateByFile,
} = require('../db');

const router = Router();

// ─── GET /ota/download/:id ───────────────────────────────────────────────────
// Public, unauthenticated — the firmware fetches this with a plain HTTP GET
// (no Range, no Authorization) over AT+CHTTPS (host:443 SSL). The response must
// be Content-Type: application/octet-stream with a correct Content-Length; the
// device streams it into flash and verifies the OTA1 checksum itself.
router.get('/download/:id', (req, res) => {
  const f = getOtaFile(Number(req.params.id));
  if (!f) return res.status(404).send('not found');
  if (!fs.existsSync(f.stored_path)) return res.status(410).send('file gone');

  const size = fs.statSync(f.stored_path).size;
  const sseEmit = req.app.locals.sseEmit || (() => {});

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.setHeader('Connection', 'keep-alive');

  console.log(`[OTA] download start #${f.id} ${f.filename} (${size}B) ← ${req.ip}`);
  setOtaTargetStateByFile(f.id, ['armed', 'offered'], 'downloading');
  sseEmit('ota', { imei: '', phase: 'downloading', file_id: f.id, filename: f.filename, size });

  const stream = fs.createReadStream(f.stored_path);
  stream.on('error', (err) => {
    console.error(`[OTA] download error #${f.id}: ${err.message}`);
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });

  // res 'finish' = all bytes flushed to the socket; 'close' before finish = aborted.
  let finished = false;
  res.on('finish', () => {
    finished = true;
    bumpOtaDownload(f.id, size);
    setOtaTargetStateByFile(f.id, ['downloading', 'offered'], 'downloaded');
    console.log(`[OTA] download complete #${f.id} ${f.filename} (${size}B)`);
    sseEmit('ota', { imei: '', phase: 'downloaded', file_id: f.id, filename: f.filename, size });
  });
  res.on('close', () => {
    if (!finished) {
      console.warn(`[OTA] download aborted #${f.id} ${f.filename}`);
      sseEmit('ota', { imei: '', phase: 'download_aborted', file_id: f.id, filename: f.filename });
    }
  });

  stream.pipe(res);
});

module.exports = router;
