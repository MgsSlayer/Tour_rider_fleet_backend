// Charges added after a trip: damage, cleaning or anything else the admin sets.
// The card on file is charged straight away; otherwise the customer is invoiced
// with a payment link. Each charge has its own invoice, apart from the booking's.

const email = require('./emailService.js');
const { chargeSavedCard } = require('./balanceCron.js');
const { processingFeeRate } = require('../helpers/paymentMethods.js');
const { round2 } = require('../helpers/pricing.js');
const { newToken, hashToken, tokenTtlDays } = require('../helpers/tokens.js');

// what the dashboard needs to show; the link's hash stays on the server
const summary = (charge) => {
  const { tokenHash, ...rest } = charge.toObject();
  return rest;
};

async function addExtraCharge(quote, { kind, description, amount, createdBy }) {
  if (!quote.extraCharges) quote.extraCharges = [];
  quote.extraCharges.push({ kind, description, amount, status: 'awaiting_payment', createdBy });
  const charge = quote.extraCharges[quote.extraCharges.length - 1];

  if (quote.squareCardId) {
    const feeRate = processingFeeRate('card');
    const fee = round2(amount * feeRate);
    const total = round2(amount + fee);
    // keyed on the charge, so a retried request cannot take the money twice
    const { payment, error } = await chargeSavedCard(quote, total, `xc-${charge._id}`, 'extra charge');
    if (payment) {
      Object.assign(charge, {
        status: 'charged', method: 'card', feeRate, fee, total, paymentId: payment.id || null, paidAt: new Date(),
      });
      await quote.save();
      email.sendExtraCharge(quote, charge).catch((e) => console.error('extra charge invoice failed:', e.message));
      return { charged: true, charge: summary(charge) };
    }
    charge.failureReason = error;
  }

  // no card on file, or it was declined: invoice with a link to pay by any method
  const raw = newToken();
  charge.tokenHash = hashToken(raw);
  charge.tokenExpires = new Date(Date.now() + tokenTtlDays() * 24 * 60 * 60 * 1000);
  await quote.save();

  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  let emailError = null;
  try {
    await email.sendExtraCharge(quote, charge, `${base}/payment.html?token=${raw}`);
  } catch (e) {
    emailError = e.message;
    console.error(`extra charge invoice failed for ${quote._id}:`, e.message);
  }
  return { charged: false, charge: summary(charge), cardError: charge.failureReason || null, emailError };
}

module.exports = { addExtraCharge };
