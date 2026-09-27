// PayPal Orders v2 over REST. The checkout-server-sdk the old repo used is
// retired, and this needs no dependency beyond fetch.

const BASE = () => (process.env.PAYPAL_ENV === 'production'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com');

const isConfigured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let cached = { token: null, expiresAt: 0 };

async function accessToken() {
  if (!isConfigured()) throw new Error('PayPal is not configured');
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const basic = Buffer
    .from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`)
    .toString('base64');

  const res = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || 'Could not authenticate with PayPal');
  }

  // renewed a minute early so an in-flight call never uses an expired token
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

/** One authenticated Orders API call. Throws with PayPal's own message on failure. */
async function paypalFetch(path, { method = 'GET', body, requestId } = {}) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      // PayPal replays the original result for a repeated id rather than charging twice
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.details?.[0]?.description || data?.message || `PayPal request failed (${res.status})`;
    const err = new Error(detail);
    err.status = res.status;
    err.issue = data?.details?.[0]?.issue || data?.name || null;
    throw err;
  }
  return data;
}

module.exports = { paypalFetch, isConfigured, BASE };
