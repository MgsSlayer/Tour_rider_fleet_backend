const axios = require('axios');
const client = require('../config/square.js');
const v = require('../helpers/validate.js');
const { newIdempotencyKey } = require('../helpers/tokens.js');
const { SQUARE_METHODS, canStoreCard } = require('../helpers/paymentMethods.js');
const { resolvePayable, applyPayment } = require('../services/payments.js');

// Square only accepts E.164, and the quote form takes whatever the customer types
function squarePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}`
    : (digits.length === 11 && digits.startsWith('1') ? `+${digits}` : null);
  return e164 || undefined;
}

async function getOrCreateSquareCustomer({ name, email: mail, phone }) {
  const searchRes = await client.customers.search({
    query: { filter: { emailAddress: { exact: mail } } },
  });
  const found = searchRes?.result?.customers || searchRes?.customers;
  if (found && found.length) return found[0].id;

  const create = (phoneNumber) => client.customers.create({
    givenName: name,
    emailAddress: mail,
    phoneNumber,
  });

  try {
    const createRes = await create(squarePhone(phone));
    return (createRes.result?.customer || createRes.customer).id;
  } catch (err) {
    // a phone number Square dislikes is not worth losing the payment over
    const text = JSON.stringify(err?.body || err?.errors || err?.message || '');
    if (!/phone/i.test(text)) throw err;
    const retry = await create(undefined);
    return (retry.result?.customer || retry.customer).id;
  }
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
    let token; let sourceId; let paymentOption; let method;
    try {
      token = v.text(req.body?.token, 'Payment link', { max: 128 });
      sourceId = v.text(req.body?.sourceId, 'Payment details', { max: 1024 });
      paymentOption = v.oneOf(req.body?.paymentOption, 'Payment option', ['deposit', 'full']);
      method = v.oneOf(req.body?.method ?? 'card', 'Payment method', SQUARE_METHODS);
      // enforced here too: the checkbox alone can be bypassed by calling the API
      if (req.body?.acceptedTerms !== true) {
        return res.status(400).json({
          success: false,
          error: 'Please accept the terms and conditions before paying.',
        });
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    const payable = await resolvePayable(token, paymentOption, method);
    if (payable.error) {
      return res.status(payable.error.status).json({ success: false, error: payable.error.message });
    }
    const { quote, mode, amount, subtotal, fee, feeRate, remaining, isDeposit } = payable;

    const idempotencyKey = newIdempotencyKey();
    let customerId = null;
    let cardId = null;

    // keeping the card is the customer's choice, and only a real card can be kept;
    // without one the balance is asked for by link instead of charged
    const wantsCardStored = req.body?.saveCard === true;
    if (mode === 'initial' && isDeposit && canStoreCard(method) && wantsCardStored) {
      try {
        customerId = await getOrCreateSquareCustomer(quote.customer);
        const cardRes = await client.cards.create({
          idempotencyKey,
          sourceId,
          card: { customerId, cardholderName: quote.customer.name, referenceId: String(quote._id) },
        });
        cardId = (cardRes.result?.card || cardRes.card).id;
      } catch (err) {
        // the payment matters more than the convenience; fall back to a link
        console.error('Square save card error, continuing without it:', err?.message || err);
        customerId = null;
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

    const result = await applyPayment(quote, {
      mode, method, amount, subtotal, fee, feeRate, remaining, isDeposit,
      paymentId: payment?.id || null, customerId, cardId,
    });
    return res.json(result);
  } catch (err) {
    console.error('payQuote error:', err);
    return res.status(500).json({ success: false, error: 'Payment failed' });
  }
};

module.exports = { getSquareConfig, payQuote, createPaymentViaRest, newIdempotencyKey };
