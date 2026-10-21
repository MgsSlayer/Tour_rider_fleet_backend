require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const dbconnect = require('./src/config/dbconnect.js');
const { chargeArrivedBalances, sendDueBalanceLinks } = require('./src/services/balanceCron.js');

const app = express();
const PORT = process.env.PORT || 5001;

const REQUIRED_ENV = ['DB_CONNECT_STRING', 'JWT_SECRET', 'SMTP_USER', 'SMTP_PASS'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}. See .env.example`);
  process.exit(1);
}

// Render terminates TLS at its proxy — needed for real client IPs in rate limiting
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// The backend also serves the frontend, so most calls are same-origin — and
// browsers still send an Origin header on those. Always allow the request's own
// origin, then whatever CORS_ORIGINS adds on top.
app.use(cors((req, cb) => {
  const origin = req.header('Origin');
  const selfOrigin = `${req.protocol}://${req.get('host')}`;
  const allowed = !origin
    || origin === selfOrigin
    || allowedOrigins.includes('*')
    || allowedOrigins.includes(origin);
  cb(allowed ? null : new Error('Not allowed by CORS'), { origin: allowed });
}));
app.use(express.json({ limit: '100kb' }));

// serves the static frontend so a single origin (and one tunnel) covers the whole app
app.use(express.static(require('path').join(__dirname, '../frontend')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', require('./src/routes/api/auth.route.js'));
app.use('/api/quotes', require('./src/routes/api/quotes.route.js'));
app.use('/api/square', require('./src/routes/api/payment.route.js'));
app.use('/api/bases', require('./src/routes/api/bases.route.js'));
app.use('/api/paypal', require('./src/routes/api/paypal.route.js'));
app.use('/api/offline', require('./src/routes/api/offline.route.js'));

app.use((err, req, res, next) => {
  if (err?.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.error('unhandled error:', err);
  return res.status(500).json({ error: 'Something went wrong' });
});

dbconnect()
  .then(() => {
    app.listen(PORT, () => console.log(`TR backend listening on ${PORT}`));

    // saved cards are charged 15 minutes after pickup; checked every 5 minutes
    cron.schedule('*/5 * * * *', () => {
      chargeArrivedBalances().catch((e) => console.error('arrival charge cron failed:', e.message));
    });

    // balance links for deposits with no card behind them, every morning at 08:00 server time
    cron.schedule('0 8 * * *', () => {
      sendDueBalanceLinks().catch((e) => console.error('balance link cron failed:', e.message));
    });
  })
  .catch((err) => {
    console.error('failed to start:', err.message);
    process.exit(1);
  });
