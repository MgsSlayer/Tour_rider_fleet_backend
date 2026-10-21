const { round2 } = require('./pricing.js');

// Square tokenises all of these to the same Payments API source id.
const SQUARE_METHODS = ['card', 'apple_pay', 'google_pay', 'cash_app'];
// PayPal funds these through its Orders API; Venmo is a PayPal funding source.
const PAYPAL_METHODS = ['paypal', 'venmo'];
// Settled away from the app: nothing is charged, the admin confirms the money arrived.
const OFFLINE_METHODS = ['zelle', 'cash'];
const ALL_METHODS = [...SQUARE_METHODS, ...PAYPAL_METHODS, ...OFFLINE_METHODS];

const isOffline = (method) => OFFLINE_METHODS.includes(method);

// Only a directly entered card can be kept on file. Wallet and PayPal tokens are
// single use, so a deposit taken with one leaves the balance to be collected by link.
const STORABLE_METHODS = ['card'];
const canStoreCard = (method) => STORABLE_METHODS.includes(method);

const envRate = (key, fallback) => {
  const r = Number(process.env[key]);
  return Number.isFinite(r) && r >= 0 && r < 1 ? r : fallback;
};

// What the customer is surcharged, set by what the processor costs us.
// Wallets settle as cards at the same rate, so they sit in the standard tier.
const STANDARD_TIER = ['card', 'apple_pay', 'google_pay', 'paypal'];
const REDUCED_TIER = ['venmo', 'cash_app'];

function processingFeeRate(method) {
  if (STANDARD_TIER.includes(method)) return envRate('PROCESSING_FEE_STANDARD', 0.04);
  if (REDUCED_TIER.includes(method)) return envRate('PROCESSING_FEE_REDUCED', 0.02);
  return 0;
}

/**
 * How the balance left after a deposit is collected, and what it will cost.
 * A saved card is charged automatically on arrival with the same surcharge the
 * deposit carried; a Zelle deposit settles its balance by Zelle on arrival;
 * anything else is asked for by link, where the fee depends on the method used.
 */
function balancePlan(quote) {
  const base = round2(Number(quote.remainingBalance) || 0);
  if (quote.squareCardId) {
    const stored = Number(quote.processingFeeRate);
    const rate = quote.paymentMethod === 'card' && Number.isFinite(stored) ? stored : processingFeeRate('card');
    const fee = round2(base * rate);
    return { how: 'card', base, rate, fee, amount: round2(base + fee) };
  }
  return { how: quote.paymentMethod === 'zelle' ? 'zelle' : 'link', base, rate: 0, fee: 0, amount: base };
}

const LABELS = {
  card: 'card',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  cash_app: 'Cash App Pay',
  paypal: 'PayPal',
  venmo: 'Venmo',
  zelle: 'Zelle',
  cash: 'cash',
};
const methodLabel = (method) => LABELS[method] || 'card';

module.exports = {
  SQUARE_METHODS,
  PAYPAL_METHODS,
  OFFLINE_METHODS,
  ALL_METHODS,
  STORABLE_METHODS,
  canStoreCard,
  isOffline,
  processingFeeRate,
  balancePlan,
  methodLabel,
};
