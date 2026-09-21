const client = require('../config/square.js');
const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');
const { createPaymentViaRest } = require('../controllers/payment.controller.js');

// Stable per-quote key: Square returns the original payment instead of charging
// again, so a double-click or a repeated call cannot take the money twice.
const balanceIdempotencyKey = (quote) => `bal-${quote._id}`;

const squareError = (err) =>
  err?.response?.data?.errors?.[0]?.detail
  || err?.errors?.[0]?.detail
  || err?.message
  || 'Unknown payment error';

/**
 * Charges one quote's outstanding balance to its saved card.
 * Safe to call repeatedly — the DB guard and the idempotency key both prevent
 * a second charge. Returns { ok, error } rather than throwing.
 */
// an attempt older than this is assumed dead (process crashed mid-charge)
const CLAIM_TTL_MS = 5 * 60 * 1000;

async function chargeBalanceFor(quoteId) {
  const staleBefore = new Date(Date.now() - CLAIM_TTL_MS);

  // Excluding a live claim in the *filter* is what makes this atomic — a second
  // concurrent caller finds the claim already set and matches nothing.
  const quote = await Quote.findOneAndUpdate(
    {
      _id: quoteId,
      status: 'paid',
      paymentOption: 'deposit',
      remainingBalancePaid: { $ne: true },
      remainingBalance: { $gt: 0 },
      squareCardId: { $exists: true, $ne: null },
      $or: [
        { balanceChargeStartedAt: null },
        { balanceChargeStartedAt: { $exists: false } },
        { balanceChargeStartedAt: { $lt: staleBefore } },
      ],
    },
    { $set: { balanceChargeStartedAt: new Date() } },
    { new: true }
  );

  if (!quote) {
    return { ok: false, error: 'No outstanding balance to charge for this booking.', skipped: true };
  }

  const amount = Number(quote.remainingBalance);
  const idempotencyKey = balanceIdempotencyKey(quote);
  let payment = null;
  let sdkErr = null;
  let lastErr = null;

  if (client?.payments?.create) {
    try {
      const response = await client.payments.create({
        sourceId: quote.squareCardId,
        idempotencyKey,
        amountMoney: { amount: BigInt(Math.round(amount * 100)), currency: 'USD' },
        customerId: quote.squareCustomerId,
      });
      payment = response?.result?.payment || response?.payment || response;
    } catch (err) {
      sdkErr = err;
      lastErr = err;
      console.error(`balance SDK charge failed for ${quote._id}:`, squareError(err));
    }
  }

  if (!payment) {
    try {
      const restResp = await createPaymentViaRest({
        amount,
        sourceId: quote.squareCardId,
        idempotencyKey,
        customerId: quote.squareCustomerId,
      });
      payment = restResp.payment || restResp;
    } catch (restErr) {
      lastErr = restErr;
    }
  }

  if (!payment) {
    // the SDK error describes the card; a REST fallback error usually describes transport
    const reason = squareError(sdkErr || lastErr);
    console.error(`balance charge failed for ${quote._id}: ${reason}`);

    // release the claim so a manual retry is possible; the stable idempotency
    // key is what stops that retry from charging twice
    await Quote.updateOne({ _id: quote._id }, { $unset: { balanceChargeStartedAt: '' } });

    // a silently uncollected balance is the worst outcome — always alert
    email.sendBalanceChargeFailed(quote, reason)
      .catch((e) => console.error('failure alert could not be sent:', e.message));
    return { ok: false, error: reason };
  }

  quote.remainingBalancePaid = true;
  quote.remainingBalancePaymentId = payment?.id || null;
  quote.amountPaid = Number((Number(quote.amountPaid) + amount).toFixed(2));
  await quote.save();

  email.sendBalanceCharged(quote)
    .catch((e) => console.error('balance email failed:', e.message));

  console.log(`charged balance for quote ${quote._id}`);
  return { ok: true, amount, paymentId: payment?.id || null };
}

// charges outstanding balances on saved cards for rides picking up today
async function chargeDueBalances() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const due = await Quote.find({
    pickupDateTime: { $gte: today, $lt: tomorrow },
    status: 'paid',
    paymentOption: 'deposit',
    remainingBalancePaid: { $ne: true },
    remainingBalance: { $gt: 0 },
    squareCardId: { $exists: true, $ne: null },
  }).select('_id');

  let charged = 0;
  for (const { _id } of due) {
    const result = await chargeBalanceFor(_id);
    if (result.ok) charged += 1;
  }
  return { due: due.length, charged };
}

module.exports = { chargeDueBalances, chargeBalanceFor, balanceIdempotencyKey };
