// The vehicle owner's yes or no, through the link in their email. No login: the link's token is
// the only key, and it opens this one request and nothing else.

const Quote = require('../models/quote.model.js');
const email = require('../services/emailService.js');
const v = require('../helpers/validate.js');
const { hashToken } = require('../helpers/tokens.js');
const { stopsOf } = require('../helpers/stops.js');
const { areaOf } = require('../helpers/area.js');

const findByToken = (raw) => (typeof raw === 'string' && raw.length >= 32
  ? Quote.findOne({ 'affiliate.tokenHash': hashToken(raw) })
  : null);

// an unanswered request stops being askable once the trip has started
const expired = (q) => q.affiliate.status === 'pending' && q.affiliate.tokenExpires && q.affiliate.tokenExpires < new Date();

// what the owner sees: the trip, never the customer or the price
const ownerView = (q) => ({
  vehicle: { name: q.vehicle?.name || '', type: q.vehicle?.type || '', sn: q.vehicle?.sn || '' },
  date: q.date,
  pickupTime: q.pickupTime,
  dropoffTime: q.finalDropoffTime || null,
  tripType: q.tripType,
  passengers: q.passengers,
  pickupArea: areaOf(q.pickupAddress),
  dropoffArea: areaOf(q.dropoffAddress),
  stops: stopsOf(q).length,
  reference: q.reservationNumber || null,
  status: q.affiliate.status,
  respondedAt: q.affiliate.respondedAt || null,
  // the customer's request was turned down, so there's nothing left to answer
  closed: q.status === 'declined',
});

const getAvailability = async (req, res) => {
  try {
    const quote = await findByToken(req.query.token);
    if (!quote) return res.status(404).json({ error: 'This link is not valid. It may have been copied incompletely.' });
    if (expired(quote)) return res.status(410).json({ error: 'This request has expired.' });
    return res.json(ownerView(quote));
  } catch (err) {
    return v.handle(res, err, 'Could not load this request');
  }
};

const respondAvailability = async (req, res) => {
  try {
    const { token, decision } = req.body || {};
    if (!['accept', 'decline'].includes(decision)) throw new v.ValidationError('Choose accept or decline.');
    const reason = decision === 'decline' ? v.text(req.body.reason, 'Reason', { required: false, max: 500 }) : '';

    const quote = await findByToken(token);
    if (!quote) return res.status(404).json({ error: 'This link is not valid. It may have been copied incompletely.' });
    if (expired(quote)) return res.status(410).json({ error: 'This request has expired.' });
    if (quote.status === 'declined') return res.status(409).json({ error: 'This request has been closed.', ...ownerView(quote) });

    // only the first answer counts, even if two arrive at once
    const answered = await Quote.findOneAndUpdate(
      { _id: quote._id, 'affiliate.status': 'pending' },
      { $set: {
        'affiliate.status': decision === 'accept' ? 'accepted' : 'declined',
        'affiliate.respondedAt': new Date(),
        ...(reason ? { 'affiliate.declineReason': reason } : {}),
      } },
      { new: true },
    );
    if (!answered) return res.status(409).json({ error: 'You have already responded to this request.', ...ownerView(quote) });

    // accepted while the request is still waiting: the admin gets the usual request to price;
    // anything else gets a short note of the owner's answer
    const notify = answered.affiliate.status === 'accepted' && answered.status === 'pending'
      ? email.sendAdminNewRequest(answered, { ownerConfirmed: true })
      : email.sendAdminOwnerResponse(answered);
    notify.catch((e) => console.error('owner response email failed:', e.message));

    return res.json(ownerView(answered));
  } catch (err) {
    return v.handle(res, err, 'Could not record your answer');
  }
};

module.exports = { getAvailability, respondAvailability, ownerView };
