const client = require('../config/square.js');
const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');
const { createPaymentViaRest, newIdempotencyKey } = require('../controllers/payment.controller.js');

// charges the outstanding balance on saved cards for rides picking up today
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
  });

  for (const quote of due) {
    const idempotencyKey = newIdempotencyKey();
    const amount = Number(quote.remainingBalance);
    try {
      let payment = null;
      if (client?.payments?.create) {
        try {
          const response = await client.payments.create({
            sourceId: quote.squareCardId,
            idempotencyKey,
            amountMoney: { amount: BigInt(Math.round(amount * 100)), currency: 'USD' },
            customerId: quote.squareCustomerId,
          });
          payment = response?.result?.payment || response?.payment || response;
        } catch (sdkErr) {
          console.error(`balance SDK charge failed for ${quote._id}:`, sdkErr?.message || sdkErr);
        }
      }
      if (!payment) {
        const restResp = await createPaymentViaRest({
          amount,
          sourceId: quote.squareCardId,
          idempotencyKey,
          customerId: quote.squareCustomerId,
        });
        payment = restResp.payment || restResp;
      }

      quote.remainingBalancePaid = true;
      quote.remainingBalancePaymentId = payment?.id || null;
      quote.amountPaid = Number((Number(quote.amountPaid) + amount).toFixed(2));
      await quote.save();

      await email.sendBalanceCharged(quote);
      console.log(`charged balance for quote ${quote._id}`);
    } catch (err) {
      // leave it unpaid so the next run retries; admin is alerted by the log
      console.error(`balance charge failed for ${quote._id}:`, err?.response?.data || err?.message || err);
    }
  }
  return due.length;
}

module.exports = { chargeDueBalances };
