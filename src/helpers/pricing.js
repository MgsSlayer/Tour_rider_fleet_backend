// Quote pricing. The server is authoritative — the dashboard previews the same
// maths, but only what this returns is ever stored or charged.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// rates like 8.875% must survive storage intact, so percentages keep 3 decimals
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const MAX_LINES = 12;

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
    computed.push({ id, label, mode, value: mode === 'percent' ? round3(value) : round2(value), basis, amount });
  });

  const total = round2(base + computed.reduce((sum, l) => sum + l.amount, 0));
  if (total <= 0) throw new Error('Quote total must be greater than zero');

  return { baseFare: base, lineItems: computed, total };
}

module.exports = { computeQuote, round2, MAX_LINES };
