const crypto = require('crypto');
const axios = require('axios');
const client = require('../config/square.js');
const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');
const { depositRate, hashToken } = require('./quotes.controller.js');

const newIdempotencyKey = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function getOrCreateSquareCustomer({ name, email: mail, phone }) {
  const searchRes = await client.customers.search({
    query: { filter: { emailAddress: { exact: mail } } },
  });
  const found = searchRes?.result?.customers || searchRes?.customers;
  if (found && found.length) return found[0].id;

  const createRes = await client.customers.create({
    givenName: name,
    emailAddress: mail,
    phoneNumber: phone || undefined,
  });
  return (createRes.result?.customer || createRes.customer).id;
}

// used when the SDK call fails; same request against the Connect REST API
async function createPaymentViaRest({ amount, sourceId, idempotencyKey, customerId }) {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!accessToken) throw new Error('SQUARE_ACCESS_TOKEN not configured');

  const baseUrl = process.env.SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  const resp = await axios.post(`${baseUrl}/v2/payments`, {
    source_id: sourceId,
    idempotency_key: idempotencyKey,
    amount_money: { amount: Math.round(Number(amount) * 100), currency: 'USD' },
    ...(customerId ? { customer_id: customerId } : {}),
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': process.env.SQUARE_API_VERSION || '2023-08-16',
    },
  });
  return resp.data;
}

const getSquareConfig = (req, res) => {
  const applicationId = process.env.SQUARE_APPLICATION_ID || null;
  const locationId = process.env.SQUARE_LOCATION_ID || null;
  if (!applicationId || !locationId) {
    return res.status(500).json({ error: 'Square is not configured.' });
  }
  return res.json({ applicationId, locationId, environment: process.env.SQUARE_ENV || 'sandbox' });
};

const payQuote = async (req, res) => {
  try {
    const { token, sourceId, paymentOption } = req.body || {};
    if (!token) return res.status(400).json({ success: false, error: 'Missing token' });
    if (!sourceId) return res.status(400).json({ success: false, error: 'Missing card details' });
    if (!['deposit', 'full'].includes(paymentOption)) {
      return res.status(400).json({ success: false, error: 'Choose deposit or full payment' });
    }

    const quote = await Quote.findOne({ paymentTokenHash: hashToken(String(token)) });
    if (!quote) return res.status(404).json({ success: false, error: 'This link is not valid' });
    if (quote.paymentTokenExpires && quote.paymentTokenExpires < new Date()) {
      return res.status(410).json({ success: false, error: 'This link has expired' });
    }
    if (quote.status === 'paid') {
      return res.status(409).json({ success: false, error: 'This booking has already been paid' });
    }
    if (quote.status !== 'accepted') {
      return res.status(409).json({ success: false, error: 'This request is not open for payment' });
    }

    // the charge is always derived from the stored quote, never from the client
    const total = Number(quote.quotedAmount);
    const isDeposit = paymentOption === 'deposit';
    const amount = isDeposit ? Number((total * depositRate()).toFixed(2)) : total;
    const remaining = isDeposit ? Number((total - amount).toFixed(2)) : 0;

    const idempotencyKey = newIdempotencyKey();
    let customerId = null;
    let cardId = null;

    // a deposit needs the card kept on file so the balance can be taken on pickup day
    if (isDeposit) {
      try {
        customerId = await getOrCreateSquareCustomer(quote.customer);
        const cardRes = await client.cards.create({
          idempotencyKey,
          sourceId,
          card: { customerId, cardholderName: quote.customer.name, referenceId: String(quote._id) },
        });
        cardId = (cardRes.result?.card || cardRes.card).id;
      } catch (err) {
        console.error('Square save card error:', err);
        return res.status(500).json({ success: false, error: 'Could not save your card for the balance payment.' });
      }
    }

    const chargeSource = cardId || sourceId;
    let payment = null;

    if (client?.payments?.create) {
      try {
        const response = await client.payments.create({
          sourceId: chargeSource,
          idempotencyKey,
          amountMoney: { amount: BigInt(Math.round(amount * 100)), currency: 'USD' },
          ...(customerId ? { customerId } : {}),
        });
        payment = response?.result?.payment || response?.payment || response;
      } catch (sdkErr) {
        console.error('Square SDK payment failed, trying REST:', sdkErr?.message || sdkErr);
      }
    }

    if (!payment) {
      try {
        const restResp = await createPaymentViaRest({
          amount, sourceId: chargeSource, idempotencyKey, customerId,
        });
        payment = restResp.payment || restResp;
      } catch (restErr) {
        const msg = restErr?.response?.data?.errors?.[0]?.detail || restErr?.message || 'Payment failed';
        console.error('Square REST payment error:', msg);
        return res.status(500).json({ success: false, error: msg });
      }
    }

    quote.status = 'paid';
    quote.paymentOption = paymentOption;
    quote.amountPaid = amount;
    quote.paymentId = payment?.id || null;
    quote.remainingBalance = remaining;
    quote.remainingBalancePaid = !isDeposit;
    quote.squareCustomerId = customerId;
    quote.squareCardId = cardId;
    // the link is single-use
    quote.paymentTokenHash = undefined;
    quote.paymentTokenExpires = undefined;
    await quote.save();

    email.sendPaymentReceipt(quote, amount, isDeposit)
      .catch((e) => console.error('receipt email failed:', e.message));

    return res.json({ success: true, amountPaid: amount, remainingBalance: remaining });
  } catch (err) {
    console.error('payQuote error:', err);
    return res.status(500).json({ success: false, error: 'Payment failed' });
  }
};

module.exports = { getSquareConfig, payQuote, createPaymentViaRest, newIdempotencyKey };
