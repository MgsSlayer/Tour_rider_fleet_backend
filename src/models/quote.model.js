const crypto = require('crypto');
const mongoose = require('mongoose');

// one priced row of the quote breakdown — tolls, gratuity, VAT, or anything custom
const lineItemSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  mode: { type: String, enum: ['amount', 'percent'], default: 'amount' },
  value: { type: Number, required: true },
  basis: [String],
  amount: { type: Number, required: true },
}, { _id: false });

// declared as its own schema so the `type` field isn't read as a type declaration
const vehicleSchema = new mongoose.Schema({
  sn: { type: String, required: true },
  name: { type: String },
  type: { type: String },
  capacity: { type: String },
  pic: { type: String },
}, { _id: false });

// one stop-over, in the order the customer listed it
const stopSchema = new mongoose.Schema({
  address: { type: String, required: true },
  coords: { lat: Number, lng: Number },
}, { _id: false });

// one fleet vehicle that fits an open request, priced for that trip
const matchSchema = new mongoose.Schema({
  sn: { type: String, required: true },
  name: String,
  type: String,
  capacity: String,
  pic: String,
  rates: { retail: Number, affiliate: Number },
  // same shape as a dashboard suggestion: retail first, then affiliate
  candidates: mongoose.Schema.Types.Mixed,
}, { _id: false });

// a charge added after the trip (damage, cleaning…), invoiced and paid on its own
const extraChargeSchema = new mongoose.Schema({
  kind: { type: String, enum: ['damage', 'cleaning', 'other'], required: true },
  description: { type: String, required: true },
  // before any processing fee
  amount: { type: Number, required: true },
  // charged: taken from the card on file; awaiting_payment: invoiced with a link; paid: settled through that link
  status: { type: String, enum: ['charged', 'awaiting_payment', 'paid'], required: true },
  method: String,
  feeRate: Number,
  fee: Number,
  total: Number,
  paymentId: String,
  // why the card on file was not charged, when it fell back to a link
  failureReason: String,
  tokenHash: { type: String, index: true },
  tokenExpires: Date,
  offlineChosenAt: Date,
  paidAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const quoteSchema = new mongoose.Schema({
  // what the customer quotes back, e.g. in a Zelle memo; the database id means nothing to them
  reservationNumber: { type: String, unique: true, sparse: true },
  // an 'open' request arrives without a vehicle; the admin picks one before pricing it
  kind: { type: String, enum: ['vehicle', 'open'], default: 'vehicle' },
  // snapshot of the vehicle chosen on the fleet page, keyed by the sheet S/N
  vehicle: { type: vehicleSchema, required() { return this.kind !== 'open'; } },
  // what an open request asked for in place of a vehicle
  wants: {
    category: String,
    city: String,
  },
  customer: {
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: String,
  },
  tripType: { type: String, enum: ['roundtrip', 'one-way', 'shuttle'], required: true },
  passengers: { type: Number, required: true, min: 1 },
  date: { type: String, required: true },
  pickupTime: { type: String, required: true },
  // a one-way trip without stops gives no drop-off time
  finalDropoffTime: { type: String, required() { return this.tripType !== 'one-way'; } },
  pickupAddress: { type: String, required: true },
  // kept for bookings made before multiple stop-overs; new ones use `stopovers`
  stopoverAddress: String,
  stopovers: { type: [stopSchema], default: undefined },
  dropoffAddress: { type: String, required: true },

  // captured from the customer's autocomplete pick, so the admin map needs no geocoding
  coords: {
    pickup: { lat: Number, lng: Number },
    stopover: { lat: Number, lng: Number },
    dropoff: { lat: Number, lng: Number },
  },
  message: String,

  // resolved pickup instant, used by the balance cron
  pickupDateTime: { type: Date, required: true, index: true },

  status: {
    type: String,
    enum: ['pending', 'accepted', 'declined', 'awaiting_payment', 'paid'],
    default: 'pending',
    index: true,
  },

  // cached price suggestion — computed once per quote so opening the dashboard
  // doesn't re-bill Google's Routes API on every page load
  suggestion: {
    computedAt: Date,
    baseId: String,
    payload: mongoose.Schema.Types.Mixed,
  },

  // fleet vehicles that fit an open request, all priced from one route lookup
  matching: {
    computedAt: Date,
    baseId: String,
    // why the list is empty or unpriced, shown to the admin as-is
    error: String,
    route: mongoose.Schema.Types.Mixed,
    repositioning: mongoose.Schema.Types.Mixed,
    vehicles: { type: [matchSchema], default: undefined },
  },

  baseFare: Number,
  lineItems: [lineItemSchema],
  quotedAmount: Number,
  // share of the total taken up front, set by the admin when sending; 1 means full payment only
  depositRate: { type: Number, min: 0.01, max: 1 },
  // when the admin leaves gratuity to the customer, quotedAmount excludes it and the
  // customer's pick lands here; `method` says whether it was paid online or in cash
  gratuity: {
    customerChooses: Boolean,
    percent: Number,
    amount: Number,
    method: { type: String, enum: ['online', 'cash'] },
  },
  declineReason: String,
  respondedAt: Date,
  respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  paymentOption: { type: String, enum: ['deposit', 'full'] },
  // only 'card' can be kept on file; the rest leave the balance to be collected by link
  paymentMethod: {
    type: String,
    enum: ['card', 'apple_pay', 'google_pay', 'cash_app', 'paypal', 'venmo', 'zelle', 'cash'],
  },
  // surcharge for the method the customer picked, charged on top of the quote
  processingFeeRate: Number,
  processingFee: { type: Number, default: 0 },
  // proof of acceptance at the moment of payment, not merely a ticked box
  termsAcceptedAt: Date,
  amountPaid: { type: Number, default: 0 },
  paymentId: String,

  // sha-256 of the token mailed to the customer; raw value is never stored
  paymentTokenHash: { type: String, index: true },
  paymentTokenExpires: Date,

  squareCustomerId: String,
  squareCardId: String,
  // the saved card is removed from Square after this; until then it can cover damage or cleaning charges
  cardReleaseAt: Date,
  extraCharges: { type: [extraChargeSchema], default: undefined },
  remainingBalance: { type: Number, default: 0 },
  remainingBalancePaid: { type: Boolean, default: false },
  remainingBalancePaymentId: String,
  balanceMethod: String,
  balanceFeeRate: Number,
  balanceProcessingFee: { type: Number, default: 0 },
  balanceChargeStartedAt: Date,
  // a failed automatic charge is not retried on its own; the admin charges it from the dashboard
  balanceChargeFailedAt: Date,
  // stops the pickup-day balance link being mailed more than once
  balanceLinkSentAt: Date,

  // PayPal and Venmo settle through the Orders API rather than Square
  paypalOrderId: { type: String, index: true },
  paypalCaptureId: String,

  // Zelle and cash settle outside the app; the admin confirms the money landed
  offlineChosenAt: Date,
  offlineConfirmedAt: Date,
  offlineConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// TR- plus six digits: short enough for a Zelle memo, random so it says nothing about volume.
// Assigned on first save, so bookings made before this get one the next time they change.
quoteSchema.pre('validate', async function assignReservationNumber() {
  if (this.reservationNumber) return;
  for (let i = 0; i < 10; i += 1) {
    const candidate = `TR-${crypto.randomInt(100000, 1000000)}`;
    if (!(await this.constructor.exists({ reservationNumber: candidate }))) {
      this.reservationNumber = candidate;
      return;
    }
  }
  throw new Error('Could not assign a reservation number');
});

module.exports = mongoose.model('Quote', quoteSchema);
