const express = require('express');
const router = express.Router();
const { getSquareConfig, payQuote } = require('../../controllers/payment.controller.js');

router.get('/config', getSquareConfig);
router.post('/pay', payQuote);

module.exports = router;
