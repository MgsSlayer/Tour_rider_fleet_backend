const client = require('../config/square.js');
const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');
const { createPaymentViaRest } = require('../controllers/payment.controller.js');
const { zonedDayRange } = require('../helpers/datetime.js');
const { newToken, hashToken, tokenTtlDays } = require('../helpers/tokens.js');
const { balancePlan } = require('../helpers/paymentMethods.js');

// the card on file is charged this long after the booked pickup time
const ARRIVAL_GRACE_MINUTES = 15;
// pickups further back than this are never charged automatically, so old unpaid
// balances are left to the admin rather than swept up without warning
const ARRIVAL_LOOKBACK_HOURS = 24;

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
    // a wallet or PayPal deposit leaves a real balance with no card behind it
    const owed = await Quote.findOne({
      _id: quoteId,
      remainingBalancePaid: { $ne: true },
      remainingBalance: { $gt: 0 },
      $or: [{ squareCardId: { $exists: false } }, { squareCardId: null }],
    }).select('paymentMethod');

    if (owed) {
      return {
        ok: false,
        skipped: true,
        error: 'This deposit was paid by a method that cannot be charged again. Send the customer a balance link instead.',
      };
    }
    return { ok: false, error: 'No outstanding balance to charge for this booking.', skipped: true };
  }

  // the balance carries the same card surcharge the deposit did
  const { amount, fee, rate } = balancePlan(quote);
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
    // key is what stops that retry from charging twice. The failure mark keeps
    // the arrival job from retrying, and re-alerting, every few minutes.
    await Quote.updateOne(
      { _id: quote._id },
      { $unset: { balanceChargeStartedAt: '' }, $set: { balanceChargeFailedAt: new Date() } }
    );

    // a silently uncollected balance is the worst outcome — always alert
    email.sendBalanceChargeFailed(quote, reason)
      .catch((e) => console.error('failure alert could not be sent:', e.message));
    return { ok: false, error: reason };
  }

  quote.remainingBalancePaid = true;
  quote.remainingBalancePaymentId = payment?.id || null;
  quote.balanceMethod = 'card';
  quote.balanceFeeRate = rate;
  quote.balanceProcessingFee = fee;
  quote.balanceChargeFailedAt = undefined;
  quote.amountPaid = Number((Number(quote.amountPaid) + amount).toFixed(2));
  await quote.save();

  email.sendBalanceCharged(quote)
    .catch((e) => console.error('balance email failed:', e.message));

  console.log(`charged balance for quote ${quote._id}`);
  return { ok: true, amount, paymentId: payment?.id || null };
}

/**
 * Mails a fresh payment link for one balance that has no card behind it.
 * The link is minted here because the original was burned by the deposit.
 */
async function sendBalanceLinkFor(quoteId) {
  const rawToken = newToken();

  // claiming via the filter keeps a re-run from mailing the customer twice
  const quote = await Quote.findOneAndUpdate(
    {
      _id: quoteId,
      status: 'paid',
      paymentOption: 'deposit',
      remainingBalancePaid: { $ne: true },
      remainingBalance: { $gt: 0 },
      $or: [{ balanceLinkSentAt: null }, { balanceLinkSentAt: { $exists: false } }],
    },
    {
      $set: {
        balanceLinkSentAt: new Date(),
        paymentTokenHash: hashToken(rawToken),
        paymentTokenExpires: new Date(Date.now() + tokenTtlDays() * 24 * 60 * 60 * 1000),
      },
    },
    { new: true }
  );

  if (!quote) return { ok: false, skipped: true };

  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) {
    console.error(`PUBLIC_URL not set; cannot mail a balance link for ${quote._id}`);
    return { ok: false, error: 'PUBLIC_URL not set' };
  }
  const paymentUrl = `${base}/payment.html?token=${rawToken}`;

  try {
    await email.sendBalanceLink(quote, paymentUrl);
  } catch (err) {
    // let it be retried tomorrow rather than leaving the balance silently unasked for
    await Quote.updateOne({ _id: quote._id }, { $unset: { balanceLinkSentAt: '' } });
    console.error(`balance link email failed for ${quote._id}:`, err.message);
    return { ok: false, error: err.message };
  }

  email.sendAdminBalanceLinkSent(quote)
    .catch((e) => console.error('admin balance-link notice failed:', e.message));

  console.log(`mailed balance link for quote ${quote._id}`);
  return { ok: true, amount: Number(quote.remainingBalance) };
}

/** Charges saved cards once the vehicle has arrived: 15 minutes after pickup. */
async function chargeArrivedBalances(now = new Date()) {
  const due = await Quote.find({
    pickupDateTime: {
      $lte: new Date(now.getTime() - ARRIVAL_GRACE_MINUTES * 60 * 1000),
      $gte: new Date(now.getTime() - ARRIVAL_LOOKBACK_HOURS * 60 * 60 * 1000),
    },
    status: 'paid',
    paymentOption: 'deposit',
    remainingBalancePaid: { $ne: true },
    remainingBalance: { $gt: 0 },
    squareCardId: { $exists: true, $ne: null },
    $or: [{ balanceChargeFailedAt: null }, { balanceChargeFailedAt: { $exists: false } }],
  }).select('_id');

  let charged = 0;
  for (const { _id } of due) {
    const result = await chargeBalanceFor(_id);
    if (result.ok) charged += 1;
  }
  return { due: due.length, charged };
}

/**
 * Mails a balance link on the morning of pickup for deposits with no card behind
 * them. Zelle deposits are left out: their balance is paid by Zelle on arrival.
 */
async function sendDueBalanceLinks() {
  // "today" means today where the fleet operates, not where the server runs
  const { start, end } = zonedDayRange();

  const byLink = await Quote.find({
    pickupDateTime: { $gte: start, $lt: end },
    status: 'paid',
    paymentOption: 'deposit',
    paymentMethod: { $ne: 'zelle' },
    remainingBalancePaid: { $ne: true },
    remainingBalance: { $gt: 0 },
    $or: [{ squareCardId: { $exists: false } }, { squareCardId: null }],
    $and: [{ $or: [{ balanceLinkSentAt: null }, { balanceLinkSentAt: { $exists: false } }] }],
  }).select('_id');

  let linked = 0;
  for (const { _id } of byLink) {
    const result = await sendBalanceLinkFor(_id);
    if (result.ok) linked += 1;
  }
  return { linkable: byLink.length, linked };
}

module.exports = {
  chargeArrivedBalances, sendDueBalanceLinks, chargeBalanceFor, sendBalanceLinkFor, balanceIdempotencyKey,
};
