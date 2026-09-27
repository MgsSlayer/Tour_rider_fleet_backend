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
}, { _id: false });

const quoteSchema = new mongoose.Schema({
  // snapshot of the vehicle chosen on the fleet page, keyed by the sheet S/N
  vehicle: { type: vehicleSchema, required: true },
  customer: {
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: String,
  },
  tripType: { type: String, enum: ['roundtrip', 'one-way', 'shuttle'], required: true },
  passengers: { type: Number, required: true, min: 1 },
  date: { type: String, required: true },
  pickupTime: { type: String, required: true },
  finalDropoffTime: { type: String, required: true },
  pickupAddress: { type: String, required: true },
  stopoverAddress: String,
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

  baseFare: Number,
  lineItems: [lineItemSchema],
  quotedAmount: Number,
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
  remainingBalance: { type: Number, default: 0 },
  remainingBalancePaid: { type: Boolean, default: false },
  remainingBalancePaymentId: String,
  balanceMethod: String,
  balanceFeeRate: Number,
  balanceProcessingFee: { type: Number, default: 0 },
  balanceChargeStartedAt: Date,
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

module.exports = mongoose.model('Quote', quoteSchema);
