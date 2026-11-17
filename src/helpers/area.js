// An address narrowed to its town and state, for people who need the trip but not the customer's exact address.
// "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA" → "East Rutherford, NJ"
function areaOf(address) {
  const parts = String(address || '').split(',').map((s) => s.trim()).filter(Boolean)
    .filter((p) => !/^(usa|united states)$/i.test(p));
  if (parts.length <= 1) return parts[0] || '';
  // the first part is the street or venue; the zip code goes with it
  const tail = parts.slice(1).map((p) => p.replace(/\s*\d{5}(-\d{4})?$/, '')).filter(Boolean);
  return tail.slice(-2).join(', ');
}

module.exports = { areaOf };
