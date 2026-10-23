const nodemailer = require('nodemailer');
const { buildItineraryPDF, buildInvoicePDF, buildCalendarInvite } = require('./itinerary.js');
const {
  methodLabel, processingFeeRate, balancePlan, ALL_METHODS, PAYPAL_METHODS,
} = require('../helpers/paymentMethods.js');
const { quoteDepositRate } = require('../helpers/tokens.js');
const { round2 } = require('../helpers/pricing.js');
const { isConfigured: paypalConfigured } = require('../config/paypal.js');
const { wantsLabel } = require('./fleetService.js');
const { stopRows } = require('../helpers/stops.js');

// USE_RESEND=true sends everything through Resend and leaves SMTP idle; anything else keeps SMTP
const useResend = () => String(process.env.USE_RESEND || '').trim().toLowerCase() === 'true';

// SMTP_HOST set = generic SMTP provider; otherwise fall back to Gmail
// many hosts block outbound SMTP ports — fail fast rather than hanging a request
const timeouts = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 };

const transporter = nodemailer.createTransport(
  process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: String(process.env.SMTP_SECURE) === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        ...timeouts,
      }
    : {
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        ...timeouts,
      }
);

// surfaces a blocked SMTP port or a missing key at boot instead of on the first customer request
if (useResend()) {
  console.log(process.env.RESEND_API_KEY ? 'mail via resend' : 'RESEND_API_KEY NOT SET — emails will fail');
} else {
  transporter.verify()
    .then(() => console.log('smtp ready'))
    .catch((e) => console.error(`SMTP UNAVAILABLE: ${e.message} — emails will fail`));
}

const RESEND_ATTEMPTS = 3;

/**
 * Sends one nodemailer-shaped message through Resend's REST API. Attachments go
 * as base64; Resend works out the type from the filename, so .pdf and .ics need
 * nothing more. A per-second rate limit is waited out; a used-up quota is not.
 */
async function sendViaResend({ from, to, bcc, subject, text, html, attachments = [] }) {
  const body = JSON.stringify({
    from,
    to,
    subject,
    html,
    text,
    ...(bcc && bcc.length ? { bcc } : {}),
    ...(attachments.length ? {
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content).toString('base64'),
      })),
    } : {}),
  });

  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;

    const throttled = res.status === 429 && data.name === 'rate_limit_exceeded';
    if (!throttled || attempt >= RESEND_ATTEMPTS) {
      throw new Error(`Resend: ${data.message || data.name || `HTTP ${res.status}`}`);
    }
    const wait = Number(res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, (Number.isFinite(wait) && wait > 0 ? wait : 1) * 1000));
  }
}

// every email goes through here, so switching provider is one setting
const sendMail = (message) => (useResend() ? sendViaResend(message) : transporter.sendMail(message));

// methodLabel reads naturally mid-sentence; a table cell wants it capitalised
const methodName = (m) => {
  const label = methodLabel(m);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const FROM = () => process.env.MAIL_FROM || 'Tour Rider <booking@tour-rider.com>';
const money = (n) => `$${Number(n).toFixed(2)}`;
const site = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// ADMIN_EMAIL takes one address or a comma-separated list
const adminRecipients = () => (process.env.ADMIN_EMAIL || '')
  .split(',').map((a) => a.trim()).filter(Boolean);

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BRAND = {
  ink: '#0a0a0a',
  gold: '#f5a623',
  page: '#f4f4f5',
  card: '#ffffff',
  text: '#1f2937',
  muted: '#6b7280',
  line: '#e5e7eb',
  good: '#0f8a4d',
  bad: '#b42318',
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// absolute and publicly reachable — email clients can't resolve relative paths
const LOGO = 'https://tour-rider.com/wp-content/uploads/2024/09/logo_tour_ride-removebg-preview-1-3-300x175.png';

// On phones the side padding is handed to the content. Clients without media
// query support simply keep the desktop spacing.
const MOBILE_CSS = `
  @media only screen and (max-width: 600px) {
    .tr-page { padding: 12px 4px !important; }
    .tr-head { padding: 16px 16px !important; }
    .tr-body { padding: 24px 16px !important; }
    .tr-foot { padding: 18px 16px !important; }
    .tr-cell { padding-left: 12px !important; padding-right: 12px !important; }
  }`;

// Tables rather than divs throughout — Outlook ignores modern layout CSS.
const shell = ({ heading, accent = BRAND.gold, body, preheader = '' }) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(heading)}</title>
<style>${MOBILE_CSS}</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="tr-page" style="background:${BRAND.page};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;max-width:600px;background:${BRAND.card};border-radius:12px;overflow:hidden;
                  box-shadow:0 1px 3px rgba(0,0,0,.08);font-family:${FONT};">

      <tr><td class="tr-head" style="background:${BRAND.ink};padding:18px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td>
            <a href="https://tour-rider.com" style="text-decoration:none;">
              <img src="${LOGO}" alt="Tour Rider" width="140" height="82" border="0"
                   style="display:block;width:140px;height:82px;border:0;outline:none;
                          text-decoration:none;font-family:${FONT};font-size:17px;font-weight:700;
                          letter-spacing:.12em;text-transform:uppercase;color:${BRAND.gold};">
            </a>
          </td>
          <td align="right" style="font-size:11px;letter-spacing:.1em;color:#9ca3af;
                     text-transform:uppercase;font-family:${FONT};">Luxury Transport</td>
        </tr></table>
      </td></tr>

      <tr><td style="height:4px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>

      <tr><td class="tr-body" style="padding:32px;">
        <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:${BRAND.text};
                   font-weight:700;font-family:${FONT};">${esc(heading)}</h1>
        ${body}
      </td></tr>

      <tr><td class="tr-foot" style="background:#fafafa;border-top:1px solid ${BRAND.line};padding:22px 32px;">
        <p style="margin:0 0 6px;font-size:12px;color:${BRAND.muted};font-family:${FONT};">
          <a href="mailto:booking@tour-rider.com" style="color:${BRAND.muted};">booking@tour-rider.com</a>
          &nbsp;&middot;&nbsp;
          <a href="tel:+19178222713" style="color:${BRAND.muted};">917-822-2713</a>
        </p>
        <p style="margin:0;font-size:11px;color:#9ca3af;font-family:${FONT};">
          Serving New York, New Jersey &amp; Miami
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

const para = (html) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${BRAND.text};font-family:${FONT};">${html}</p>`;

// the headline number — quote total, amount charged, etc.
const amountPanel = (label, value, note = '') => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#fffaf0;border:1px solid rgba(245,166,35,.45);border-radius:10px;margin:0 0 22px;">
  <tr><td align="center" class="tr-cell" style="padding:20px 16px;font-family:${FONT};">
    <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${BRAND.muted};">${esc(label)}</div>
    <div style="font-size:32px;font-weight:700;color:${BRAND.ink};padding-top:4px;">${esc(value)}</div>
    ${note ? `<div style="font-size:12px;color:${BRAND.muted};padding-top:6px;">${esc(note)}</div>` : ''}
  </td></tr>
</table>`;

const detailRows = (rows) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border:1px solid ${BRAND.line};border-radius:10px;margin:0 0 22px;">
  ${rows.filter(Boolean).map(([k, v], i) => `
  <tr>
    <td class="tr-cell" style="padding:11px 16px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;
               color:${BRAND.muted};font-family:${FONT};white-space:nowrap;
               ${i ? `border-top:1px solid ${BRAND.line};` : ''}">${esc(k)}</td>
    <td align="right" class="tr-cell" style="padding:11px 16px;font-size:14px;color:${BRAND.text};font-weight:600;
               font-family:${FONT};${i ? `border-top:1px solid ${BRAND.line};` : ''}">${esc(v)}</td>
  </tr>`).join('')}
</table>`;

// bulletproof CTA — a table, not an <a> with padding, so Outlook renders the fill
const button = (url, label) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:6px auto 18px;">
  <tr><td align="center" bgcolor="${BRAND.gold}" style="border-radius:8px;">
    <a href="${url}" style="display:inline-block;padding:15px 38px;font-family:${FONT};font-size:16px;
       font-weight:700;color:#101010;text-decoration:none;border-radius:8px;">${esc(label)}</a>
  </td></tr>
</table>`;

// itemised charges — only rendered when the quote actually has extras
const invoiceTable = (q) => {
  const lines = q.lineItems || [];
  if (!lines.length) return '';

  const row = (label, value, opts = {}) => `
  <tr>
    <td class="tr-cell" style="padding:10px 16px;font-size:13px;color:${opts.strong ? BRAND.text : BRAND.muted};
               font-family:${FONT};${opts.top ? `border-top:1px solid ${BRAND.line};` : ''}
               ${opts.strong ? 'font-weight:700;' : ''}">${esc(label)}</td>
    <td align="right" class="tr-cell" style="padding:10px 16px;font-size:${opts.strong ? '16px' : '14px'};
               color:${BRAND.text};font-weight:${opts.strong ? '700' : '600'};font-family:${FONT};
               ${opts.top ? `border-top:1px solid ${BRAND.line};` : ''}">${esc(value)}</td>
  </tr>`;

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border:1px solid ${BRAND.line};border-radius:10px;margin:0 0 22px;">
  ${row('Base fare', money(q.baseFare))}
  ${lines.map((l) => row(l.label, money(l.amount), { top: true })).join('')}
  ${row('Total', money(q.quotedAmount), { top: true, strong: true })}
</table>`;
};

// what the customer quotes back to us; older bookings may only have the database id
const refOf = (q) => q.reservationNumber || String(q._id);
const refRow = (q) => (q.reservationNumber ? null : ['Reference', String(q._id)]);

// an open request has no vehicle row until the admin picks one
const tripRows = (q) => [
  q.reservationNumber ? ['Reservation', q.reservationNumber] : null,
  q.vehicle ? ['Vehicle', q.vehicle.name || q.vehicle.type || 'Selected vehicle'] : null,
  ['Date', `${q.date} at ${q.pickupTime}`],
  ['Pick-up', q.pickupAddress],
  ...stopRows(q),
  ['Drop-off', q.dropoffAddress],
  ['Passengers', q.passengers],
];

// the customer's free-text note, set apart from the trip details
const messageBlock = (message) => (message
  ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="background:#fafafa;border-left:3px solid ${BRAND.gold};border-radius:6px;margin:0 0 20px;">
       <tr><td class="tr-cell" style="padding:14px 16px;font-size:14px;line-height:1.6;color:${BRAND.text};font-family:${FONT};">
         <span style="display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
                      color:${BRAND.muted};padding-bottom:5px;">Message</span>${esc(message)}
       </td></tr></table>`
  : '');

async function sendAdminNewRequest(quote) {
  const to = adminRecipients();
  if (!to.length) return console.warn('ADMIN_EMAIL not set; skipping admin notification');

  const c = quote.customer;
  await sendMail({
    from: FROM(),
    to,
    subject: `New quote request — ${c.name}`,
    text: `New quote request from ${c.name} (${c.email}${c.phone ? `, ${c.phone}` : ''})\n`
      + `${quote.vehicle?.name || ''} · ${quote.date} ${quote.pickupTime}\n`
      + `${quote.pickupAddress} -> ${quote.dropoffAddress} · ${quote.passengers} passengers\n`
      + `Review it on the admin dashboard to accept with a price or decline.`,
    html: shell({
      heading: 'New quote request',
      preheader: `${c.name} — ${quote.vehicle?.name || 'vehicle'} on ${quote.date}`,
      body:
        para(`<strong>${esc(c.name)}</strong> has requested a quote.`)
        + detailRows([
          ['Email', c.email],
          c.phone ? ['Phone', c.phone] : null,
          ...tripRows(quote),
          ['Trip type', quote.tripType],
        ])
        + messageBlock(quote.message)
        + (site() ? button(`${site()}/admin.html`, 'Open the dashboard') : '')
        + para(`<span style="font-size:13px;color:${BRAND.muted};">Accept it with a price, or decline with a reason — the customer is emailed either way.</span>`),
    }),
  });
}

// the email lists the best fits; the dashboard holds the rest
const EMAIL_MATCH_LIMIT = 10;

// headline and secondary price for one matched vehicle; hourly rates when the route could not be priced
function matchPrices(m) {
  const total = (label) => (m.candidates || []).find((c) => c.label === label)?.total;
  const retail = total('Retail');
  const affiliate = total('Affiliate');
  if (retail || affiliate) {
    return {
      main: retail ? money(retail) : 'No retail rate',
      sub: affiliate ? `Affiliate ${money(affiliate)}` : '',
    };
  }
  return {
    main: m.rates?.retail ? `${money(m.rates.retail)}/h` : 'No rate in sheet',
    sub: m.rates?.affiliate ? `Affiliate ${money(m.rates.affiliate)}/h` : '',
  };
}

// many vehicles share a make and model, so the S/N is what tells them apart
const matchMeta = (m) => [m.type, m.capacity ? `${m.capacity} passengers` : '', `S/N ${m.sn}`].filter(Boolean).join(' · ');

const matchTable = (vehicles) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border:1px solid ${BRAND.line};border-radius:10px;margin:0 0 22px;">
  ${vehicles.slice(0, EMAIL_MATCH_LIMIT).map((m, i) => {
    const p = matchPrices(m);
    const top = i ? `border-top:1px solid ${BRAND.line};` : '';
    return `
  <tr>
    <td class="tr-cell" style="padding:11px 16px;font-family:${FONT};${top}">
      <div style="font-size:14px;font-weight:600;color:${BRAND.text};">${esc(m.name)}</div>
      <div style="font-size:12px;color:${BRAND.muted};padding-top:2px;">${esc(matchMeta(m))}</div>
    </td>
    <td align="right" class="tr-cell" style="padding:11px 16px;font-family:${FONT};white-space:nowrap;${top}">
      <div style="font-size:14px;font-weight:700;color:${BRAND.text};">${esc(p.main)}</div>
      ${p.sub ? `<div style="font-size:12px;color:${BRAND.muted};padding-top:2px;">${esc(p.sub)}</div>` : ''}
    </td>
  </tr>`;
  }).join('')}
</table>`
  + (vehicles.length > EMAIL_MATCH_LIMIT
    ? para(`<span style="font-size:13px;color:${BRAND.muted};">…and ${vehicles.length - EMAIL_MATCH_LIMIT} more in the dashboard.</span>`)
    : '');

async function sendAdminOpenRequest(quote) {
  const to = adminRecipients();
  if (!to.length) return console.warn('ADMIN_EMAIL not set; skipping admin notification');

  const c = quote.customer;
  const wants = wantsLabel(quote.wants);
  const { vehicles = [], error, route } = quote.matching || {};
  const minimumNote = route?.minimumNote || '';
  const summary = vehicles.length
    ? `${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'} fit this trip, smallest first. Prices are full trip totals before any edits.`
    : error ? 'The fleet could not be checked automatically.' : 'No vehicles in the fleet fit this trip.';

  await sendMail({
    from: FROM(),
    to,
    subject: `New Open Quote Request — ${c.name}`,
    text: `New Open Quote Request from ${c.name} (${c.email}${c.phone ? `, ${c.phone}` : ''})\n`
      + `${wants} · ${quote.date} ${quote.pickupTime}\n`
      + `${quote.pickupAddress} -> ${quote.dropoffAddress} · ${quote.passengers} passengers\n\n`
      + (error ? `${error}\n` : '')
      + `${summary}\n`
      + (minimumNote ? `${minimumNote}\n` : '')
      + vehicles.slice(0, EMAIL_MATCH_LIMIT).map((m) => {
        const p = matchPrices(m);
        return `- ${m.name} (${matchMeta(m)}): ${p.main}${p.sub ? `, ${p.sub}` : ''}`;
      }).join('\n')
      + `\n\nPick a vehicle on the admin dashboard to send it to the customer, or decline.`,
    html: shell({
      heading: 'New Open Quote Request',
      preheader: `${c.name} — ${wants} on ${quote.date}`,
      body:
        para(`<strong>${esc(c.name)}</strong> wants a quote and has left the vehicle to us.`)
        + detailRows([
          ['Email', c.email],
          c.phone ? ['Phone', c.phone] : null,
          ['Wants', wants],
          ...tripRows(quote),
          ['Trip type', quote.tripType],
        ])
        + messageBlock(quote.message)
        + (error ? para(`<span style="color:${BRAND.bad};">${esc(error)}</span>`) : '')
        + para(esc(summary))
        + (minimumNote && vehicles.length ? para(`<span style="font-size:13px;color:${BRAND.muted};">${esc(minimumNote)}</span>`) : '')
        + (vehicles.length ? matchTable(vehicles) : '')
        + (site() ? button(`${site()}/admin.html`, 'Pick a vehicle') : '')
        + para(`<span style="font-size:13px;color:${BRAND.muted};">Pick one, adjust the price if needed, and send it. The customer gets the vehicle, the price and a payment link.</span>`),
    }),
  });
}

// the offered vehicle, photo first, because an open request never saw it on the site
const vehicleCard = (v = {}) => {
  const meta = [v.type, v.capacity ? `Seats up to ${v.capacity}` : ''].filter(Boolean).join(' · ');
  const photo = /^https?:\/\//i.test(v.pic || '') ? v.pic : '';
  const more = site() && v.sn ? `${site()}/vehicle.html?sn=${encodeURIComponent(v.sn)}` : '';
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border:1px solid ${BRAND.line};border-radius:10px;margin:0 0 22px;overflow:hidden;">
  ${photo ? `<tr><td style="font-size:0;line-height:0;"><img src="${esc(photo)}" alt="${esc(v.name)}" width="536"
       style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px 10px 0 0;"></td></tr>` : ''}
  <tr><td class="tr-cell" style="padding:14px 16px;font-family:${FONT};">
    <div style="font-size:16px;font-weight:700;color:${BRAND.text};">${esc(v.name || 'Your vehicle')}</div>
    ${meta ? `<div style="font-size:13px;color:${BRAND.muted};padding-top:3px;">${esc(meta)}</div>` : ''}
    ${more ? `<div style="font-size:13px;padding-top:8px;"><a href="${esc(more)}" style="color:${BRAND.gold};font-weight:600;">See more photos</a></div>` : ''}
  </td></tr>
</table>`;
};

const pct = (rate) => `${(rate * 100).toFixed(rate * 100 % 1 ? 2 : 0)}%`;

// Methods grouped by the fee they attract, highest first. Read from the same
// settings the payment page charges by, so the email never disagrees with it.
function feeTiers() {
  const tiers = new Map();
  ALL_METHODS
    .filter((m) => paypalConfigured() || !PAYPAL_METHODS.includes(m))
    .forEach((m) => {
      const rate = processingFeeRate(m);
      tiers.set(rate, [...(tiers.get(rate) || []), methodName(m)]);
    });
  return [...tiers]
    .sort(([a], [b]) => b - a)
    .map(([rate, names]) => ({
      names: names.join(', '),
      fee: rate ? `+${pct(rate)} fee` : 'No fee',
    }));
}

const paymentMethodsText = () => 'Ways to pay (any fee is added at checkout):\n'
  + feeTiers().map((t) => `- ${t.names}: ${t.fee}`).join('\n');

// what each method adds, so the surcharge is no surprise at checkout
const paymentMethods = ({ cashFullOnly = false } = {}) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border:1px solid ${BRAND.line};border-radius:10px;margin:0 0 10px;">
  <tr><td colspan="2" class="tr-cell" style="padding:12px 16px 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
                             color:${BRAND.muted};font-family:${FONT};">Ways to pay</td></tr>
  ${feeTiers().map((t) => `
  <tr>
    <td class="tr-cell" style="padding:10px 16px;font-size:14px;color:${BRAND.text};font-family:${FONT};
               border-top:1px solid ${BRAND.line};">${esc(t.names)}</td>
    <td align="right" class="tr-cell" style="padding:10px 16px;font-size:13px;font-weight:700;font-family:${FONT};white-space:nowrap;
               color:${t.fee === 'No fee' ? BRAND.good : BRAND.text};border-top:1px solid ${BRAND.line};">${esc(t.fee)}</td>
  </tr>`).join('')}
</table>`
  + para(`<span style="font-size:12px;color:${BRAND.muted};">Any processing fee is added at checkout for the method you choose. `
    + `${paypalConfigured() ? 'Apple Pay, Google Pay and Venmo' : 'Apple Pay and Google Pay'} available on supported devices.`
    + `${cashFullOnly ? ' Cash is accepted for full payment only.' : ''}</span>`);

async function sendQuoteAccepted(quote, paymentUrl, depositAmount) {
  const ttl = process.env.QUOTE_LINK_TTL_DAYS || 7;
  // an open request is answered with the vehicle we picked for it
  const offer = quote.kind === 'open';
  const vehicleName = quote.vehicle?.name || 'A vehicle';
  const depositPct = pct(quoteDepositRate(quote));
  await sendMail({
    from: FROM(),
    to: [quote.customer.email],
    subject: offer ? 'A vehicle is available for your trip' : 'Your Tour Rider quote is ready',
    text: `Hello ${quote.customer.name},\n\n`
      + (offer
        ? `Good news: the ${vehicleName} is available for your trip on ${quote.date}, at ${money(quote.quotedAmount)}.\n`
        : `We can cover this trip for ${money(quote.quotedAmount)}.\n`)
      + (depositAmount
        ? `Pay in full today or secure your booking with a ${depositPct} deposit of ${money(depositAmount)}.\n\n`
          + `Pay your ${depositPct} deposit by card today. The remaining balance, plus the processing fee, `
          + 'will be automatically charged to the same card on arrival of the vehicle.\n\n'
        : 'Payment in full confirms your booking.\n\n')
      + `${paymentMethodsText()}\n\n`
      + `Complete your booking: ${paymentUrl}\n\nThis link is personal to you and expires in ${ttl} days.`,
    html: shell({
      heading: offer ? 'A vehicle is available' : 'Your quote is ready',
      preheader: offer
        ? `${vehicleName} for ${money(quote.quotedAmount)} on ${quote.date}`
        : `${money(quote.quotedAmount)} for your trip on ${quote.date}`,
      body:
        para(`Hello ${esc(quote.customer.name)},`)
        + (offer
          ? para("Good news: we found a vehicle for your trip. If you'd like to go ahead at this price, complete your booking below.")
            + vehicleCard(quote.vehicle)
          : para('Thanks for your request — we can cover this trip.'))
        + amountPanel('Total quote', money(quote.quotedAmount))
        + invoiceTable(quote)
        + detailRows(tripRows(quote))
        + (depositAmount
          ? para(`Pay in full today or secure your booking with a <strong>${depositPct} deposit of ${money(depositAmount)}</strong>.`)
            + para(`Pay your ${depositPct} deposit by card today. The remaining balance, plus the processing fee, `
              + 'will be automatically charged to the same card on arrival of the vehicle.')
          : para('Payment in full confirms your booking.'))
        + paymentMethods({ cashFullOnly: !!depositAmount })
        + button(paymentUrl, 'Complete your booking')
        + para(`<span style="font-size:12px;color:${BRAND.muted};">This link is personal to you and expires in ${esc(ttl)} days. If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all;color:${BRAND.muted};">${esc(paymentUrl)}</span></span>`),
    }),
  });
}

async function sendQuoteDeclined(quote) {
  await sendMail({
    from: FROM(),
    to: [quote.customer.email],
    subject: 'About your Tour Rider request',
    text: `Hello ${quote.customer.name},\n\nUnfortunately we're unable to fulfil this request.\n`
      + (quote.declineReason ? `Reason: ${quote.declineReason}\n` : '')
      + `\nIf your plans are flexible, reply to this email and we'll do our best to find an alternative.`,
    html: shell({
      heading: "We can't take this trip",
      accent: BRAND.bad,
      preheader: 'Unfortunately we cannot fulfil this request',
      body:
        para(`Hello ${esc(quote.customer.name)},`)
        + para("Thank you for considering Tour Rider. Unfortunately we're unable to fulfil this request.")
        + (quote.declineReason
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                    style="background:#fef3f2;border-left:3px solid ${BRAND.bad};border-radius:6px;margin:0 0 22px;">
               <tr><td class="tr-cell" style="padding:14px 16px;font-size:14px;line-height:1.6;color:${BRAND.text};font-family:${FONT};">
                 <span style="display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
                              color:${BRAND.muted};padding-bottom:5px;">Reason</span>${esc(quote.declineReason)}
               </td></tr></table>`
          : '')
        + detailRows(tripRows(quote))
        + para("If your dates or vehicle are flexible, just reply to this email — we'll do our best to find an alternative.")
        + (site() ? button(`${site()}/index.html`, 'Browse the fleet') : ''),
    }),
  });
}

// Builds an attachment, never letting a failure sink the email itself.
async function attach(label, filename, contentType, build) {
  try {
    return { filename, content: await build(), contentType };
  } catch (e) {
    console.error(`${label} failed:`, e.message);
    return null;
  }
}

/** Customer copy: the invoice, with pricing. Never the itinerary. */
// only a stored card can be charged again; every other method needs a link
function balanceLine(quote, isDeposit) {
  if (!isDeposit) return 'Your trip is paid in full. Nothing further is due.';
  return balanceSentence(balancePlan(quote));
}

// when and how the balance is collected, worded the same in every customer email
function balanceSentence(plan, { html = true } = {}) {
  const b = (text) => (html ? `<strong>${text}</strong>` : text);
  if (plan.how === 'card') {
    return `The balance of ${b(money(plan.amount))}${plan.fee ? ` (including the ${pct(plan.rate)} processing fee)` : ''} `
      + `will be charged to the same card automatically on ${b('arrival of your vehicle')}. Nothing more to do.`;
  }
  if (plan.how === 'zelle') return `Balance of ${b(money(plan.amount))} is due via Zelle on ${b('arrival of the vehicle')}.`;
  return `We'll email you a payment link for the remaining ${b(money(plan.amount))} on the morning of your trip.`;
}

const balanceNote = (plan) => ({
  card: `Balance of ${money(plan.amount)} charged on arrival`,
  zelle: `Balance of ${money(plan.amount)} due via Zelle on arrival`,
  link: `${money(plan.amount)} due on the day of pickup`,
}[plan.how]);

async function sendPaymentReceipt(quote, amount, isDeposit) {
  const plan = balancePlan(quote);
  const attachments = (await Promise.all([
    attach('invoice PDF', `invoice-${quote._id}.pdf`, 'application/pdf',
      () => buildInvoicePDF(quote, amount, isDeposit)),
    attach('calendar invite', 'booking.ics', 'text/calendar; charset=utf-8; method=PUBLISH',
      async () => buildCalendarInvite(quote)),
  ])).filter(Boolean);

  await sendMail({
    from: FROM(),
    to: [quote.customer.email],
    attachments,
    // Resend rejects a message without a subject; SMTP used to send it blank
    subject: `${isDeposit ? 'Deposit' : 'Payment'} received — your Tour Rider ride is confirmed`,
    text: `Hello ${quote.customer.name},\n\nWe've received your payment of ${money(amount)} and your ride is confirmed.\n`
      + `${isDeposit ? balanceSentence(plan, { html: false }) : 'Your trip is paid in full. Nothing further is due.'}\n\n`
      + `Reservation: ${refOf(quote)}\nYour invoice and a calendar invite are attached.`,
    html: shell({
      heading: 'Payment received',
      accent: BRAND.good,
      preheader: `${money(amount)} received, your ride is confirmed`,
      body:
        para(`Hello ${esc(quote.customer.name)},`)
        + para("We've received your payment and your ride is confirmed.")
        + amountPanel(
          isDeposit ? 'Deposit paid' : 'Paid in full',
          money(amount),
          isDeposit ? balanceNote(plan) : 'Nothing further is due'
        )
        + invoiceTable(quote)
        + detailRows([
          ...tripRows(quote),
          ['Total', money(quote.quotedAmount)],
          quote.paymentMethod ? ['Paid with', methodName(quote.paymentMethod)] : null,
          isDeposit ? ['Balance remaining', money(plan.amount)] : null,
          refRow(quote),
        ])
        + para(balanceLine(quote, isDeposit))
        + para(`<span style="font-size:13px;color:${BRAND.muted};">We'll be in touch before pickup with your driver's details.</span>`),
    }),
  });

  // the admin copy carries the pricing-free itinerary as well, so it can be
  // handed to a driver without exposing what the customer paid
  await sendAdminBookingConfirmed(quote, amount, isDeposit);
}

/** Admin copy: itinerary for the driver, invoice for the records. */
async function sendAdminBookingConfirmed(quote, amount, isDeposit) {
  const to = adminRecipients();
  if (!to.length) return console.warn('ADMIN_EMAIL not set; skipping booking notification');

  const attachments = (await Promise.all([
    attach('itinerary PDF', `itinerary-${quote._id}.pdf`, 'application/pdf',
      () => buildItineraryPDF(quote)),
    attach('invoice PDF', `invoice-${quote._id}.pdf`, 'application/pdf',
      () => buildInvoicePDF(quote, amount, isDeposit)),
    attach('calendar invite', 'booking.ics', 'text/calendar; charset=utf-8; method=PUBLISH',
      async () => buildCalendarInvite(quote)),
  ])).filter(Boolean);

  const c = quote.customer;
  await sendMail({
    from: FROM(),
    to,
    attachments,
    subject: `Booking confirmed — ${c.name}`,
    text: `${c.name} has paid ${money(amount)}${isDeposit ? ` (deposit, ${money(quote.remainingBalance)} due on pickup day)` : ' in full'}.\n`
      + `Contact: ${c.phone ? `${c.phone} / ` : ''}${c.email}\n`
      + `Pickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `Attached: Itinerary with no pricing, customer's invoice and a calendar invite.`,
    html: shell({
      heading: 'Booking confirmed',
      accent: BRAND.good,
      preheader: `${c.name} paid ${money(amount)}`,
      body:
        para(`<strong>${esc(c.name)}</strong> has paid and the trip is confirmed.`)
        + amountPanel(isDeposit ? 'Deposit received' : 'Paid in full', money(amount),
          isDeposit ? `${money(quote.remainingBalance)} due on the day of pickup` : 'Nothing further is due')
        + invoiceTable(quote)
        + detailRows([
          ['Customer', c.email],
          c.phone ? ['Phone', c.phone] : null,
          ...tripRows(quote),
          refRow(quote),
        ])
        + para('<span style="font-size:13px;color:' + BRAND.muted + '">Attached: Itinerary with no pricing, customer\'s invoice and a calendar invite.</span>'),
    }),
  });
}

async function sendBalanceCharged(quote) {
  const fee = Number(quote.balanceProcessingFee) || 0;
  const charged = money(round2(Number(quote.remainingBalance) + fee));
  // a saved card is charged on arrival; anything else came in through a link or by Zelle
  const onFile = !!quote.squareCardId;
  const how = onFile ? 'charged to the card on file' : `paid by ${methodLabel(quote.balanceMethod)}`;
  // admins are bcc'd so their addresses never appear in the customer's copy
  await sendMail({
    from: FROM(),
    to: [quote.customer.email],
    bcc: adminRecipients(),
    subject: onFile ? 'Your remaining balance has been charged' : 'Your remaining balance is paid',
    text: `Hello ${quote.customer.name},\n\nYour remaining balance of ${charged} `
      + `has been ${how}.\nPickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `\nReference: ${refOf(quote)}`,
    html: shell({
      heading: onFile ? 'Balance charged' : 'Balance paid',
      accent: BRAND.good,
      preheader: `${charged} ${how}`,
      body:
        para(`Hello ${esc(quote.customer.name)},`)
        + para(`Your remaining balance has been ${esc(how)} — your trip is now paid in full.`)
        + amountPanel(onFile ? 'Balance charged' : 'Balance paid', charged,
          fee ? `Includes ${money(fee)} processing fee · paid in full` : 'Paid in full')
        + detailRows([
          ...tripRows(quote),
          ['Pickup', new Date(quote.pickupDateTime).toLocaleString()],
          refRow(quote),
        ])
        + para(`<span style="font-size:13px;color:${BRAND.muted};">Have a great trip — your driver will be in touch shortly.</span>`),
    }),
  });
}

// goes to the admin only — an uncollected balance needs a human, fast
async function sendBalanceChargeFailed(quote, reason) {
  const to = adminRecipients();
  if (!to.length) return console.warn('ADMIN_EMAIL not set; cannot alert on failed balance charge');

  const c = quote.customer;
  const attempted = money(balancePlan(quote).amount);
  await sendMail({
    from: FROM(),
    to,
    subject: `ACTION NEEDED — balance charge failed for ${c.name}`,
    text: `The remaining balance of ${attempted} for ${c.name} could not be charged.\n`
      + `Reason: ${reason}\n`
      + `Customer: ${c.email}${c.phone ? ` / ${c.phone}` : ''}\n`
      + `Pickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `Reference: ${refOf(quote)}\n\n`
      + `The card on file was NOT charged. Contact the customer or retry from the dashboard.`,
    html: shell({
      heading: 'Balance charge failed',
      accent: BRAND.bad,
      preheader: `${attempted} could not be collected from ${c.name}`,
      body:
        para(`The remaining balance for <strong>${esc(c.name)}</strong> could not be charged to the card on file.`)
        + amountPanel('Uncollected', attempted, 'The card was not charged')
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                  style="background:#fef3f2;border-left:3px solid ${BRAND.bad};border-radius:6px;margin:0 0 22px;">
             <tr><td class="tr-cell" style="padding:14px 16px;font-size:14px;line-height:1.6;color:${BRAND.text};font-family:${FONT};">
               <span style="display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
                            color:${BRAND.muted};padding-bottom:5px;">Reason given by Square</span>${esc(reason)}
             </td></tr></table>`
        + detailRows([
          ['Customer', c.email],
          c.phone ? ['Phone', c.phone] : null,
          ...tripRows(quote),
          ['Pickup', new Date(quote.pickupDateTime).toLocaleString()],
          ['Already paid', money(quote.amountPaid)],
          refRow(quote),
        ])
        + (site() ? button(`${site()}/admin.html`, 'Open the dashboard') : '')
        + para(`<span style="font-size:13px;color:${BRAND.muted};">Contact the customer for another card, or use “Charge balance now” on the dashboard once they've sorted it.</span>`),
    }),
  });
}

// A deposit taken with a wallet or PayPal leaves no card to charge, so the
// balance is asked for by link on the morning of the trip instead.
async function sendBalanceLink(quote, paymentUrl) {
  const c = quote.customer;
  const due = money(quote.remainingBalance);
  await sendMail({
    from: FROM(),
    to: [c.email],
    subject: `Balance due today for your Tour Rider trip — ${due}`,
    text: `Hello ${c.name},\n\nYour trip is today and the remaining balance of ${due} is now due.\n\n`
      + `${paymentMethodsText()}\n\n`
      + `Pay the balance: ${paymentUrl}\n\n`
      + `Paying before pickup keeps things simple for you and your driver.`,
    html: shell({
      heading: 'Your balance is due today',
      preheader: `${due} to settle before your pickup`,
      body:
        para(`Hello ${esc(c.name)},`)
        + para('Your trip is today. Because your deposit was paid with a method we cannot charge again, the balance needs settling with this link.')
        + amountPanel('Balance due', due, `Already paid ${money(quote.amountPaid)}`)
        + detailRows(tripRows(quote))
        + paymentMethods()
        + button(paymentUrl, 'Pay the balance')
        + para(`<span style="font-size:12px;color:${BRAND.muted};">This link is personal to you. If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all;color:${BRAND.muted};">${esc(paymentUrl)}</span></span>`),
    }),
  });
}

// the admin needs to know a balance is riding on the customer clicking a link
async function sendAdminBalanceLinkSent(quote) {
  const to = adminRecipients();
  if (!to.length) return;

  const c = quote.customer;
  await sendMail({
    from: FROM(),
    to,
    subject: `Balance link sent to ${c.name} — ${money(quote.remainingBalance)} outstanding`,
    text: `${c.name} paid their deposit by ${quote.paymentMethod || 'an uncharged method'}, so there is no card on file.\n`
      + `A payment link for ${money(quote.remainingBalance)} has been emailed to ${c.email}.\n`
      + `Pickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `Reference: ${refOf(quote)}\n\n`
      + `Check it has been paid before the vehicle leaves.`,
    html: shell({
      heading: 'Balance link sent',
      accent: BRAND.accent,
      preheader: `${money(quote.remainingBalance)} still to collect from ${c.name}`,
      body:
        para(`<strong>${esc(c.name)}</strong> paid the deposit by ${esc(quote.paymentMethod || 'a method that cannot be charged again')}, so no card is held on file.`)
        + amountPanel('Outstanding', money(quote.remainingBalance), 'Payment link emailed to the customer')
        + detailRows([
          ['Customer', c.email],
          c.phone ? ['Phone', c.phone] : null,
          ...tripRows(quote),
          ['Pickup', new Date(quote.pickupDateTime).toLocaleString()],
          ['Already paid', money(quote.amountPaid)],
          refRow(quote),
        ])
        + (site() ? button(`${site()}/admin.html`, 'Open the dashboard') : '')
        + para(`<span style="font-size:13px;color:${BRAND.muted};">Confirm payment before the vehicle leaves the base.</span>`),
    }),
  });
}

// Zelle and cash settle outside the app, so the customer needs telling how
// Zelle's QR only identifies who is paid, so the memo reminder sits right under it.
// Hosted with the site because most email clients will not show embedded image data.
const zelleQr = (quote, name) => (site()
  ? `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px;">
  <tr><td align="center">
    <img src="${site()}/img/pay/zelle-qr.jpg" alt="Zelle QR code for ${esc(name)}" width="320"
         style="display:block;width:320px;max-width:100%;height:auto;border:0;border-radius:10px;">
  </td></tr>
  <tr><td align="center" style="padding-top:10px;font-size:13px;color:${BRAND.muted};font-family:${FONT};">
    Or scan this code in your bank's app. Add ${quote.reservationNumber ? `<strong>${esc(quote.reservationNumber)}</strong>` : 'your name'} in the memo.
  </td></tr>
</table>`
  : '');

async function sendOfflineInstructions(quote, amount, method, isDeposit) {
  const { instructionsFor, zelleRecipient } = require('../controllers/offline.controller.js');
  const how = instructionsFor(method, quote);
  const zelle = method === 'zelle' ? zelleRecipient() : null;
  const plan = balancePlan(quote);
  const label = method === 'zelle' ? 'Zelle' : 'cash';
  const c = quote.customer;

  await sendMail({
    from: FROM(),
    to: [c.email],
    subject: `How to pay for your Tour Rider booking — ${money(amount)} by ${label}`,
    text: `Hello ${c.name},\n\nYour booking is held for you. ${money(amount)} is due by ${label}.\n\n${how}\n\n`
      + `There is no processing fee on ${label}.\n`
      + (isDeposit ? `${balanceSentence(plan, { html: false })}\n` : ''),
    html: shell({
      heading: `Pay by ${esc(label)}`,
      preheader: `${money(amount)} due by ${esc(label)} to confirm your booking`,
      body:
        para(`Hello ${esc(c.name)},`)
        + para('Your booking is held for you. Here is what is due and how to send it.')
        + amountPanel(isDeposit ? 'Deposit due' : 'Amount due', money(amount), `No processing fee on ${esc(label)}`)
        + (zelle
          ? para('<strong>Send your payment by Zelle using these details:</strong>')
            + detailRows([
              ['Send to', zelle.to],
              ['Recipient name', zelle.name],
              ['Memo', quote.reservationNumber || c.name],
            ])
            // a company name the customer has never heard of would look like a mistake
            + para(`<span style="font-size:13px;color:${BRAND.muted};">${esc(zelle.name)} is Tour Rider's parent company, `
              + 'so that is the name Zelle will show when you send. Your booking is held until the payment arrives.</span>')
            + zelleQr(quote, zelle.name)
          : para(`<strong>${esc(how)}</strong>`))
        + detailRows(tripRows(quote))
        + (isDeposit ? para(balanceSentence(plan)) : '')
        + para(`<span style="font-size:13px;color:${BRAND.muted};">We'll confirm by email as soon as the payment reaches us.</span>`),
    }),
  });
}

// the admin has to watch for money the app cannot see arrive
async function sendAdminOfflineChosen(quote, amount, method) {
  const to = adminRecipients();
  if (!to.length) return;

  const c = quote.customer;
  const label = method === 'zelle' ? 'Zelle' : 'cash';
  await sendMail({
    from: FROM(),
    to,
    subject: `${c.name} will pay ${money(amount)} by ${label}${quote.reservationNumber ? ` — ${quote.reservationNumber}` : ''}`,
    text: `${c.name} chose to pay by ${label}.\n`
      + `Expecting ${money(amount)}.\n`
      + `Customer: ${c.email}${c.phone ? ` / ${c.phone}` : ''}\n`
      + `Pickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `Reference: ${refOf(quote)}\n\n`
      + `Nothing has been charged. Mark it paid on the dashboard once the money lands.`,
    html: shell({
      heading: `Paying by ${esc(label)}`,
      accent: BRAND.accent,
      preheader: `${money(amount)} expected from ${esc(c.name)}`,
      body:
        para(`<strong>${esc(c.name)}</strong> chose to pay by ${esc(label)}. Nothing has been charged.`)
        + amountPanel('Expected', money(amount), 'Confirm on the dashboard once it arrives')
        + detailRows([
          ['Customer', c.email],
          c.phone ? ['Phone', c.phone] : null,
          ...tripRows(quote),
          ['Pickup', new Date(quote.pickupDateTime).toLocaleString()],
          refRow(quote),
        ])
        + (site() ? button(`${site()}/admin.html`, 'Open the dashboard') : ''),
    }),
  });
}

module.exports = {
  useResend,
  sendAdminNewRequest,
  sendAdminOpenRequest,
  sendAdminBookingConfirmed,
  sendBalanceChargeFailed,
  sendQuoteAccepted,
  sendQuoteDeclined,
  sendPaymentReceipt,
  sendBalanceCharged,
  sendBalanceLink,
  sendAdminBalanceLinkSent,
  sendOfflineInstructions,
  sendAdminOfflineChosen,
};
