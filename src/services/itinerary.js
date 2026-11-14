// Booking itinerary — deliberately carries NO pricing. It is the sheet you hand
// a driver, so it holds the trip and how to reach the customer, nothing else.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatInZone, zonedToUtc, tripMinutes } = require('../helpers/datetime.js');
const { round2 } = require('../helpers/pricing.js');
const { balancePlan, bookingTotals } = require('../helpers/paymentMethods.js');
const { stopRows } = require('../helpers/stops.js');
const { minTripHours, vehicleTypeLabel } = require('./fleetService.js');
const { formatDuration } = require('./suggestService.js');

const METHOD_LABELS = {
  card: 'card', apple_pay: 'Apple Pay', google_pay: 'Google Pay', cash_app: 'Cash App',
  paypal: 'PayPal', venmo: 'Venmo', zelle: 'Zelle', cash: 'cash',
};

const INK = '#0a0a0a';
const GOLD = '#c9992a';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

// bundled with the backend rather than fetched, so building a PDF never depends on the network or the frontend
const LOGO_PATH = path.join(__dirname, '../assets/logo.png');
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

// the booked time, or the vehicle's minimum when the booking is shorter; unknown without a drop-off time
function tripDuration(quote) {
  if (!quote.finalDropoffTime) return null;
  const booked = tripMinutes(quote.date, quote.pickupTime, quote.finalDropoffTime);
  if (booked === null) return null;
  const minimum = minTripHours(quote.vehicle) * 60;
  return booked < minimum ? `${formatDuration(minimum)} (minimum)` : formatDuration(booked);
}

function itineraryRows(quote) {
  const duration = tripDuration(quote);
  const rows = [
    ['Vehicle type', vehicleTypeLabel(quote.vehicle)],
    ['Passengers', String(quote.passengers)],
    ['Trip type', quote.tripType],
    duration ? ['Duration', duration] : null,
    ['Pick-up', formatInZone(new Date(quote.pickupDateTime))],
    ['Pick-up address', quote.pickupAddress],
  ].filter(Boolean);
  stopRows(quote).forEach((row) => rows.push(row));
  rows.push(['Drop-off address', quote.dropoffAddress]);
  if (quote.finalDropoffTime) rows.push(['Final drop-off', `${quote.finalDropoffTime} (${quote.date})`]);
  if (quote.message) rows.push(['Customer note', quote.message]);
  // the driver needs to know whether a tip is coming, never how much
  if (quote.gratuity?.method) {
    rows.push(['Gratuity', quote.gratuity.method === 'online' ? 'Paid online' : 'Customer pays the driver in cash']);
  }
  return rows;
}

// room kept at the foot of the page for the footer
const FOOTER_SPACE = 84;

/** Where to draw a block of `height`: here, or at the top of a new page if it would run into the footer. */
function fit(doc, y, height) {
  if (y + height <= doc.page.height - FOOTER_SPACE - 14) return y;
  doc.addPage();
  return doc.page.margins.top;
}

/** Brand footer, shared by the itinerary and the invoice. */
function drawFooter(doc, left, right, note) {
  const base = doc.page.height - FOOTER_SPACE;
  // the footer sits inside the bottom margin, so the margin is lifted while it draws or pdfkit starts a new page
  const { bottom } = doc.page.margins;
  doc.page.margins.bottom = 0;
  doc.fillColor(INK).fontSize(11).font('Helvetica-Bold')
    .text('TOUR RIDER', left, base, { width: right - left, align: 'center', characterSpacing: 1.4 });
  doc.fillColor(MUTED).fontSize(8).font('Helvetica')
    .text('NYC LIMO &', left, base + 16, { width: right - left, align: 'center', characterSpacing: 1 })
    .text('PARTY BUS RENTALS', left, base + 27, { width: right - left, align: 'center', characterSpacing: 1 });
  if (note) {
    doc.fillColor('#9ca3af').fontSize(7)
      .text(note, left, base + 44, { width: right - left, align: 'center' });
  }
  doc.page.margins.bottom = bottom;
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
    .text(`Ref ${quote.reservationNumber || quote._id}`, left, 56, { width: right - left, align: 'right' });

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
      // a heading never sits alone at the foot of a page
      y = fit(doc, y, 40);
      doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
        .text(title.toUpperCase(), left, y, { characterSpacing: 1.2 });
      y += 16;
      rows.forEach(([k, v]) => {
        const text = String(v ?? '');
        const h = Math.max(doc.heightOfString(text, { width: right - left - 130 }), 12);
        y = fit(doc, y, h + 9);
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

    // wide enough for an address on one line; the label column keeps the rest
    const VALUE_W = 300;
    // pitch of a one-line row, plain and bold, so a block's height can be known before it is drawn
    const ROW = 20;
    const STRONG_ROW = 25;
    const row = (label, value, opts = {}) => {
      const height = Math.max(doc.heightOfString(String(value), { width: VALUE_W }),
        doc.heightOfString(label, { width: right - left - VALUE_W - 10 }), 12);
      y = fit(doc, y, height + (opts.strong ? STRONG_ROW : ROW) - 12);
      doc.fillColor(opts.strong ? INK : MUTED)
        .fontSize(opts.strong ? 11 : 9.5)
        .font(opts.strong ? 'Helvetica-Bold' : 'Helvetica')
        .text(label, left, y, { width: right - left - VALUE_W - 10 });
      doc.fillColor(INK).fontSize(opts.strong ? 12 : 10)
        .font(opts.strong ? 'Helvetica-Bold' : 'Helvetica')
        .text(String(value), right - VALUE_W, y - 1, { width: VALUE_W, align: 'right' });
      y += height + 7;
      doc.moveTo(left, y - 3).lineTo(right, y - 3)
        .lineWidth(opts.strong ? 1 : 0.5).strokeColor(opts.strong ? MUTED : LINE).stroke();
      y += opts.strong ? 6 : 1;
    };

    // `keep` is how much of the section must fit before it starts, so it isn't split awkwardly
    const section = (title, keep = 40) => {
      y = fit(doc, y, keep);
      doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
        .text(title.toUpperCase(), left, y, { characterSpacing: 1.2 });
      y += 16;
    };
    const note = (text, height) => {
      y = fit(doc, y, height);
      doc.fillColor(MUTED).fontSize(8.5).font('Helvetica').text(text, left, y, { width: right - left });
      y += height;
    };

    section('Trip');
    itineraryRows(quote).forEach(([k, v]) => row(k, v));
    y += 10;

    section('Charges');
    row('Base fare', money(quote.baseFare ?? quote.quotedAmount));
    (quote.lineItems || []).forEach((l) => row(l.label, money(l.amount)));
    const tip = quote.gratuity?.method ? quote.gratuity : null;
    const totals = bookingTotals(quote);
    if (totals.fee > 0) row(`Processing fee${totals.rate ? ` (${round2(totals.rate * 100)}%)` : ''}`, money(totals.fee));
    if (tip?.method === 'online') row(`Gratuity (${tip.percent}%)`, money(tip.amount));
    row('Total', money(totals.total), { strong: true });
    if (tip?.method === 'cash') row(`Gratuity (${tip.percent}%), cash to driver`, money(tip.amount));
    y += 10;

    const fee = Number(quote.processingFee || 0);
    const method = METHOD_LABELS[quote.paymentMethod] || null;
    const owes = isDeposit && quote.remainingBalance > 0;
    // a deposit whose balance has also come in: the closing invoice shows both payments and the total
    if (quote.paymentOption === 'deposit' && quote.remainingBalancePaid) {
      const balance = round2(Number(quote.remainingBalance) + (Number(quote.balanceProcessingFee) || 0));
      const total = round2(Number(quote.amountPaid) || 0);
      const by = (m) => (METHOD_LABELS[m] ? ` (${METHOD_LABELS[m]})` : '');
      section('Payment', 16 + 2 * ROW + STRONG_ROW + 22);
      row(`Deposit paid${by(quote.paymentMethod)}`, money(round2(total - balance)));
      row(`Balance paid${by(quote.balanceMethod || quote.paymentMethod)}`, money(balance));
      row('Paid in full', money(total), { strong: true });
      note('Nothing further is due.', 22);
      drawFooter(doc, left, right, 'Thank you for choosing Tour Rider.');
      doc.end();
      return;
    }
    // the payment block reads as one, so it moves to the next page whole when it can't fit
    section('Payment', 16 + (fee > 0 ? 2 * ROW : 0) + STRONG_ROW + (method ? 14 : 0) + (owes ? ROW + 22 : 22));
    // a surcharge has to be visible on the receipt, not folded into one figure
    if (fee > 0) {
      row(isDeposit ? 'Deposit' : 'Amount', money(round2(amountPaid - fee)));
      const pct = quote.processingFeeRate ? ` (${round2(quote.processingFeeRate * 100)}%)` : '';
      row(`Processing fee${pct}`, money(fee));
    }
    row(isDeposit ? 'Deposit paid' : 'Paid in full', money(amountPaid), { strong: true });
    if (method) note(`Paid by ${method}.`, 14);
    if (owes) {
      const plan = balancePlan(quote);
      row(plan.how === 'link' ? 'Balance due on pickup day' : 'Balance due on arrival', money(plan.amount));
      note({
        card: 'The balance, including the processing fee, will be charged automatically to the card on file on arrival of your vehicle.',
        zelle: 'The balance is due via Zelle on arrival of the vehicle.',
        link: 'We will email you a payment link for the balance on the morning of your trip.',
      }[plan.how], 22);
    } else {
      note('Nothing further is due.', 22);
    }

    drawFooter(doc, left, right, 'Thank you for choosing Tour Rider.');
    doc.end();
  });
}

const CHARGE_LABELS = { damage: 'Damage', cleaning: 'Cleaning', other: 'Additional charge' };

/** A charge added after the trip, on an invoice of its own. Resolves to a PDF Buffer. */
function buildChargeInvoicePDF(quote, charge) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { left, right } = drawHeader(doc, quote, 'INVOICE');
    let y = 136;

    doc.fillColor(INK).fontSize(16).font('Helvetica-Bold').text(quote.customer?.name || 'Customer', left, y);
    y += 20;
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
      .text([quote.customer?.email, quote.customer?.phone].filter(Boolean).join('  ·  '), left, y);
    y += 26;

    const row = (label, value, opts = {}) => {
      const height = Math.max(doc.heightOfString(String(value), { width: 260 }), 12);
      y = fit(doc, y, height + 16);
      doc.fillColor(opts.strong ? INK : MUTED).fontSize(opts.strong ? 11 : 9.5)
        .font(opts.strong ? 'Helvetica-Bold' : 'Helvetica')
        .text(label, left, y, { width: right - left - 270 });
      doc.fillColor(INK).fontSize(opts.strong ? 12 : 10).font(opts.strong ? 'Helvetica-Bold' : 'Helvetica')
        .text(String(value), right - 260, y - 1, { width: 260, align: 'right' });
      y += height + 8;
      doc.moveTo(left, y - 3).lineTo(right, y - 3)
        .lineWidth(opts.strong ? 1 : 0.5).strokeColor(opts.strong ? MUTED : LINE).stroke();
      y += opts.strong ? 6 : 2;
    };
    const section = (title) => {
      y = fit(doc, y, 40);
      doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text(title.toUpperCase(), left, y, { characterSpacing: 1.2 });
      y += 16;
    };

    section('Trip');
    row('Vehicle type', vehicleTypeLabel(quote.vehicle));
    row('Pick-up', formatInZone(new Date(quote.pickupDateTime)));
    row('Pick-up address', quote.pickupAddress);
    row('Drop-off address', quote.dropoffAddress);
    y += 10;

    const settled = charge.status !== 'awaiting_payment';
    const fee = Number(charge.fee) || 0;
    section('Charge added after the trip');
    row(CHARGE_LABELS[charge.kind] || 'Additional charge', charge.description);
    row('Amount', money(charge.amount));
    if (fee > 0) row(`Processing fee (${round2(Number(charge.feeRate) * 100)}%)`, money(fee));
    row(settled ? 'Total paid' : 'Amount due', money(settled ? charge.total : charge.amount), { strong: true });

    const method = METHOD_LABELS[charge.method] || null;
    y = fit(doc, y, 24);
    doc.fillColor(MUTED).fontSize(8.5).font('Helvetica').text(
      charge.status === 'charged' ? 'Charged to the card on file.'
        : settled ? `Paid${method ? ` by ${method}` : ''}.`
          : 'Due. Pay with the link in the email that came with this invoice; any processing fee depends on the method used.',
      left, y, { width: right - left },
    );

    drawFooter(doc, left, right, 'Questions about this charge? Call 917-822-2713 or reply to our email.');
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
  let end = quote.finalDropoffTime ? zonedToUtc(quote.date, quote.finalDropoffTime) : null;
  // no drop-off time (one way): end after the estimated drive, or two hours when that is unknown
  const driveMinutes = quote.suggestion?.payload?.route?.driveMinutes || quote.matching?.route?.driveMinutes;
  if (!end) end = new Date(start.getTime() + (driveMinutes || 120) * 60 * 1000);
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
    ...stopRows(quote).map(([label, address]) => `${label}: ${address}`),
    `Drop-off: ${quote.dropoffAddress}`,
    `Ref: ${quote.reservationNumber || quote._id}`,
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

module.exports = {
  buildItineraryPDF, buildInvoicePDF, buildChargeInvoicePDF, buildCalendarInvite, contactLines, itineraryRows,
};
