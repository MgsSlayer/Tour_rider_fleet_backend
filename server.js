require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const dbconnect = require('./src/config/dbconnect.js');
const { chargeDueBalances } = require('./src/services/balanceCron.js');

const app = express();
const PORT = process.env.PORT || 5001;

const REQUIRED_ENV = ['DB_CONNECT_STRING', 'JWT_SECRET', 'SMTP_USER', 'SMTP_PASS'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}. See .env.example`);
  process.exit(1);
}

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // same-origin and server-to-server calls arrive without an Origin header
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', require('./src/routes/api/auth.route.js'));
app.use('/api/quotes', require('./src/routes/api/quotes.route.js'));
app.use('/api/square', require('./src/routes/api/payment.route.js'));

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

    // balances for today's pickups, every morning at 08:00 server time
    cron.schedule('0 8 * * *', () => {
      chargeDueBalances().catch((e) => console.error('balance cron failed:', e.message));
    });
  })
  .catch((err) => {
    console.error('failed to start:', err.message);
    process.exit(1);
  });
