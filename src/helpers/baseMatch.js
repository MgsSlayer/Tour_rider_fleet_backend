// Guesses which yard a trip most likely departs from, by comparing the pickup
// address against each base's address. Pure text — no API calls — so it costs
// nothing to offer the admin a pre-selected base before they commit to pricing.

const STATES = {
  'new york': 'ny', 'new jersey': 'nj', florida: 'fl', connecticut: 'ct',
  pennsylvania: 'pa', massachusetts: 'ma', maryland: 'md', delaware: 'de',
  virginia: 'va', georgia: 'ga', california: 'ca', texas: 'tx', nevada: 'nv',
};

const STOP = new Set(['usa', 'united', 'states', 'st', 'street', 'ave', 'avenue',
  'rd', 'road', 'blvd', 'boulevard', 'dr', 'drive', 'lane', 'ln', 'suite', 'ste',
  'e', 'w', 'n', 's', 'the', 'of']);

/** Locality words worth comparing — city names and state codes, not house numbers. */
function tokens(address) {
  let text = String(address || '').toLowerCase();
  for (const [name, code] of Object.entries(STATES)) {
    text = text.split(name).join(code);
  }
  return new Set(
    text.split(/[^a-z]+/)
      .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
  );
}

/**
 * Scores each base against the pickup address and returns them best-first.
 * A shared state code is worth more than an incidental word match.
 */
function rankBases(pickupAddress, bases = []) {
  const pickup = tokens(pickupAddress);
  const stateCodes = new Set(Object.values(STATES));

  return bases
    .map((base) => {
      const theirs = tokens(base.address);
      let score = 0;
      for (const word of theirs) {
        if (!pickup.has(word)) continue;
        score += stateCodes.has(word) ? 3 : 1;
      }
      return { base, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** The single best guess, or the first base when nothing matches. */
function suggestBase(pickupAddress, bases = []) {
  if (!bases.length) return null;
  const ranked = rankBases(pickupAddress, bases);
  return ranked[0].score > 0 ? ranked[0].base : bases[0];
}

module.exports = { rankBases, suggestBase, tokens };
