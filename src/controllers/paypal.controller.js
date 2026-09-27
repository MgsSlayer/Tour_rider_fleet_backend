const v = require('../helpers/validate.js');
const { paypalFetch, isConfigured } = require('../config/paypal.js');
const { PAYPAL_METHODS } = require('../helpers/paymentMethods.js');
const { resolvePayable, applyPayment } = require('../services/payments.js');
const { round2 } = require('../helpers/pricing.js');

const getPaypalConfig = (req, res) => res.json({
  enabled: isConfigured(),
  // public by design; the secret never leaves the server
  clientId: isConfigured() ? process.env.PAYPAL_CLIENT_ID : null,
  environment: process.env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox',
});

const readRequest = (body) => ({
  token: v.text(body?.token, 'Payment link', { max: 128 }),
  paymentOption: v.oneOf(body?.paymentOption, 'Payment option', ['deposit', 'full']),
  method: v.oneOf(body?.method ?? 'paypal', 'Payment method', PAYPAL_METHODS),
});

/**
 * Opens a PayPal order for what the quote actually owes.
 * The browser never supplies the amount — it only approves the order this makes.
 */
const createOrder = async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ success: false, error: 'PayPal is not available right now.' });
  }
  try {
    let fields;
    try {
      fields = readRequest(req.body);
      if (req.body?.acceptedTerms !== true) {
        return res.status(400).json({
          success: false,
          error: 'Please accept the terms and conditions before paying.',
        });
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    const payable = await resolvePayable(fields.token, fields.paymentOption, fields.method);
    if (payable.error) {
      return res.status(payable.error.status).json({ success: false, error: payable.error.message });
    }
    const { quote, amount, mode } = payable;

    const order = await paypalFetch('/v2/checkout/orders', {
      method: 'POST',
      requestId: `ord-${quote._id}-${mode}-${amount.toFixed(2)}`,
      body: {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: String(quote._id),
          description: `Tour Rider booking ${quote.date}`.slice(0, 127),
          custom_id: String(quote._id),
          amount: { currency_code: 'USD', value: amount.toFixed(2) },
        }],
        application_context: {
          brand_name: 'Tour Rider',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
      },
    });

    // remembered so a capture can only ever settle the order this quote opened
    quote.paypalOrderId = order.id;
    await quote.save();

    return res.json({ success: true, id: order.id, amount });
  } catch (err) {
    console.error('paypal createOrder error:', err.message);
    return res.status(502).json({ success: false, error: 'Could not start the PayPal payment.' });
  }
};

/** Captures an approved order, but only after proving it is the right one for the right sum. */
const captureOrder = async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ success: false, error: 'PayPal is not available right now.' });
  }
  try {
    let fields; let orderId;
    try {
      fields = readRequest(req.body);
      orderId = v.text(req.body?.orderId, 'PayPal order', { max: 64 });
      if (req.body?.acceptedTerms !== true) {
        return res.status(400).json({
          success: false,
          error: 'Please accept the terms and conditions before paying.',
        });
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    const payable = await resolvePayable(fields.token, fields.paymentOption, fields.method);
    if (payable.error) {
      return res.status(payable.error.status).json({ success: false, error: payable.error.message });
    }
    const { quote, mode, amount, subtotal, fee, feeRate, remaining, isDeposit } = payable;

    // the order must be the one this link opened, or it is someone else's money
    if (!quote.paypalOrderId || quote.paypalOrderId !== orderId) {
      return res.status(409).json({ success: false, error: 'This payment could not be matched to your booking.' });
    }

    let capture;
    try {
      capture = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        requestId: `cap-${quote._id}-${orderId}`,
        body: {},
      });
    } catch (err) {
      if (err.issue === 'ORDER_ALREADY_CAPTURED') {
        capture = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      } else {
        console.error('paypal capture error:', err.message);
        return res.status(502).json({ success: false, error: err.message || 'PayPal could not complete the payment.' });
      }
    }

    const unit = capture?.purchase_units?.[0];
    const settled = unit?.payments?.captures?.[0];
    if (!settled || settled.status !== 'COMPLETED') {
      console.error(`paypal capture not completed for ${quote._id}:`, settled?.status || capture?.status);
      return res.status(502).json({
        success: false,
        error: 'PayPal did not complete the payment. Nothing has been charged.',
      });
    }

    // never trust the approved order to match what was asked for
    const paid = round2(settled.amount?.value);
    if (settled.amount?.currency_code !== 'USD' || paid !== amount) {
      console.error(`paypal amount mismatch for ${quote._id}: got ${settled.amount?.currency_code} ${paid}, expected USD ${amount}`);
      return res.status(409).json({
        success: false,
        error: 'The amount PayPal approved did not match your booking. Please contact us before trying again.',
      });
    }

    const result = await applyPayment(quote, {
      mode, method: fields.method, amount, subtotal, fee, feeRate, remaining, isDeposit,
      paymentId: settled.id,
      paypal: { orderId, captureId: settled.id },
    });
    return res.json(result);
  } catch (err) {
    console.error('paypal captureOrder error:', err);
    return res.status(500).json({ success: false, error: 'Payment failed' });
  }
};

module.exports = { getPaypalConfig, createOrder, captureOrder };
