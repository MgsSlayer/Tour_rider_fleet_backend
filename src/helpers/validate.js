// Shared input validation. Every field that reaches the database, an email or a
// PDF goes through here, so limits live in one place rather than per-controller.

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

// Caps chosen so values stay sane in an email subject, a PDF cell and a Mongo doc.
const LIMITS = {
  name: 120,
  email: 254,        // RFC 5321 maximum
  phone: 40,
  address: 200,
  label: 60,
  message: 2000,
  reason: 500,
  password: 200,     // generous for passphrases, bounded against abuse
};

const EMAIL_RE = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

/** A trimmed string, type-checked and length-capped. */
function text(value, field, { required = true, max = 255, min = 1, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  // objects and arrays are never acceptable input — this is what turns a
  // NoSQL-injection probe into a clean 400 instead of a 500
  if (typeof value === 'object' || typeof value === 'boolean') {
    throw new ValidationError(`${field} must be text`);
  }
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string') throw new ValidationError(`${field} must be text`);

  const out = trim ? raw.trim() : raw;
  if (!out) {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  if (out.length < min) throw new ValidationError(`${field} must be at least ${min} characters`);
  if (out.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`);
  return out;
}

function email(value, field = 'Email') {
  const out = text(value, field, { max: LIMITS.email });
  if (!EMAIL_RE.test(out)) throw new ValidationError('Please provide a valid email address');
  return out.toLowerCase();
}

/** Passwords keep their whitespace — it can be deliberate — but must be a string. */
function password(value, field = 'Password') {
  return text(value, field, { max: LIMITS.password, min: 1, trim: false });
}

function integer(value, field, { min = null, max = null } = {}) {
  if (typeof value === 'object' || typeof value === 'boolean' || value === '' || value === null || value === undefined) {
    throw new ValidationError(`${field} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number`);
  if (min !== null && n < min) throw new ValidationError(`${field} must be at least ${min}`);
  if (max !== null && n > max) throw new ValidationError(`${field} must be no more than ${max}`);
  return n;
}

/** A {lat,lng} pair, or null. Rejects anything outside real coordinate ranges. */
function coords(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} coordinates are malformed`);
  }
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new ValidationError(`${field} coordinates are out of range`);
  }
  return { lat, lng };
}

function oneOf(value, field, allowed) {
  const out = text(value, field, { max: 40 });
  if (!allowed.includes(out)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return out;
}

function isoDate(value, field = 'Date') {
  const out = text(value, field, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) throw new ValidationError(`${field} must be a valid date`);
  return out;
}

function clockTime(value, field = 'Time') {
  const out = text(value, field, { max: 8 });
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(out)) throw new ValidationError(`${field} must be a valid time`);
  const [h, m] = out.split(':').map(Number);
  if (h > 23 || m > 59) throw new ValidationError(`${field} must be a valid time`);
  return out;
}

/** Wraps a controller so a ValidationError becomes a 400 instead of a 500. */
function handle(res, err, fallback) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  console.error(`${fallback} error:`, err);
  return res.status(500).json({ error: fallback });
}

module.exports = {
  ValidationError, LIMITS,
  text, email, password, integer, oneOf, isoDate, clockTime, coords, handle,
};
