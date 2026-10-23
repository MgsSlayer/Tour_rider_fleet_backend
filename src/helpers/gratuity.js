const { round2 } = require('./pricing.js');

// What the customer may choose at checkout when the admin leaves gratuity to them,
// as a share of the base fare.
const GRATUITY_PERCENTS = [10, 15, 20];
const DEFAULT_GRATUITY_PERCENT = 15;

const gratuityAmount = (quote, percent) => round2(round2(Number(quote.baseFare) || 0) * percent / 100);

// the three choices with their amounts, as the email and payment page show them
const gratuityOptions = (quote) => GRATUITY_PERCENTS.map((percent) => ({ percent, amount: gratuityAmount(quote, percent) }));

// only gratuity added to the payment counts; cash goes straight to the driver
const onlineGratuity = (quote) => (quote.gratuity?.method === 'online' ? Number(quote.gratuity.amount) || 0 : 0);

// what the booking costs online: the quote plus any gratuity added to the payment
const bookingTotal = (quote) => round2(Number(quote.quotedAmount) + onlineGratuity(quote));

const gratuityLabel = (g) => `${g.percent}% ($${Number(g.amount).toFixed(2)}), ${g.method === 'online' ? 'added online' : 'cash to driver'}`;

module.exports = {
  GRATUITY_PERCENTS, DEFAULT_GRATUITY_PERCENT, gratuityAmount, gratuityOptions, onlineGratuity, bookingTotal, gratuityLabel,
};
