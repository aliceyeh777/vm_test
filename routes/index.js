const { Router } = require('express');

const router = Router();

router.use('/token',                  require('./token'));
router.use('/status',                 require('./status'));
router.use('/payment/product',        require('./product'));
router.use('/payment/confirm',        require('./confirm'));
router.use('/payment/cancel',         require('./cancel'));
router.use('/close',                  require('./close'));
router.use('/collation/notify',       require('./notify'));
router.use('/collation/batch',        require('./batch'));
router.use('/firmware_update',        require('./ota'));

module.exports = router;
