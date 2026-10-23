// A booking takes up to this many stop-overs, kept in route order.
const MAX_STOPS = 5;

// bookings made before multiple stops were allowed kept a single stopoverAddress
const stopsOf = (q) => (q?.stopovers?.length
  ? q.stopovers.map((s) => s.address)
  : (q?.stopoverAddress ? [q.stopoverAddress] : []));

// one stop reads as "Stop over"; several are numbered so their order is clear
const stopRows = (q) => {
  const stops = stopsOf(q);
  return stops.map((address, i) => [stops.length > 1 ? `Stop ${i + 1}` : 'Stop over', address]);
};

module.exports = { MAX_STOPS, stopsOf, stopRows };
