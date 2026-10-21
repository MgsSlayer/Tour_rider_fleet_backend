const crypto = require('crypto');

// raw tokens are mailed to the customer and never stored; only this hash is
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

const newToken = () => crypto.randomBytes(32).toString('hex');

const newIdempotencyKey = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const depositRate = () => {
  const r = Number(process.env.DEPOSIT_RATE);
  return Number.isFinite(r) && r > 0 && r < 1 ? r : 0.5;
};

// the rate the admin set on this booking; bookings sent before that fall back to the default
const quoteDepositRate = (quote) => {
  const r = Number(quote?.depositRate);
  return Number.isFinite(r) && r > 0 && r <= 1 ? r : depositRate();
};

const tokenTtlDays = () => {
  const d = Number(process.env.PAYMENT_LINK_TTL_DAYS);
  return Number.isFinite(d) && d > 0 ? d : 14;
};

module.exports = {
  hashToken, newToken, newIdempotencyKey, depositRate, quoteDepositRate, tokenTtlDays,
};
