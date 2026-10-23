const express = require('express');
const router = express.Router();
const {
  createQuote, createOpenQuote, matchQuote, listQuotes, getQuote, acceptQuote, declineQuote, getQuoteByToken,
  chargeBalance, suggestQuote, suggestBaseFor, addCharge,
} = require('../../controllers/quotes.controller.js');
const { confirmOffline, confirmChargeOffline } = require('../../controllers/offline.controller.js');
const { quoteLimiter } = require('../../middleware/rate.limiter.js');
const { verifyJWT, checkRole } = require('../../middleware/auth.middleware.js');

const adminOnly = [verifyJWT, checkRole('admin')];

// public
router.post('/', quoteLimiter, createQuote);
router.post('/open', quoteLimiter, createOpenQuote);
router.get('/by-token', getQuoteByToken);

// admin
router.get('/', ...adminOnly, listQuotes);
router.get('/:id', ...adminOnly, getQuote);
router.patch('/:id/accept', ...adminOnly, acceptQuote);
router.patch('/:id/decline', ...adminOnly, declineQuote);
router.patch('/:id/charge-balance', ...adminOnly, chargeBalance);
router.patch('/:id/confirm-offline', ...adminOnly, confirmOffline);
router.get('/:id/bases-for', ...adminOnly, suggestBaseFor);
router.post('/:id/suggest', ...adminOnly, suggestQuote);
router.post('/:id/match', ...adminOnly, matchQuote);
router.post('/:id/charges', ...adminOnly, addCharge);
router.patch('/:id/charges/:chargeId/confirm-offline', ...adminOnly, confirmChargeOffline);

module.exports = router;
