const express = require('express');
const router = express.Router();
const {
  createQuote, listQuotes, getQuote, acceptQuote, declineQuote, getQuoteByToken,
} = require('../../controllers/quotes.controller.js');
const { quoteLimiter } = require('../../middleware/rate.limiter.js');
const { verifyJWT, checkRole } = require('../../middleware/auth.middleware.js');

const adminOnly = [verifyJWT, checkRole('admin')];

// public
router.post('/', quoteLimiter, createQuote);
router.get('/by-token', getQuoteByToken);

// admin
router.get('/', ...adminOnly, listQuotes);
router.get('/:id', ...adminOnly, getQuote);
router.patch('/:id/accept', ...adminOnly, acceptQuote);
router.patch('/:id/decline', ...adminOnly, declineQuote);

module.exports = router;
