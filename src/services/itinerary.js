// Booking itinerary — deliberately carries NO pricing. It is the sheet you hand
// a driver, so it holds the trip and how to reach the customer, nothing else.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatInZone, zonedToUtc } = require('../helpers/datetime.js');
const { round2 } = require('../helpers/pricing.js');

const METHOD_LABELS = {
  card: 'card', apple_pay: 'Apple Pay', google_pay: 'Google Pay', cash_app: 'Cash App Pay',
  paypal: 'PayPal', venmo: 'Venmo', zelle: 'Zelle', cash: 'cash',
};

const INK = '#0a0a0a';
const GOLD = '#c9992a';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

// bundled rather than fetched, so building a PDF never depends on the network
const LOGO_PATH = path.join(__dirname, '../../../frontend/css/logo_tour_ride-removebg-preview-1-3-300x175.png');
let logoBuffer;
function logo() {
  if (logoBuffer === undefined) {
    try {
      logoBuffer = fs.readFileSync(LOGO_PATH);
    } catch (e) {
      logoBuffer = null;
      console.warn('itinerary logo missing, falling back to wordmark:', e.message);
    }
  }
  return logoBuffer;
}

/** Phone when we have it, otherwise the email alone. */
function contactLines(customer) {
  const lines = [];
  if (customer.phone && String(customer.phone).trim()) lines.push(['Phone', String(customer.phone).trim()]);
  if (customer.email) lines.push(['Email', customer.email]);
  return lines;
}

function itineraryRows(quote) {
  const rows = [
    ['Vehicle', quote.vehicle?.name || quote.vehicle?.type || 'Assigned vehicle'],
    ['Trip type', quote.tripType],
    ['Passengers', String(quote.passengers)],
    ['Pick-up', formatInZone(new Date(quote.pickupDateTime))],
    ['Pick-up address', quote.pickupAddress],
  ];
  if (quote.stopoverAddress) rows.push(['Stop over', quote.stopoverAddress]);
  rows.push(['Drop-off address', quote.dropoffAddress]);
  rows.push(['Final drop-off', `${quote.finalDropoffTime} (${quote.date})`]);
  if (quote.message) rows.push(['Customer note', quote.message]);
  return rows;
}

/** Brand footer, shared by the itinerary and the invoice. */
function drawFooter(doc, left, right, note) {
  // must clear the bottom margin, or pdfkit spills the last line onto a new page
  const base = doc.page.height - 118;
  doc.fillColor(INK).fontSize(11).font('Helvetica-Bold')
    .text('TOUR RIDER', left, base, { width: right - left, align: 'center', characterSpacing: 1.4 });
  doc.fillColor(MUTED).fontSize(8).font('Helvetica')
    .text('NYC LIMO &', left, base + 16, { width: right - left, align: 'center', characterSpacing: 1 })
    .text('PARTY BUS RENTALS', left, base + 27, { width: right - left, align: 'center', characterSpacing: 1 });
  if (note) {
    doc.fillColor('#9ca3af').fontSize(7)
      .text(note, left, base + 44, { width: right - left, align: 'center' });
  }
}

/** Draws the branded header band; `kind` labels the document. */
function drawHeader(doc, quote, kind) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const headerH = 104;

  doc.rect(0, 0, doc.page.width, headerH).fill(INK);
  const mark = logo();
  if (mark) {
    doc.image(mark, left, 22, { width: 104, height: 61 });
  } else {
    doc.fillColor(GOLD).fontSize(20).font('Helvetica-Bold')
      .text('TOUR RIDER', left, 34, { characterSpacing: 2 });
  }
  doc.fillColor('#9ca3af').fontSize(9).font('Helvetica')
    .text(kind, left, 40, { width: right - left, align: 'right', characterSpacing: 1.5 });
  doc.fillColor('#9ca3af').fontSize(9)
    .text(`Ref ${quote._id}`, left, 56, { width: right - left, align: 'right' });

  return { left, right, y: headerH + 32 };
}

/** Renders the itinerary and resolves to a PDF Buffer. */
function buildItineraryPDF(quote) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { left, right } = drawHeader(doc, quote, 'BOOKING ITINERARY');
    let y = 136;
    doc.fillColor(INK).fontSize(16).font('Helvetica-Bold')
      .text(quote.customer?.name || 'Booking', left, y);
    y += 26;

    const section = (title, rows) => {
      doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
        .text(title.toUpperCase(), left, y, { characterSpacing: 1.2 });
      y += 16;
      rows.forEach(([k, v]) => {
        const text = String(v ?? '');
        const h = Math.max(doc.heightOfString(text, { width: right - left - 130 }), 12);
        doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(k, left, y, { width: 120 });
        doc.fillColor(INK).fontSize(10).font('Helvetica-Bold')
          .text(text, left + 130, y - 1, { width: right - left - 130 });
        y += h + 9;
        doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor(LINE).stroke();
      });
      y += 14;
    };

    section('Trip', itineraryRows(quote));
    section('Customer', [['Name', quote.customer?.name], ...contactLines(quote.customer || {})]);

    drawFooter(doc, left, right);
    doc.end();
  });
}


// ── Invoice ──────────────────────────────────────────────────────────────────
// The customer-facing document. Unlike the itinerary it *does* carry pricing.

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

/** Renders the customer invoice and resolves to a PDF Buffer. */
function buildInvoicePDF(quote, amountPaid, isDeposit) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { left, right } = drawHeader(doc, quote, 'INVOICE');
    let y = 136;

    doc.fillColor(INK).fontSize(16).font('Helvetica-Bold')
      .text(quote.customer?.name || 'Customer', left, y);
    y += 20;
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
      .text([quote.customer?.email, quote.customer?.phone].filter(Boolean).join('  ·  '), left, y);
    y += 26;

    const row = (label, value, opts = {}) => {
      const height = Math.max(doc.heightOfString(String(value), { width: 200 }), 12);
      doc.fillColor(opts.strong ? INK : MUTED)
        .fontSize(opts.strong ? 11 : 9.5)
        .font(opts.strong ? 'Helvetica-Bold' : 'Helvetica')
        .text(label, left, y, { width: right - left - 210 });
      doc.fillColor(INK).fontSize(opts.strong ? 12 : 10)
        .font(opts.strong ? 'Helvetica-Bold' : 'Helvetica')
        .text(String(value), right - 200, y - 1, { width: 200, align: 'right' });
      y += height + 8;
      doc.moveTo(left, y - 3).lineTo(right, y - 3)
        .lineWidth(opts.strong ? 1 : 0.5).strokeColor(opts.strong ? MUTED : LINE).stroke();
      y += opts.strong ? 6 : 2;
    };

    const section = (title) => {
      doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
        .text(title.toUpperCase(), left, y, { characterSpacing: 1.2 });
      y += 16;
    };

    section('Trip');
    itineraryRows(quote).forEach(([k, v]) => row(k, v));
    y += 10;

    section('Charges');
    row('Base fare', money(quote.baseFare ?? quote.quotedAmount));
    (quote.lineItems || []).forEach((l) => row(l.label, money(l.amount)));
    row('Total', money(quote.quotedAmount), { strong: true });
    y += 10;

    section('Payment');
    const fee = Number(quote.processingFee || 0);
    const method = METHOD_LABELS[quote.paymentMethod] || null;
    // a surcharge has to be visible on the receipt, not folded into one figure
    if (fee > 0) {
      row(isDeposit ? 'Deposit' : 'Amount', money(round2(amountPaid - fee)));
      const pct = quote.processingFeeRate ? ` (${round2(quote.processingFeeRate * 100)}%)` : '';
      row(`${method || 'Card'} processing fee${pct}`, money(fee));
    }
    row(isDeposit ? 'Deposit paid' : 'Paid in full', money(amountPaid), { strong: true });
    if (method) {
      doc.fillColor(MUTED).fontSize(8.5).font('Helvetica')
        .text(`Paid by ${method}.`, left, y, { width: right - left });
      y += 14;
    }
    if (isDeposit && quote.remainingBalance > 0) {
      row('Balance due on pickup day', money(quote.remainingBalance));
      doc.fillColor(MUTED).fontSize(8.5).font('Helvetica')
        .text(quote.squareCardId
          ? 'The balance will be charged automatically to the card on file on the morning of your trip.'
          : 'We will email you a payment link for the balance on the morning of your trip.',
          left, y, { width: right - left });
      y += 22;
    } else {
      doc.fillColor(MUTED).fontSize(8.5).font('Helvetica')
        .text('Nothing further is due.', left, y, { width: right - left });
      y += 22;
    }

    drawFooter(doc, left, right, 'Thank you for choosing Tour Rider.');
    doc.end();
  });
}

// ── Calendar invite ──────────────────────────────────────────────────────────

const icsEscape = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// RFC 5545 caps lines at 75 octets; long addresses must be folded
const fold = (line) => {
  if (Buffer.byteLength(line) <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' '; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
};

/** An .ics VEVENT for the trip, stable UID so re-sends update rather than duplicate. */
function buildCalendarInvite(quote) {
  const start = new Date(quote.pickupDateTime);
  let end = zonedToUtc(quote.date, quote.finalDropoffTime);
  if (!end) end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  // a drop-off at or before pickup means the trip runs past midnight
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);

  const who = quote.customer || {};
  const contact = who.phone && String(who.phone).trim()
    ? `${String(who.phone).trim()} / ${who.email}`
    : `${who.email}`;

  const description = [
    `Customer: ${who.name}`,
    `Contact: ${contact}`,
    `Vehicle: ${quote.vehicle?.name || quote.vehicle?.type || 'Assigned vehicle'}`,
    `Passengers: ${quote.passengers}`,
    `Trip type: ${quote.tripType}`,
    `Pick-up: ${quote.pickupAddress}`,
    quote.stopoverAddress ? `Stop over: ${quote.stopoverAddress}` : null,
    `Drop-off: ${quote.dropoffAddress}`,
    `Ref: ${quote._id}`,
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tour Rider//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:booking-${quote._id}@tour-rider.com`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    fold(`SUMMARY:${icsEscape(`Tour Rider — ${who.name} (${quote.vehicle?.name || quote.tripType})`)}`),
    fold(`DESCRIPTION:${icsEscape(description)}`),
    fold(`LOCATION:${icsEscape(quote.pickupAddress)}`),
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Tour Rider pickup in 2 hours',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

module.exports = { buildItineraryPDF, buildInvoicePDF, buildCalendarInvite, contactLines, itineraryRows };
