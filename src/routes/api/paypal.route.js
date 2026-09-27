const express = require('express');
const router = express.Router();
const { getPaypalConfig, createOrder, captureOrder } = require('../../controllers/paypal.controller.js');

router.get('/config', getPaypalConfig);
router.post('/order', createOrder);
router.post('/capture', captureOrder);

module.exports = router;
