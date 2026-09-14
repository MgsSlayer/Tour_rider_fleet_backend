const { SquareClient, SquareEnvironment } = require('square');

if (!process.env.SQUARE_ACCESS_TOKEN) {
  console.warn('SQUARE_ACCESS_TOKEN not set; payments will fail until configured.');
}

// v43 takes `token`, not `accessToken` — the old name authenticates as anonymous
module.exports = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: process.env.SQUARE_ENV === 'production'
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox,
});
