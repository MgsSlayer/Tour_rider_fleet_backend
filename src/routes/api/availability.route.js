const express = require('express');
const router = express.Router();
const { getAvailability, respondAvailability } = require('../../controllers/availability.controller.js');
const { availabilityLimiter } = require('../../middleware/rate.limiter.js');

// public: the vehicle owner's link carries the token, there is no login
router.get('/', availabilityLimiter, getAvailability);
router.post('/respond', availabilityLimiter, respondAvailability);

module.exports = router;
