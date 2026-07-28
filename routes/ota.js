const { Router } = require('express');
const {
  upsertTerminal, logApi, getArmedTarget, getOtaFile, setOtaTargetState,
} = require('../db');

const router = Router();

// Public base URL the device uses to download the image. Must be reachable by
// the device over HTTPS:443 (the firmware always opens AT+CHTTPSOPSE host,443,2).
function baseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

// States that mean "we already handed this OTA to the device", so a matching
// version report now proves the OTA actually applied (vs. device was already
// on the target version before we armed anything).
const IN_PROGRESS = new Set(['offered', 'downloading', 'downloaded']);

// POST /api/v1/terminal/firmware_update
// Device queries whether new firmware (Ameba main or SIM7500 LTE) is available.
router.post('/', (req, res) => {
  const body = req.body || {};
  const imei = body.terminal_id || 'unknown';

  upsertTerminal(imei);

  // Default: nothing to update. Never emit null (device Hard-Faults on null).
  const response = {
    version: body.version || '0.000',
    url: '',
    lte_version: '',
    lte_needs_update: false,
    lte_url: '',
    needs_update: false,
  };

  const sseEmit = req.app.locals.sseEmit || (() => {});
  const target = getArmedTarget(imei);

  if (target && target.state !== 'verified') {
    const file = getOtaFile(target.file_id);
    if (!file) {
      // File was deleted out from under an armed target — treat as no-op.
      console.warn(`[OTA] armed target for ${imei} points at missing file #${target.file_id}`);
    } else {
      // Which version field does the device report for this transport?
      const reported = target.transport === 'lte' ? (body.lte_version || '') : (body.version || '');
      const matched = target.target_version && reported === target.target_version;

      if (matched) {
        // Device now reports the target version.
        // Update the actual armed row (target.imei may be the '*' broadcast row,
        // not this device's imei).
        const verified = IN_PROGRESS.has(target.state);
        setOtaTargetState(target.imei, verified ? 'verified' : 'already_current');
        console.log(`[OTA] ${imei} reports ${reported} == target → ${verified ? 'VERIFIED ✅' : 'already current'}`);
        sseEmit('ota', {
          imei, phase: verified ? 'verified' : 'already_current',
          file_id: file.id, filename: file.filename, version: reported,
        });
      } else {
        // Offer the update for this transport.
        const url = `${baseUrl(req)}/ota/download/${file.id}`;
        if (target.transport === 'lte') {
          response.lte_needs_update = true;
          response.lte_url = url;
          response.lte_version = target.target_version;
        } else {
          response.needs_update = true;
          response.url = url;
          response.version = target.target_version;
        }
        setOtaTargetState(target.imei, 'offered', { offered_count_inc: true });
        console.log(`[OTA] offer ${target.transport} #${file.id} → ${imei}  (${reported} → ${target.target_version})  ${url}`);
        sseEmit('ota', {
          imei, phase: 'offered', transport: target.transport,
          file_id: file.id, filename: file.filename,
          from_version: reported, to_version: target.target_version, url,
        });
      }
    }
  }

  logApi(imei, 'ota', req.path, body, response, 200);
  console.log(`[HTTPS] ota  ${imei}  needs_update=${response.needs_update}  lte_needs_update=${response.lte_needs_update}`);
  res.json(response);
});

module.exports = router;
