// What a payment link actually owes, and what to write once it is settled.
// Every payment method goes through here so none of them can disagree about
// the amount — which is always derived from the stored quote, never the request.

const Quote = require('../models/quote.model.js');
const email = require('./emailService.js');
const { round2 } = require('../helpers/pricing.js');
const { hashToken, quoteDepositRate } = require('../helpers/tokens.js');
const { methodLabel, processingFeeRate, isOffline } = require('../helpers/paymentMethods.js');
const { GRATUITY_PERCENTS, gratuityAmount } = require('../helpers/gratuity.js');
const { tripMinutes } = require('../helpers/datetime.js');

// a saved card stays on file this long after the scheduled drop-off, for damage or cleaning charges
const CARD_HOLD_HOURS = 48;

function cardReleaseAt(quote) {
  const minutes = tripMinutes(quote.date, quote.pickupTime, quote.finalDropoffTime) || 0;
  const dropoff = new Date(quote.pickupDateTime).getTime() + minutes * 60 * 1000;
  return new Date(dropoff + CARD_HOLD_HOURS * 60 * 60 * 1000);
}

// a link mailed for an extra charge (damage, cleaning…) settles that charge and nothing else
async function resolveChargePayable(hash, method) {
  const quote = await Quote.findOne({ 'extraCharges.tokenHash': hash });
  const charge = quote?.extraCharges?.find((c) => c.tokenHash === hash);
  if (!charge) return { error: { status: 404, message: 'This link is not valid' } };
  if (charge.tokenExpires && charge.tokenExpires < new Date()) {
    return { error: { status: 410, message: 'This link has expired. Contact us and we will send a new one.' } };
  }
  if (charge.status !== 'awaiting_payment') {
    return { error: { status: 409, message: 'This charge has already been paid' } };
  }
  return {
    quote, mode: 'charge', chargeId: charge._id, ...priced(round2(charge.amount), method), remaining: 0, isDeposit: false,
  };
}

/**
 * The customer's gratuity pick, honoured only when the admin left it to them.
 * Returns { gratuity } (null when there is no choice to make) or { error }.
 */
function readGratuity(quote, input = {}) {
  if (!quote.gratuity?.customerChooses) return { gratuity: null };
  const percent = Number(input.gratuityPercent);
  if (!GRATUITY_PERCENTS.includes(percent)) {
    return { error: { status: 400, message: 'Choose a gratuity of 10%, 15% or 20%.' } };
  }
  if (!['online', 'cash'].includes(input.gratuityMethod)) {
    return { error: { status: 400, message: 'Choose whether to add the gratuity online or pay it in cash.' } };
  }
  return { gratuity: { percent, amount: gratuityAmount(quote, percent), method: input.gratuityMethod } };
}

/**
 * Resolves a raw payment token to the quote and the exact sum due.
 *
 * `subtotal` is what the booking is worth; `fee` is the surcharge for the chosen
 * method, and `amount` is what actually gets charged. The processor takes its cut
 * of everything that moves, so the fee is on the whole sum being settled.
 *
 * Returns { error } instead of throwing so callers can map it to a status code.
 */
async function resolvePayable(rawToken, paymentOption, method = 'card', gratuityInput = {}) {
  const quote = await Quote.findOne({ paymentTokenHash: hashToken(rawToken) });
  if (!quote) return resolveChargePayable(hashToken(rawToken), method);

  if (quote.paymentTokenExpires && quote.paymentTokenExpires < new Date()) {
    return { error: { status: 410, message: 'This link has expired. Contact us and we will send a new one.' } };
  }

  // a link minted for an unpaid balance settles that balance, not the whole quote
  const owesBalance = Number(quote.remainingBalance) > 0 && !quote.remainingBalancePaid;
  if (quote.status === 'paid') {
    if (!owesBalance) {
      return { error: { status: 409, message: 'This booking has already been paid' } };
    }
    return {
      quote,
      mode: 'balance',
      ...priced(round2(quote.remainingBalance), method),
      remaining: 0,
      isDeposit: false,
    };
  }

  if (quote.status !== 'accepted' && quote.status !== 'awaiting_payment') {
    return { error: { status: 409, message: 'This request is not open for payment' } };
  }
  if (!Number(quote.quotedAmount)) {
    return { error: { status: 409, message: 'This quote has no price set' } };
  }

  const total = round2(quote.quotedAmount);
  const rate = quoteDepositRate(quote);
  // a booking the admin set to 100% has no deposit to take
  if (paymentOption === 'deposit' && rate >= 1) {
    return { error: { status: 400, message: 'This booking is paid in full. Please choose "Pay in full".' } };
  }
  const picked = readGratuity(quote, gratuityInput);
  if (picked.error) return { error: picked.error };
  const tip = picked.gratuity?.method === 'online' ? picked.gratuity.amount : 0;

  const isDeposit = paymentOption === 'deposit';
  // the deposit never carries gratuity; added online, the whole of it goes with the balance
  const subtotal = isDeposit ? round2(total * rate) : round2(total + tip);
  return {
    quote,
    mode: 'initial',
    ...priced(subtotal, method),
    remaining: isDeposit ? round2(total - subtotal + tip) : 0,
    isDeposit,
    gratuity: picked.gratuity,
  };
}

// the surcharge for one method on one sum
function priced(subtotal, method) {
  const feeRate = processingFeeRate(method);
  const fee = round2(subtotal * feeRate);
  return { subtotal, feeRate, fee, amount: round2(subtotal + fee) };
}

/**
 * Records a settled payment and sends the customer's receipt.
 * The payment link is burned here, so it cannot be replayed.
 */
async function applyPayment(quote, ctx) {
  const {
    mode, method, amount, subtotal, fee, feeRate, remaining, isDeposit,
    paymentId, customerId = null, cardId = null, paypal = null, gratuity = null,
  } = ctx;

  if (mode === 'charge') return applyChargePayment(quote, ctx);

  if (mode === 'balance') {
    quote.remainingBalancePaid = true;
    quote.remainingBalancePaymentId = paymentId || null;
    quote.balanceMethod = method;
    quote.balanceFeeRate = feeRate;
    quote.balanceProcessingFee = fee;
    // amountPaid tracks money actually taken, surcharge included
    quote.amountPaid = round2(Number(quote.amountPaid || 0) + amount);
  } else {
    quote.status = 'paid';
    quote.paymentOption = isDeposit ? 'deposit' : 'full';
    quote.paymentMethod = method;
    quote.termsAcceptedAt = new Date();
    quote.amountPaid = amount;
    quote.processingFeeRate = feeRate;
    quote.processingFee = fee;
    quote.paymentId = paymentId || null;
    // what is still owed on the booking itself; its own surcharge is added when it is settled
    quote.remainingBalance = remaining;
    quote.remainingBalancePaid = !isDeposit;
    quote.squareCustomerId = customerId;
    quote.squareCardId = cardId;
    if (cardId) quote.cardReleaseAt = cardReleaseAt(quote);
    if (gratuity) Object.assign(quote.gratuity, gratuity);
  }

  if (paypal) {
    quote.paypalOrderId = paypal.orderId || quote.paypalOrderId;
    quote.paypalCaptureId = paypal.captureId || quote.paypalCaptureId;
  }

  // single use, whichever method settled it
  quote.paymentTokenHash = undefined;
  quote.paymentTokenExpires = undefined;
  quote.balanceChargeStartedAt = undefined;
  await quote.save();

  const receipt = mode === 'balance'
    ? email.sendBalanceCharged(quote)
    : email.sendPaymentReceipt(quote, amount, isDeposit);
  receipt.catch((e) => console.error('receipt email failed:', e.message));

  return {
    success: true,
    amountPaid: amount,
    subtotal,
    processingFee: fee,
    processingFeeRate: feeRate,
    remainingBalance: mode === 'balance' ? 0 : remaining,
    method: methodLabel(method),
    // a wallet or PayPal deposit cannot be auto-charged later, so say so plainly
    balanceByLink: mode === 'initial' && isDeposit && !cardId,
  };
}

/** Marks an extra charge paid through its link and sends the paid invoice. */
async function applyChargePayment(quote, ctx) {
  const {
    chargeId, method, amount, subtotal, fee, feeRate, paymentId, paypal = null,
  } = ctx;
  const charge = quote.extraCharges.id(chargeId);
  Object.assign(charge, {
    status: 'paid',
    method,
    feeRate,
    fee,
    total: amount,
    paymentId: paymentId || paypal?.captureId || null,
    paidAt: new Date(),
    tokenHash: undefined,
    tokenExpires: undefined,
  });
  await quote.save();

  email.sendExtraCharge(quote, charge).catch((e) => console.error('extra charge receipt failed:', e.message));
  return {
    success: true,
    amountPaid: amount,
    subtotal,
    processingFee: fee,
    processingFeeRate: feeRate,
    remainingBalance: 0,
    method: methodLabel(method),
    extraCharge: true,
  };
}

module.exports = {
  resolvePayable, applyPayment, readGratuity, cardReleaseAt, CARD_HOLD_HOURS,
};
