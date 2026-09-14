const crypto = require('crypto');
const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');

const depositRate = () => {
  const r = Number(process.env.DEPOSIT_RATE);
  return Number.isFinite(r) && r > 0 && r < 1 ? r : 0.5;
};

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// combines the date and time strings the form posts into a single instant
const toDateTime = (date, time) => {
  const dt = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`);
  return Number.isNaN(dt.getTime()) ? null : dt;
};

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
  quotedAmount: q.quotedAmount,
  depositAmount: q.quotedAmount ? Number((q.quotedAmount * depositRate()).toFixed(2)) : null,
  amountPaid: q.amountPaid,
});

const createQuote = async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['name', 'email', 'passengers', 'date', 'pickupTime',
      'finalDropoffTime', 'pickupAddress', 'dropoffAddress', 'tripType', 'vehicleSn'];
    const missing = required.filter((f) => !b[f] && b[f] !== 0);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email))) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    if (!['roundtrip', 'one-way', 'shuttle'].includes(b.tripType)) {
      return res.status(400).json({ error: 'Invalid trip type' });
    }
    const passengers = Number(b.passengers);
    if (!Number.isInteger(passengers) || passengers < 1) {
      return res.status(400).json({ error: 'Passengers must be a positive whole number' });
    }

    const pickupDateTime = toDateTime(b.date, b.pickupTime);
    if (!pickupDateTime) return res.status(400).json({ error: 'Invalid date or pick-up time' });
    if (pickupDateTime.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Pick-up date and time must be in the future' });
    }

    const quote = await Quote.create({
      vehicle: { sn: String(b.vehicleSn), name: b.vehicleName, type: b.vehicleType, capacity: b.vehicleCapacity },
      customer: { name: b.name, email: b.email, phone: b.phone },
      tripType: b.tripType,
      passengers,
      date: b.date,
      pickupTime: b.pickupTime,
      finalDropoffTime: b.finalDropoffTime,
      pickupAddress: b.pickupAddress,
      stopoverAddress: b.stopoverAddress,
      dropoffAddress: b.dropoffAddress,
      message: b.message,
      pickupDateTime,
    });

    // a failed notification must not lose the customer's request
    email.sendAdminNewRequest(quote).catch((e) => console.error('admin notify failed:', e.message));

    return res.status(201).json({ success: true, id: quote._id });
  } catch (err) {
    console.error('createQuote error:', err);
    return res.status(500).json({ error: 'Could not submit your request' });
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
    const amount = Number(req.body?.quotedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Provide a quote amount greater than zero' });
    }

    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Request not found' });
    if (quote.status !== 'pending') {
      return res.status(409).json({ error: `This request was already ${quote.status}` });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const ttlDays = Number(process.env.QUOTE_LINK_TTL_DAYS) || 7;

    quote.status = 'accepted';
    quote.quotedAmount = Number(amount.toFixed(2));
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
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to decline' });

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
    console.error('declineQuote error:', err);
    return res.status(500).json({ error: 'Could not decline this request' });
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
    if (quote.status === 'paid') return res.status(409).json({ error: 'This booking has already been paid.' });
    if (quote.status !== 'accepted') return res.status(409).json({ error: 'This request is not open for payment.' });

    return res.json({ quote: publicView(quote) });
  } catch (err) {
    console.error('getQuoteByToken error:', err);
    return res.status(500).json({ error: 'Could not load this quote' });
  }
};

module.exports = {
  createQuote, listQuotes, getQuote, acceptQuote, declineQuote, getQuoteByToken,
  depositRate, hashToken,
};
