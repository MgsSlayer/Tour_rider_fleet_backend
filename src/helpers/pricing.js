// Quote pricing. The server is authoritative — the dashboard previews the same
// maths, but only what this returns is ever stored or charged.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// rates like 8.875% must survive storage intact, so percentages keep 3 decimals
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const MAX_LINES = 12;
const TAX_LABEL = /\btax\b/i;
const GRATUITY_LABEL = /\b(gratuity|tips?)\b/i;

/**
 * Builds a priced breakdown from a base fare plus optional line items.
 *
 * A line is either a flat `amount`, or a `percent` of a basis — where the basis
 * is the base fare and/or any line declared *before* it. Restricting the basis
 * to earlier lines is what keeps the calculation acyclic.
 *
 * @returns {{ baseFare:number, lineItems:Array, total:number }}
 */
function computeQuote({ baseFare, lineItems = [] }) {
  const base = round2(baseFare);
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error('Base fare must be greater than zero');
  }
  if (!Array.isArray(lineItems)) throw new Error('Line items must be a list');
  if (lineItems.length > MAX_LINES) throw new Error(`No more than ${MAX_LINES} line items`);

  const computed = [];
  const priorAmounts = new Map();
  const labels = new Map();

  lineItems.forEach((raw, i) => {
    const label = String(raw?.label || '').trim();
    if (!label) throw new Error('Every line item needs a label');
    if (label.length > 60) throw new Error(`"${label.slice(0, 20)}…" label is too long`);

    const mode = raw.mode === 'percent' ? 'percent' : 'amount';
    const value = Number(raw.value);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`"${label}" needs a value of zero or more`);
    }

    const id = String(raw.id || `li${i}`);
    if (priorAmounts.has(id)) throw new Error(`Duplicate line item id "${id}"`);

    let amount;
    let basis = [];

    if (mode === 'amount') {
      amount = round2(value);
    } else {
      if (value > 100) throw new Error(`"${label}" cannot be more than 100%`);
      basis = Array.isArray(raw.basis) && raw.basis.length ? raw.basis.map(String) : ['base'];

      // sales tax is charged on the fare, never on gratuity
      if (TAX_LABEL.test(label) && basis.some((ref) => GRATUITY_LABEL.test(labels.get(ref) || ''))) {
        throw new Error(`"${label}" cannot be charged on gratuity`);
      }

      let basisTotal = 0;
      for (const ref of basis) {
        if (ref === 'base') { basisTotal += base; continue; }
        if (!priorAmounts.has(ref)) {
          throw new Error(`"${label}" can only be a percentage of the base fare or a line above it`);
        }
        basisTotal += priorAmounts.get(ref);
      }
      amount = round2(basisTotal * (value / 100));
    }

    priorAmounts.set(id, amount);
    labels.set(id, label);
    computed.push({ id, label, mode, value: mode === 'percent' ? round3(value) : round2(value), basis, amount });
  });

  const total = round2(base + computed.reduce((sum, l) => sum + l.amount, 0));
  if (total <= 0) throw new Error('Quote total must be greater than zero');

  return { baseFare: base, lineItems: computed, total };
}

// one sum with one method's processing fee on top
const addFee = (subtotal, rate) => {
  const fee = round2(subtotal * rate);
  return { subtotal, fee, amount: round2(subtotal + fee) };
};

/**
 * What a booking costs paid at one processing-fee rate. Every figure the customer
 * or admin sees comes from here, so no two screens can disagree.
 *
 * The fee is set once on the quote; gratuity added online is passed on at face
 * value, with no fee on it. The deposit is a share of the quote's grand total, and
 * the balance is whatever is left of the grand total, so the two always add up to
 * it to the cent. Gratuity added online goes wholly on the balance.
 *
 * @returns {{ subtotal, fee, total, full, deposit, balance }} deposit and balance are
 *   null when the booking is full payment only; each part is { subtotal, fee, amount }.
 */
function priceBooking({ quotedAmount, gratuity = 0, depositRate = 1, feeRate = 0 }) {
  const quoted = round2(quotedAmount);
  const tip = round2(gratuity);
  const charged = addFee(quoted, feeRate);
  const full = { subtotal: round2(quoted + tip), fee: charged.fee, amount: round2(charged.amount + tip) };
  const result = { subtotal: full.subtotal, fee: full.fee, total: full.amount, full, deposit: null, balance: null };
  if (!(depositRate < 1)) return result;

  const depositSubtotal = round2(quoted * depositRate);
  const deposit = round2(charged.amount * depositRate);
  const balanceSubtotal = round2(full.subtotal - depositSubtotal);
  const balance = round2(full.amount - deposit);
  result.deposit = { subtotal: depositSubtotal, fee: round2(deposit - depositSubtotal), amount: deposit };
  result.balance = { subtotal: balanceSubtotal, fee: round2(balance - balanceSubtotal), amount: balance };
  return result;
}

module.exports = {
  computeQuote, priceBooking, addFee, round2, MAX_LINES,
};
