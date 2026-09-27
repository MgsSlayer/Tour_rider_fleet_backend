// Wall-clock times the customer types ("14:00" on "2026-09-16") mean that time in
// the fleet's own timezone, not the server's. Render runs UTC, so parsing them
// naively shifts every pickup by the UTC offset — 4 hours in New York.

const TZ = () => process.env.FLEET_TZ || 'America/New_York';

// How far `instant` is ahead of UTC in `tz`, in ms (negative for the Americas).
function offsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(instant).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value])
  );
  const asIfUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return asIfUtc - instant.getTime();
}

/**
 * "2026-09-16" + "14:00" in the fleet timezone -> the correct UTC instant.
 * Two passes so times near a DST change resolve against the right offset.
 */
function zonedToUtc(dateStr, timeStr, tz = TZ()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr || '').trim());
  if (!m || !t) return null;

  const wallAsUtc = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(t[1]), Number(t[2]), Number(t[3] || 0)
  );
  if (Number.isNaN(wallAsUtc)) return null;

  let instant = new Date(wallAsUtc - offsetMs(new Date(wallAsUtc), tz));
  instant = new Date(wallAsUtc - offsetMs(instant, tz));
  return Number.isNaN(instant.getTime()) ? null : instant;
}

// Booked minutes between two wall-clock times on the same calendar date.
// A drop-off at or before pick-up means the trip runs past midnight.
function tripMinutes(dateStr, pickupTime, dropoffTime, tz = TZ()) {
  const start = zonedToUtc(dateStr, pickupTime, tz);
  let end = zonedToUtc(dateStr, dropoffTime, tz);
  if (!start || !end) return null;
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return Math.ceil((end - start) / 60000);
}

// Midnight-to-midnight in the fleet timezone, as UTC instants — for "today's pickups".
function zonedDayRange(instant = new Date(), tz = TZ()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant); // en-CA gives YYYY-MM-DD
  const start = zonedToUtc(p, '00:00', tz);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, date: p };
}

// For display and for the .ics DTSTAMP/summary lines.
function formatInZone(instant, tz = TZ()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, dateStyle: 'full', timeStyle: 'short',
  }).format(instant);
}

module.exports = { zonedToUtc, tripMinutes, zonedDayRange, formatInZone, offsetMs, TZ };
