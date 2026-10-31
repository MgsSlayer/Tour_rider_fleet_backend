const { round2 } = require('./pricing.js');
const { onlineGratuity } = require('./gratuity.js');

// Square tokenises all of these to the same Payments API source id.
const SQUARE_METHODS = ['card', 'apple_pay', 'google_pay', 'cash_app'];
// PayPal funds these through its Orders API; Venmo is a PayPal funding source.
const PAYPAL_METHODS = ['paypal', 'venmo'];
// Settled away from the app: nothing is charged, the admin confirms the money arrived.
// Cash was taken here once; bookings that chose it can still be confirmed on the dashboard.
const OFFLINE_METHODS = ['zelle'];
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
 * What the balance left after a deposit costs at one fee rate. At the rate the
 * deposit was paid at, the fee was set once on the whole booking, so the balance
 * is the rest of the grand total. Paid another way, or booked before grand totals
 * were stored, the balance carries that method's fee on its own. Gratuity riding
 * on the balance never carries a fee.
 */
function balanceDue(quote, rate) {
  const base = round2(Number(quote.remainingBalance) || 0);
  const grandTotal = Number(quote.grandTotal);
  if (grandTotal > 0 && rate === Number(quote.processingFeeRate)) {
    const subtotal = round2(Number(quote.quotedAmount) + onlineGratuity(quote));
    const fee = round2(round2(grandTotal - subtotal) - (Number(quote.processingFee) || 0));
    return { base, rate, fee, amount: round2(base + fee) };
  }
  const tip = quote.paymentOption === 'deposit' ? onlineGratuity(quote) : 0;
  const fee = round2(Math.max(0, round2(base - tip)) * rate);
  return { base, rate, fee, amount: round2(base + fee) };
}

/**
 * How the balance left after a deposit is collected, and what it will cost.
 * A saved card is charged automatically on arrival with the same surcharge the
 * deposit carried; a Zelle deposit settles its balance by Zelle on arrival;
 * anything else is asked for by link, quoted at the rate the deposit was paid at.
 */
function balancePlan(quote) {
  // after a deposit, gratuity added online travels with the balance
  const tip = quote.paymentOption === 'deposit' ? onlineGratuity(quote) : 0;
  if (quote.squareCardId) {
    const stored = Number(quote.processingFeeRate);
    const rate = quote.paymentMethod === 'card' && Number.isFinite(stored) ? stored : processingFeeRate('card');
    return { how: 'card', tip, ...balanceDue(quote, rate) };
  }
  const how = quote.paymentMethod === 'zelle' ? 'zelle' : 'link';
  return { how, tip, ...balanceDue(quote, Number(quote.processingFeeRate) || 0) };
}

/**
 * A booking's grand total once the customer has picked how to pay: the fees
 * already taken plus, while a balance is owed, the fee that balance will carry.
 * `rate` is null when the deposit and balance were paid at different rates.
 */
function bookingTotals(quote) {
  const subtotal = round2(Number(quote.quotedAmount) + onlineGratuity(quote));
  const owed = quote.paymentOption === 'deposit' && Number(quote.remainingBalance) > 0 && !quote.remainingBalancePaid;
  const plan = owed ? balancePlan(quote) : null;
  const fee = round2((Number(quote.processingFee) || 0) + (plan ? plan.fee : (Number(quote.balanceProcessingFee) || 0)));
  const first = Number(quote.processingFeeRate) || 0;
  const second = plan ? plan.rate : Number(quote.balanceFeeRate) || 0;
  const split = quote.paymentOption === 'deposit' && (owed || quote.remainingBalancePaid);
  return {
    subtotal, fee, total: round2(subtotal + fee), balanceDue: plan ? plan.amount : 0, rate: !split || first === second ? first : null,
  };
}

const LABELS = {
  card: 'card',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  cash_app: 'Cash App',
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
  balanceDue,
  balancePlan,
  bookingTotals,
  methodLabel,
};
