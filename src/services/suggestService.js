// Distance-based price *suggestion* for the admin. Ported from booking-form's
// calculateInvoice, but it only ever proposes numbers — the admin edits or
// ignores them, and acceptQuote re-prices whatever they actually submit.

const { tripMinutes } = require('../helpers/datetime.js');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const LONG_HAUL_FEE = Number(process.env.REPOSITION_FEE) || 150;
const TAX_RATE = Number(process.env.TAX_RATE) || 0.08875;
const TIP_RATE = Number(process.env.DEFAULT_TIP_RATE) || 0.20;
const usd = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// durations read as hours and minutes, never as a bare minute count
function formatDuration(minutes) {
  const total = Math.round(Number(minutes) || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// thresholds past which a pickup counts as a long deadhead
const FAR_HOURS = 1;
const FAR_MILES = 40;

const key = () => process.env.GOOGLE_MAPS_API_KEY;

/** Drive time, distance and tolls for the actual route. */
async function routeFacts({ pickupAddress, stopoverAddress, dropoffAddress }) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key(),
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.travelAdvisory.tollInfo,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: { address: pickupAddress },
      destination: { address: dropoffAddress },
      // a Waypoint takes the address directly; wrapping it in `location` is
      // rejected outright, which silently broke every trip with a stop-over
      intermediates: stopoverAddress ? [{ address: stopoverAddress }] : [],
      travelMode: 'DRIVE',
      extraComputations: ['TOLLS'],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Route lookup failed');
  if (!data.routes?.length) throw new Error('No route found between those addresses');

  const route = data.routes[0];
  const seconds = parseInt(String(route.duration).replace('s', ''), 10);
  const price = route.travelAdvisory?.tollInfo?.estimatedPrice?.[0];
  const tolls = price ? Number(price.units || 0) + Number(price.nanos || 0) / 1e9 : 0;

  return {
    driveMinutes: Math.ceil(seconds / 60),
    miles: round2((route.distanceMeters || 0) / 1609.34),
    tolls: round2(tolls),
    // rides along with the call we already make, so the admin map can draw the
    // real road route without spending a separate Directions request
    polyline: route.polyline?.encodedPolyline || null,
  };
}

/**
 * Repositioning is measured from whichever yard is the shortest drive to the
 * pickup — a Miami job leaving from a Miami base should not be surcharged for
 * a vehicle sitting in Brooklyn.
 *
 * One Directions call per base. Fine for a handful of yards; past a dozen or so
 * it would be worth pre-filtering by straight-line distance first.
 */
async function nearestBase(pickupAddress, bases) {
  if (!bases.length) return { fee: 0, base: null, miles: null, minutes: null };

  const legs = await Promise.all(bases.map(async (b) => {
    try {
      const url = 'https://maps.googleapis.com/maps/api/directions/json'
        + `?origin=${encodeURIComponent(b.address)}`
        + `&destination=${encodeURIComponent(pickupAddress)}&key=${key()}`;
      const leg = (await (await fetch(url)).json())?.routes?.[0]?.legs?.[0];
      if (!leg) return null;
      return {
        base: b,
        miles: round2(leg.distance.value / 1609.34),
        minutes: Math.round(leg.duration.value / 60),
      };
    } catch {
      return null; // one unreachable base must not sink the whole suggestion
    }
  }));

  const reachable = legs.filter(Boolean);
  if (!reachable.length) return { fee: 0, base: null, miles: null, minutes: null };

  const closest = reachable.reduce((a, b) => (b.miles < a.miles ? b : a));
  const far = closest.minutes / 60 > FAR_HOURS || closest.miles > FAR_MILES;
  // the fee repeats for every whole hour past the threshold, so a pickup a day
  // away is not priced like one just over the line
  const units = far ? Math.max(1, Math.floor(closest.minutes / 60) - FAR_HOURS) : 0;
  return { ...closest, units, fee: round2(LONG_HAUL_FEE * units) };
}

/** Hours the vehicle is actually booked for, never less than the drive time. */
function billableHours(quote, driveMinutes) {
  const booked = tripMinutes(quote.date, quote.pickupTime, quote.finalDropoffTime);
  if (booked === null) throw new Error('This request has an unreadable date or time');
  const minutes = Math.max(booked, driveMinutes);
  // 36 minutes or more rounds up. Compared in whole minutes because the original
  // float test (raw % 1 >= 0.6) misses exact cases — 6.6 % 1 is 0.5999999999999996.
  const whole = Math.floor(minutes / 60);
  return Math.max(1, minutes % 60 >= 36 ? whole + 1 : whole);
}

/**
 * One priced candidate, shaped like the breakdown editor expects.
 *
 * The repositioning fee is folded into the base fare rather than itemised, so
 * the customer never sees a separate surcharge — but it is still in the total,
 * and `baseFareParts` spells out what the number is made of for the admin.
 */
function candidate(label, hourlyRate, { hours, tolls, repositioning }) {
  const rate = Number(hourlyRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const driveTime = round2(rate * hours);
  const baseFare = round2(driveTime + repositioning);

  const lineItems = [];
  if (tolls > 0) lineItems.push({ label: 'Tolls', mode: 'amount', value: tolls });
  if (TIP_RATE > 0) {
    lineItems.push({ label: 'Gratuity', mode: 'percent', value: round3(TIP_RATE * 100), basis: ['base'] });
  }
  if (TAX_RATE > 0) {
    lineItems.push({ label: 'VAT', mode: 'percent', value: round3(TAX_RATE * 100), basis: ['base'] });
  }

  return {
    label,
    hourlyRate: rate,
    baseFare,
    // what the admin is shown so the base fare is never a mystery number
    baseFareParts: { hours, hourlyRate: rate, driveTime, repositioning },
    lineItems,
  };
}

/**
 * Suggests pricing for a quote. `rates` carries the vehicle's sheet prices,
 * which only the browser can read — the backend never touches the Sheet.
 */
async function suggestPricing(quote, rates = {}, bases = [], chosenBaseId = null) {
  if (!key()) {
    const err = new Error('Price suggestions are unavailable. GOOGLE_MAPS_API_KEY is not set.');
    err.code = 'NO_MAPS_KEY';
    throw err;
  }

  const facts = await routeFacts(quote);
  // an explicit choice measures from that base alone — one Directions call
  // instead of one per base, and it respects the admin's judgement
  const chosen = chosenBaseId && bases.find((b) => String(b._id) === String(chosenBaseId));
  const near = await nearestBase(quote.pickupAddress, chosen ? [chosen] : bases);
  const hours = billableHours(quote, facts.driveMinutes);
  const ctx = { hours, tolls: facts.tolls, repositioning: near.fee };

  const candidates = [
    candidate('Retail', rates.retail, ctx),
    candidate('Affiliate', rates.affiliate, ctx),
  ].filter(Boolean);

  if (!candidates.length) {
    throw new Error('This vehicle has no Aff. or Ret. price set in the sheet.');
  }

  return {
    route: { ...facts, hours },
    repositioning: {
      fee: near.fee,
      units: near.units || 0,
      unitFee: LONG_HAUL_FEE,
      baseLabel: near.base?.label || null,
      baseAddress: near.base?.address || null,
      miles: near.miles,
      minutes: near.minutes,
      charged: near.fee > 0,
      // spelled out because the fee is invisible once folded into the base fare
      note: !bases.length
        ? 'No base locations saved, so no repositioning fee was applied.'
        : near.fee > 0
          ? `Pickup is ${near.miles} mi / ${formatDuration(near.minutes)} from ${near.base.label}, `
            + `beyond the ${FAR_MILES} mi / ${formatDuration(FAR_HOURS * 60)} threshold. `
            + (near.units > 1
              ? `${usd(LONG_HAUL_FEE)} × ${near.units} h past the threshold = ${usd(near.fee)} `
              : `${usd(near.fee)} `)
            + 'repositioning is included in the base fare below, '
            + 'so the customer sees one base fare rather than a separate charge.'
          : `Pickup is ${near.miles} mi from ${near.base.label}. No repositioning fee applied.`,
    },
    candidates,
  };
}

module.exports = { suggestPricing, billableHours, candidate, routeFacts, nearestBase, formatDuration };
