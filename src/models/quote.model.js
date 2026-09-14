const mongoose = require('mongoose');

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
  message: String,

  // resolved pickup instant, used by the balance cron
  pickupDateTime: { type: Date, required: true, index: true },

  status: {
    type: String,
    enum: ['pending', 'accepted', 'declined', 'paid'],
    default: 'pending',
    index: true,
  },

  quotedAmount: Number,
  declineReason: String,
  respondedAt: Date,
  respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  paymentOption: { type: String, enum: ['deposit', 'full'] },
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
}, { timestamps: true });

module.exports = mongoose.model('Quote', quoteSchema);
