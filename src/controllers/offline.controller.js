const v = require('../helpers/validate.js');
const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');
const { OFFLINE_METHODS, methodLabel } = require('../helpers/paymentMethods.js');
const { resolvePayable } = require('../services/payments.js');
const { round2 } = require('../helpers/pricing.js');

/**
 * Records that the customer intends to settle by Zelle or cash.
 * Nothing is charged and the link stays live, so they can still come back and
 * pay by card if they change their mind.
 */
const chooseOffline = async (req, res) => {
  try {
    let token; let paymentOption; let method;
    try {
      token = v.text(req.body?.token, 'Payment link', { max: 128 });
      paymentOption = v.oneOf(req.body?.paymentOption, 'Payment option', ['deposit', 'full']);
      method = v.oneOf(req.body?.method, 'Payment method', OFFLINE_METHODS);
      if (req.body?.acceptedTerms !== true) {
        return res.status(400).json({
          success: false,
          error: 'Please accept the terms and conditions before continuing.',
        });
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    const payable = await resolvePayable(token, paymentOption, method);
    if (payable.error) {
      return res.status(payable.error.status).json({ success: false, error: payable.error.message });
    }
    const { quote, mode, amount, remaining, isDeposit } = payable;

    // cash cannot hold a date, so it only settles a booking outright
    if (method === 'cash' && mode === 'initial' && isDeposit) {
      return res.status(400).json({
        success: false,
        error: 'Cash is only available when paying in full. Choose another method for a deposit.',
      });
    }

    if (mode === 'balance') {
      quote.balanceMethod = method;
    } else {
      quote.status = 'awaiting_payment';
      quote.paymentOption = isDeposit ? 'deposit' : 'full';
      quote.paymentMethod = method;
      quote.termsAcceptedAt = new Date();
      quote.remainingBalance = remaining;
      quote.processingFee = 0;
      quote.processingFeeRate = 0;
    }
    quote.offlineChosenAt = new Date();
    await quote.save();

    email.sendOfflineInstructions(quote, amount, method, isDeposit)
      .catch((e) => console.error('offline instructions email failed:', e.message));
    email.sendAdminOfflineChosen(quote, amount, method)
      .catch((e) => console.error('admin offline notice failed:', e.message));

    return res.json({
      success: true,
      method: methodLabel(method),
      amountDue: round2(amount),
      remainingBalance: mode === 'balance' ? 0 : remaining,
      instructions: instructionsFor(method),
    });
  } catch (err) {
    console.error('chooseOffline error:', err);
    return res.status(500).json({ success: false, error: 'Could not record your choice' });
  }
};

// MAIL_FROM carries a display name, so take just the address out of it
const bareAddress = (value) => {
  const m = /<([^>]+)>/.exec(String(value || ''));
  return (m ? m[1] : String(value || '')).trim();
};

function instructionsFor(method) {
  if (method === 'zelle') {
    const to = process.env.ZELLE_RECIPIENT || bareAddress(process.env.MAIL_FROM);
    return to
      ? `Send your Zelle payment to ${to}, using your name as the reference. Your booking is held until it arrives.`
      : 'Call us for our Zelle details. Your booking is held until payment arrives.';
  }
  const phone = process.env.CONTACT_PHONE || '917-822-2713';
  return `Call us on ${phone} to arrange cash payment. Your booking is held until we confirm it.`;
}

/** Admin confirmation that the money actually landed. */
const confirmOffline = async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Request not found' });
    if (quote.status === 'paid' && quote.remainingBalancePaid) {
      return res.status(409).json({ error: 'This booking is already settled' });
    }
    if (!quote.offlineChosenAt) {
      return res.status(409).json({ error: 'This booking was not set to pay by Zelle or cash' });
    }

    const settlingBalance = quote.status === 'paid'
      && Number(quote.remainingBalance) > 0 && !quote.remainingBalancePaid;

    if (settlingBalance) {
      quote.remainingBalancePaid = true;
      quote.amountPaid = round2(Number(quote.amountPaid || 0) + Number(quote.remainingBalance));
    } else {
      const total = round2(quote.quotedAmount);
      const due = quote.paymentOption === 'deposit' ? round2(total - Number(quote.remainingBalance)) : total;
      quote.status = 'paid';
      quote.amountPaid = due;
      quote.remainingBalancePaid = quote.paymentOption !== 'deposit';
    }

    quote.offlineConfirmedAt = new Date();
    quote.offlineConfirmedBy = req.user?.id || req.user?._id || undefined;
    // the link has served its purpose once the money is in
    quote.paymentTokenHash = undefined;
    quote.paymentTokenExpires = undefined;
    await quote.save();

    email.sendPaymentReceipt(quote, quote.amountPaid, quote.paymentOption === 'deposit')
      .catch((e) => console.error('receipt email failed:', e.message));

    return res.json({ success: true, amountPaid: quote.amountPaid, remainingBalance: quote.remainingBalance });
  } catch (err) {
    console.error('confirmOffline error:', err);
    return res.status(500).json({ error: 'Could not confirm this payment' });
  }
};

module.exports = { chooseOffline, confirmOffline, instructionsFor };
