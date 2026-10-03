// Reads the fleet from the same Google Sheet the site lists, so open requests are
// matched against exactly what customers can browse. Mirrors frontend/js/sheets.js.

// a type joins the first group it matches, as on the fleet page (frontend/js/index.js)
const CATEGORIES = [
  { id: 'party-bus', label: 'Party bus', types: ['party bus', 'partybus', 'party', 'sprinter limo'] },
  {
    id: 'van-bus',
    label: 'Van, bus or coach',
    types: ['standard', 'multipurpose', 'van', 'bus', 'coach', 'minibus', 'mini bus', 'shuttle', 'jet', 'executive'],
  },
  { id: 'limo-suv', label: 'Limo, SUV or sedan', types: ['limo', 'limousine', 'suv', 'exotic', 'stretch', 'luxury', 'sedan'] },
];

const CITIES = [
  { id: 'nynj', label: 'NY/NJ', match: ['nynj', 'ny/nj', 'ny', 'nj', 'nyc', 'new york', 'new jersey'] },
  { id: 'miami', label: 'Miami', match: ['miami', 'florida', 'fl'] },
];

const VEHICLE_CATEGORIES = ['any', ...CATEGORIES.map((c) => c.id)];
const CITY_IDS = CITIES.map((c) => c.id);

async function fetchFleet() {
  const id = process.env.SHEET_ID;
  const key = process.env.SHEETS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!id || !key) throw new Error('The fleet sheet is not configured. Set SHEET_ID and SHEETS_API_KEY.');

  const range = encodeURIComponent(`${process.env.SHEET_NAME || 'Fleetsheet'}!A:L`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?key=${key}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Could not read the fleet sheet: ${data.error?.message || `HTTP ${res.status}`}`);

  const rows = data.values || [];
  if (rows.length < 2) return [];
  // "Vehicle Make" → "vehiclemake", "Aff. Price" → "affprice", "S/N" → "sn"
  const headers = rows[0].map((h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  return rows.slice(1)
    .filter((row) => row.some((c) => String(c || '').trim()))
    .map((row) => Object.fromEntries(headers.map((h, i) => [h, String(row[i] || '').trim()])));
}

// rows with no city count as NY/NJ, as on the fleet page
function vehicleCity(v) {
  const s = (v.city || v.state || '').toLowerCase().trim();
  if (!s) return 'nynj';
  return (CITIES.find((c) => c.match.some((k) => s.includes(k))) || CITIES[0]).id;
}

function vehicleCategory(v) {
  const type = (v.type || '').toLowerCase().trim();
  return CATEGORIES.find((c) => c.types.some((t) => type.includes(t)))?.id || 'other';
}

const rate = (s) => parseFloat(String(s || '').replace(/[^0-9.]/g, '')) || null;
const seats = (v) => parseInt(v.capacity, 10);

/**
 * Vehicles that fit the request, smallest that seats everyone first. Vehicles
 * without a photo are left out because the fleet page hides them too.
 */
function matchFleet(fleet, { passengers, wants }) {
  return fleet
    .filter((v) => v.sn && (v.pics || '').trim())
    .filter((v) => vehicleCity(v) === wants.city)
    .filter((v) => wants.category === 'any' || vehicleCategory(v) === wants.category)
    .filter((v) => seats(v) >= passengers)
    .sort((a, b) => seats(a) - seats(b))
    .map((v) => ({
      sn: v.sn,
      name: [v.vehiclemake, v.model].filter(Boolean).join(' ') || 'Unknown vehicle',
      type: v.type,
      capacity: v.capacity,
      pic: v.pics.split('|').map((u) => u.trim()).filter(Boolean)[0] || '',
      rates: { retail: rate(v.retprice), affiliate: rate(v.affprice) },
    }));
}

const wantsLabel = (wants = {}) => [
  wants.category === 'any' ? 'Any vehicle' : CATEGORIES.find((c) => c.id === wants.category)?.label,
  CITIES.find((c) => c.id === wants.city)?.label,
].filter(Boolean).join(' · ');

module.exports = { fetchFleet, matchFleet, wantsLabel, VEHICLE_CATEGORIES, CITY_IDS };
