const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 7,
  message: { error: 'Too many login attempts from this IP, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// public form submission — keeps the quote inbox from being flooded
const quoteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many quote requests from this IP, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, quoteLimiter };
