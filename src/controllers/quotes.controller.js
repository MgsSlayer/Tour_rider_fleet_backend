const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');
const { computeQuote } = require('../helpers/pricing.js');
const { zonedToUtc, tripMinutes } = require('../helpers/datetime.js');
const v = require('../helpers/validate.js');
const { hashToken, newToken, depositRate } = require('../helpers/tokens.js');
const { ALL_METHODS, processingFeeRate } = require('../helpers/paymentMethods.js');

// the fleet does not take bookings shorter than this
const MIN_TRIP_HOURS = 3;
const MIN_TRIP_MESSAGE = `Trips run for a minimum of ${MIN_TRIP_HOURS} hours. Please adjust your pick-up or drop-off time.`;


// the form posts wall-clock times in the fleet's timezone, not the server's
const toDateTime = (date, time) => zonedToUtc(date, time);

const publicView = (q) => ({
  id: q._id,
  status: q.status,
  vehicle: q.vehicle,
  customerName: q.customer.name,
  date: q.date,
  pickupTime: q.pickupTime,
  finalDropoffTime: q.finalDropoffTime,
  pickupAddress: q.pickupAddress,
  stopoverAddress: q.stopoverAddress,
  dropoffAddress: q.dropoffAddress,
  passengers: q.passengers,
  tripType: q.tripType,
  baseFare: q.baseFare,
  lineItems: (q.lineItems || []).map((l) => ({ label: l.label, amount: l.amount })),
  quotedAmount: q.quotedAmount,
  depositAmount: q.quotedAmount ? Number((q.quotedAmount * depositRate()).toFixed(2)) : null,
  amountPaid: q.amountPaid,
  remainingBalance: q.remainingBalance,
});

const createQuote = async (req, res) => {
  try {
    const b = req.body || {};
    const L = v.LIMITS;

    const data = {
      vehicleSn: v.text(b.vehicleSn, 'Vehicle', { max: 40 }),
      vehicleName: v.text(b.vehicleName, 'Vehicle name', { required: false, max: L.name }),
      vehicleType: v.text(b.vehicleType, 'Vehicle type', { required: false, max: 60 }),
      vehicleCapacity: v.text(b.vehicleCapacity, 'Capacity', { required: false, max: 10 }),
      name: v.text(b.name, 'Name', { max: L.name }),
      email: v.email(b.email),
      phone: v.text(b.phone, 'Phone number', { required: false, max: L.phone }),
      tripType: v.oneOf(b.tripType, 'Trip type', ['roundtrip', 'one-way', 'shuttle']),
      passengers: v.integer(b.passengers, 'Passengers', { min: 1, max: 100 }),
      date: v.isoDate(b.date, 'Date'),
      pickupTime: v.clockTime(b.pickupTime, 'Pick-up time'),
      finalDropoffTime: v.clockTime(b.finalDropoffTime, 'Final drop-off time'),
      pickupAddress: v.text(b.pickupAddress, 'Pick-up address', { max: L.address }),
      stopoverAddress: v.text(b.stopoverAddress, 'Stop-over address', { required: false, max: L.address }),
      dropoffAddress: v.text(b.dropoffAddress, 'Drop-off address', { max: L.address }),
      message: v.text(b.message, 'Message', { required: false, max: L.message }),
      coords: {
        pickup: v.coords(b.pickupCoords, 'Pick-up'),
        stopover: v.coords(b.stopoverCoords, 'Stop-over'),
        dropoff: v.coords(b.dropoffCoords, 'Drop-off'),
      },
    };

    const pickupDateTime = toDateTime(data.date, data.pickupTime);
    if (!pickupDateTime) return res.status(400).json({ error: 'Invalid date or pick-up time' });
    if (pickupDateTime.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Pick-up date and time must be in the future' });
    }

    const booked = tripMinutes(data.date, data.pickupTime, data.finalDropoffTime);
    if (booked === null || booked < MIN_TRIP_HOURS * 60) {
      return res.status(400).json({ error: MIN_TRIP_MESSAGE });
    }

    const quote = await Quote.create({
      vehicle: { sn: data.vehicleSn, name: data.vehicleName, type: data.vehicleType, capacity: data.vehicleCapacity },
      customer: { name: data.name, email: data.email, phone: data.phone },
      tripType: data.tripType,
      passengers: data.passengers,
      date: data.date,
      pickupTime: data.pickupTime,
      finalDropoffTime: data.finalDropoffTime,
      pickupAddress: data.pickupAddress,
      stopoverAddress: data.stopoverAddress,
      dropoffAddress: data.dropoffAddress,
      message: data.message,
      coords: data.coords,
      pickupDateTime,
    });

    // a failed notification must not lose the customer's request
    email.sendAdminNewRequest(quote).catch((e) => console.error('admin notify failed:', e.message));

    return res.status(201).json({ success: true, id: quote._id });
  } catch (err) {
    return v.handle(res, err, 'Could not submit your request');
  }
};

const listQuotes = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const quotes = await Quote.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ quotes });
  } catch (err) {
    console.error('listQuotes error:', err);
    return res.status(500).json({ error: 'Could not load requests' });
  }
};

const getQuote = async (req, res) => {
  const quote = await Quote.findById(req.params.id).lean();
  if (!quote) return res.status(404).json({ error: 'Request not found' });
  return res.json({ quote });
};

const acceptQuote = async (req, res) => {
  try {
    // priced here rather than trusting the dashboard — this total is what gets charged
    let priced;
    try {
      priced = req.body?.baseFare !== undefined
        ? computeQuote({ baseFare: req.body.baseFare, lineItems: req.body.lineItems || [] })
        : computeQuote({ baseFare: req.body?.quotedAmount, lineItems: [] });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Request not found' });
    if (quote.status !== 'pending') {
      return res.status(409).json({ error: `This request was already ${quote.status}` });
    }

    const rawToken = newToken();
    const ttlDays = Number(process.env.QUOTE_LINK_TTL_DAYS) || 7;

    quote.status = 'accepted';
    quote.baseFare = priced.baseFare;
    quote.lineItems = priced.lineItems;
    quote.quotedAmount = priced.total;
    quote.paymentTokenHash = hashToken(rawToken);
    quote.paymentTokenExpires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    quote.respondedAt = new Date();
    quote.respondedBy = req.user?.id;
    await quote.save();

    const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    const paymentUrl = `${base}/payment.html?token=${rawToken}`;
    const deposit = Number((quote.quotedAmount * depositRate()).toFixed(2));

    try {
      await email.sendQuoteAccepted(quote, paymentUrl, deposit);
    } catch (e) {
      console.error('accept email failed:', e.message);
      return res.status(502).json({
        error: 'Quote saved but the email could not be sent. Resend it from the dashboard.',
        id: quote._id,
      });
    }

    return res.json({ success: true, quote: publicView(quote) });
  } catch (err) {
    console.error('acceptQuote error:', err);
    return res.status(500).json({ error: 'Could not accept this request' });
  }
};

const declineQuote = async (req, res) => {
  try {
    const reason = v.text(req.body?.reason, 'Reason', { max: v.LIMITS.reason });

    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Request not found' });
    if (quote.status !== 'pending') {
      return res.status(409).json({ error: `This request was already ${quote.status}` });
    }

    quote.status = 'declined';
    quote.declineReason = reason;
    quote.respondedAt = new Date();
    quote.respondedBy = req.user?.id;
    await quote.save();

    try {
      await email.sendQuoteDeclined(quote);
    } catch (e) {
      console.error('decline email failed:', e.message);
      return res.status(502).json({ error: 'Request declined but the email could not be sent.', id: quote._id });
    }

    return res.json({ success: true });
  } catch (err) {
    return v.handle(res, err, 'Could not decline this request');
  }
};

// resolves the emailed link; never exposes the whole document
const getQuoteByToken = async (req, res) => {
  try {
    const raw = String(req.query.token || '');
    if (!raw) return res.status(400).json({ error: 'Missing token' });

    const quote = await Quote.findOne({ paymentTokenHash: hashToken(raw) });
    if (!quote) return res.status(404).json({ error: 'This link is not valid' });
    if (quote.paymentTokenExpires && quote.paymentTokenExpires < new Date()) {
      return res.status(410).json({ error: 'This link has expired. Contact us and we will send a new one.' });
    }
    const owesBalance = Number(quote.remainingBalance) > 0 && !quote.remainingBalancePaid;
    if (quote.status === 'paid' && !owesBalance) {
      return res.status(409).json({ error: 'This booking has already been paid.' });
    }
    // a customer who picked Zelle can still come back and pay another way
    if (!['paid', 'accepted', 'awaiting_payment'].includes(quote.status)) {
      return res.status(409).json({ error: 'This request is not open for payment.' });
    }

    // a balance link pays one fixed sum; there is no deposit choice left to make
    const mode = quote.status === 'paid' ? 'balance' : 'initial';
    // the page shows a total per method; the server still prices what it charges
    const fees = Object.fromEntries(ALL_METHODS.map((m) => [m, processingFeeRate(m)]));
    return res.json({ quote: publicView(quote), mode, fees });
  } catch (err) {
    console.error('getQuoteByToken error:', err);
    return res.status(500).json({ error: 'Could not load this quote' });
  }
};

// manual recovery when the scheduled charge failed, or to collect early
const chargeBalance = async (req, res) => {
  try {
    const { chargeBalanceFor } = require('../services/balanceCron.js');
    const result = await chargeBalanceFor(req.params.id);
    if (!result.ok) {
      return res.status(result.skipped ? 409 : 502).json({ error: result.error });
    }
    return res.json({ success: true, amount: result.amount });
  } catch (err) {
    console.error('chargeBalance error:', err);
    return res.status(500).json({ error: 'Could not charge the balance' });
  }
};

// Suggests pricing from the real route. Read-only — nothing is stored, and the
// admin is free to ignore it. Rates come from the dashboard because only the
// browser can read the fleet sheet.
const suggestQuote = async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Request not found' });

    const wantedBase = req.body?.baseId ? String(req.body.baseId) : null;
    const cached = quote.suggestion;

    // Reuse the stored result unless the admin asked for a different base.
    // Each quote costs at most one route lookup, however often it is viewed.
    if (cached?.payload && (!wantedBase || wantedBase === cached.baseId)) {
      return res.json({ ...cached.payload, cached: true, computedAt: cached.computedAt });
    }

    const { suggestPricing } = require('../services/suggestService.js');
    const { ensureSeeded } = require('./bases.controller.js');
    const BaseLocation = require('../models/baseLocation.js');
    const { suggestBase } = require('../helpers/baseMatch.js');
    await ensureSeeded();
    const bases = await BaseLocation.find().lean();

    // with no explicit choice, depart from the yard that best matches the pickup
    const chosen = wantedBase || String(suggestBase(quote.pickupAddress, bases)?._id || '');

    const suggestion = await suggestPricing(quote, {
      retail: req.body?.retailRate,
      affiliate: req.body?.affiliateRate,
    }, bases, chosen);

    quote.suggestion = { computedAt: new Date(), baseId: chosen, payload: suggestion };
    await quote.save();

    return res.json({ ...suggestion, cached: false, computedAt: quote.suggestion.computedAt });
  } catch (err) {
    if (err.code === 'NO_MAPS_KEY') return res.status(503).json({ error: err.message });
    console.error('suggestQuote error:', err.message);
    return res.status(502).json({ error: err.message || 'Could not work out a suggestion' });
  }
};

// Bases ranked against this trip's pickup, best guess first. Costs nothing —
// pure text matching — so the dashboard can offer a pre-selected base before
// committing to the paid route lookup.
const suggestBaseFor = async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id).lean();
    if (!quote) return res.status(404).json({ error: 'Request not found' });

    const { ensureSeeded } = require('./bases.controller.js');
    const BaseLocation = require('../models/baseLocation.js');
    const { rankBases } = require('../helpers/baseMatch.js');
    await ensureSeeded();
    const bases = await BaseLocation.find().lean();

    const ranked = rankBases(quote.pickupAddress, bases);
    return res.json({
      pickupAddress: quote.pickupAddress,
      recommendedId: ranked.length ? String(ranked[0].base._id) : null,
      matched: ranked.length ? ranked[0].score > 0 : false,
      bases: ranked.map((r) => ({
        id: String(r.base._id), label: r.base.label, address: r.base.address, score: r.score,
      })),
    });
  } catch (err) {
    console.error('suggestBaseFor error:', err);
    return res.status(500).json({ error: 'Could not work out which base to use' });
  }
};

module.exports = {
  createQuote, listQuotes, getQuote, acceptQuote, declineQuote, getQuoteByToken, chargeBalance, suggestQuote, suggestBaseFor,
};
