const { Router } = require('express');
const fs = require('fs');

const {
  getOtaFile, bumpOtaDownload, setOtaTargetStateByFile,
} = require('../db');

const router = Router();

// ─── Download throttle (test aid) ────────────────────────────────────────────
// 0 = off (nginx buffers the whole file and pushes it as fast as the link allows).
// > 0 = pace the body at ~N bytes/sec and tell nginx not to buffer it, so the
// LTE module receives a steady stream instead of a burst. Set via
// POST /ctrl/ota/throttle { bytes_per_sec }. In-memory only; resets on restart.
let throttleBps = 0;
function setThrottle(bps) { throttleBps = Math.max(0, Number(bps) || 0); }
function getThrottle() { return throttleBps; }

const THROTTLE_TICK_MS = 100;

function pipeThrottled(stream, res, bps) {
  const perTick = Math.max(1, Math.round(bps * THROTTLE_TICK_MS / 1000));
  let pending = Buffer.alloc(0);
  let ended = false;
  let timer = null;

  const tick = () => {
    if (res.destroyed) { clearInterval(timer); stream.destroy(); return; }
    if (pending.length > 0) {
      const n = Math.min(perTick, pending.length);
      res.write(pending.subarray(0, n));
      pending = pending.subarray(n);
    }
    if (pending.length < perTick * 4 && stream.isPaused() && !ended) stream.resume();
    if (ended && pending.length === 0) { clearInterval(timer); res.end(); }
  };

  stream.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length >= perTick * 8) stream.pause();
  });
  stream.on('end', () => { ended = true; });
  timer = setInterval(tick, THROTTLE_TICK_MS);
  res.on('close', () => clearInterval(timer));
}

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
  const bps = throttleBps;
  if (bps > 0) res.setHeader('X-Accel-Buffering', 'no');	// nginx: pass through unbuffered

  console.log(`[OTA] download start #${f.id} ${f.filename} (${size}B) ← ${req.ip}${bps > 0 ? `  throttle=${bps}B/s` : ''}`);
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

  if (bps > 0) pipeThrottled(stream, res, bps);
  else stream.pipe(res);
});

module.exports = router;
module.exports.setThrottle = setThrottle;
module.exports.getThrottle = getThrottle;
