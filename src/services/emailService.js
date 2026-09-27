const nodemailer = require('nodemailer');
const { buildItineraryPDF, buildInvoicePDF, buildCalendarInvite } = require('./itinerary.js');
const { methodLabel } = require('../helpers/paymentMethods.js');

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

// surfaces a blocked SMTP port at boot instead of on the first customer request
transporter.verify()
  .then(() => console.log('smtp ready'))
  .catch((e) => console.error(`SMTP UNAVAILABLE: ${e.message} — emails will fail`));

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

// Tables rather than divs throughout — Outlook ignores modern layout CSS.
const shell = ({ heading, accent = BRAND.gold, body, preheader = '' }) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.page};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;max-width:600px;background:${BRAND.card};border-radius:12px;overflow:hidden;
                  box-shadow:0 1px 3px rgba(0,0,0,.08);font-family:${FONT};">

      <tr><td style="background:${BRAND.ink};padding:18px 32px;">
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

      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:${BRAND.text};
                   font-weight:700;font-family:${FONT};">${esc(heading)}</h1>
        ${body}
      </td></tr>

      <tr><td style="background:#fafafa;border-top:1px solid ${BRAND.line};padding:22px 32px;">
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
  <tr><td align="center" style="padding:20px 16px;font-family:${FONT};">
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
    <td style="padding:11px 16px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;
               color:${BRAND.muted};font-family:${FONT};white-space:nowrap;
               ${i ? `border-top:1px solid ${BRAND.line};` : ''}">${esc(k)}</td>
    <td align="right" style="padding:11px 16px;font-size:14px;color:${BRAND.text};font-weight:600;
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
    <td style="padding:10px 16px;font-size:13px;color:${opts.strong ? BRAND.text : BRAND.muted};
               font-family:${FONT};${opts.top ? `border-top:1px solid ${BRAND.line};` : ''}
               ${opts.strong ? 'font-weight:700;' : ''}">${esc(label)}</td>
    <td align="right" style="padding:10px 16px;font-size:${opts.strong ? '16px' : '14px'};
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

const tripRows = (q) => [
  ['Vehicle', q.vehicle?.name || q.vehicle?.type || 'Selected vehicle'],
  ['Date', `${q.date} at ${q.pickupTime}`],
  ['Pick-up', q.pickupAddress],
  q.stopoverAddress ? ['Stop over', q.stopoverAddress] : null,
  ['Drop-off', q.dropoffAddress],
  ['Passengers', q.passengers],
];

async function sendAdminNewRequest(quote) {
  const to = adminRecipients();
  if (!to.length) return console.warn('ADMIN_EMAIL not set; skipping admin notification');

  const c = quote.customer;
  await transporter.sendMail({
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
        + (quote.message
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                    style="background:#fafafa;border-left:3px solid ${BRAND.gold};border-radius:6px;margin:0 0 20px;">
               <tr><td style="padding:14px 16px;font-size:14px;line-height:1.6;color:${BRAND.text};font-family:${FONT};">
                 <span style="display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
                              color:${BRAND.muted};padding-bottom:5px;">Message</span>${esc(quote.message)}
               </td></tr></table>`
          : '')
        + (site() ? button(`${site()}/admin.html`, 'Open the dashboard') : '')
        + para(`<span style="font-size:13px;color:${BRAND.muted};">Accept it with a price, or decline with a reason — the customer is emailed either way.</span>`),
    }),
  });
}

async function sendQuoteAccepted(quote, paymentUrl, depositAmount) {
  const ttl = process.env.QUOTE_LINK_TTL_DAYS || 7;
  await transporter.sendMail({
    from: FROM(),
    to: [quote.customer.email],
    subject: 'Your Tour Rider quote is ready',
    text: `Hello ${quote.customer.name},\n\nWe can cover this trip for ${money(quote.quotedAmount)}.\n`
      + `Pay in full, or pay a ${money(depositAmount)} deposit now with the balance charged on the day of pickup.\n\n`
      + `Complete your booking: ${paymentUrl}\n\nThis link is personal to you and expires in ${ttl} days.`,
    html: shell({
      heading: 'Your quote is ready',
      preheader: `${money(quote.quotedAmount)} for your trip on ${quote.date}`,
      body:
        para(`Hello ${esc(quote.customer.name)},`)
        + para('Thanks for your request — we can cover this trip.')
        + amountPanel('Total quote', money(quote.quotedAmount))
        + invoiceTable(quote)
        + detailRows(tripRows(quote))
        + para(`Pay in full now, or secure the booking with a <strong>${money(depositAmount)}</strong> deposit and we'll charge the balance to the same card on the day of pickup.`)
        + button(paymentUrl, 'Complete your booking')
        + para(`<span style="font-size:12px;color:${BRAND.muted};">This link is personal to you and expires in ${esc(ttl)} days. If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all;color:${BRAND.muted};">${esc(paymentUrl)}</span></span>`),
    }),
  });
}

async function sendQuoteDeclined(quote) {
  await transporter.sendMail({
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
               <tr><td style="padding:14px 16px;font-size:14px;line-height:1.6;color:${BRAND.text};font-family:${FONT};">
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
  const due = money(quote.remainingBalance);
  return quote.squareCardId
    ? `The remaining <strong>${due}</strong> will be charged automatically to the same card on the morning of your trip. Nothing more to do.`
    : `We'll email you a payment link for the remaining <strong>${due}</strong> on the morning of your trip.`;
}

async function sendPaymentReceipt(quote, amount, isDeposit) {
  const attachments = (await Promise.all([
    attach('invoice PDF', `invoice-${quote._id}.pdf`, 'application/pdf',
      () => buildInvoicePDF(quote, amount, isDeposit)),
    attach('calendar invite', 'booking.ics', 'text/calendar; charset=utf-8; method=PUBLISH',
      async () => buildCalendarInvite(quote)),
  ])).filter(Boolean);

  await transporter.sendMail({
    from: FROM(),
    to: [quote.customer.email],
    attachments,
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
          isDeposit ? `${money(quote.remainingBalance)} due on the day of pickup` : 'Nothing further is due'
        )
        + invoiceTable(quote)
        + detailRows([
          ...tripRows(quote),
          ['Total', money(quote.quotedAmount)],
          quote.paymentMethod ? ['Paid with', methodName(quote.paymentMethod)] : null,
          isDeposit ? ['Balance remaining', money(quote.remainingBalance)] : null,
          ['Reference', String(quote._id)],
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
  await transporter.sendMail({
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
          ['Reference', String(quote._id)],
        ])
        + para('<span style="font-size:13px;color:' + BRAND.muted + '">Attached: Itinerary with no pricing, customer\'s invoice and a calendar invite.</span>'),
    }),
  });
}

async function sendBalanceCharged(quote) {
  // admins are bcc'd so their addresses never appear in the customer's copy
  await transporter.sendMail({
    from: FROM(),
    to: [quote.customer.email],
    bcc: adminRecipients(),
    subject: 'Your remaining balance has been charged',
    text: `Hello ${quote.customer.name},\n\nYour remaining balance of ${money(quote.remainingBalance)} `
      + `has been charged to the card on file.\nPickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `\nReference: ${quote._id}`,
    html: shell({
      heading: 'Balance charged',
      accent: BRAND.good,
      preheader: `${money(quote.remainingBalance)} charged to your card on file`,
      body:
        para(`Hello ${esc(quote.customer.name)},`)
        + para('Your remaining balance has been charged to the card on file — your trip is now paid in full.')
        + amountPanel('Balance charged', money(quote.remainingBalance), 'Paid in full')
        + detailRows([
          ...tripRows(quote),
          ['Pickup', new Date(quote.pickupDateTime).toLocaleString()],
          ['Reference', String(quote._id)],
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
  await transporter.sendMail({
    from: FROM(),
    to,
    subject: `ACTION NEEDED — balance charge failed for ${c.name}`,
    text: `The remaining balance of ${money(quote.remainingBalance)} for ${c.name} could not be charged.\n`
      + `Reason: ${reason}\n`
      + `Customer: ${c.email}${c.phone ? ` / ${c.phone}` : ''}\n`
      + `Pickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `Reference: ${quote._id}\n\n`
      + `The card on file was NOT charged. Contact the customer or retry from the dashboard.`,
    html: shell({
      heading: 'Balance charge failed',
      accent: BRAND.bad,
      preheader: `${money(quote.remainingBalance)} could not be collected from ${c.name}`,
      body:
        para(`The remaining balance for <strong>${esc(c.name)}</strong> could not be charged to the card on file.`)
        + amountPanel('Uncollected', money(quote.remainingBalance), 'The card was not charged')
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                  style="background:#fef3f2;border-left:3px solid ${BRAND.bad};border-radius:6px;margin:0 0 22px;">
             <tr><td style="padding:14px 16px;font-size:14px;line-height:1.6;color:${BRAND.text};font-family:${FONT};">
               <span style="display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
                            color:${BRAND.muted};padding-bottom:5px;">Reason given by Square</span>${esc(reason)}
             </td></tr></table>`
        + detailRows([
          ['Customer', c.email],
          c.phone ? ['Phone', c.phone] : null,
          ...tripRows(quote),
          ['Pickup', new Date(quote.pickupDateTime).toLocaleString()],
          ['Already paid', money(quote.amountPaid)],
          ['Reference', String(quote._id)],
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
  await transporter.sendMail({
    from: FROM(),
    to: [c.email],
    subject: `Balance due today for your Tour Rider trip — ${due}`,
    text: `Hello ${c.name},\n\nYour trip is today and the remaining balance of ${due} is now due.\n\n`
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
  await transporter.sendMail({
    from: FROM(),
    to,
    subject: `Balance link sent to ${c.name} — ${money(quote.remainingBalance)} outstanding`,
    text: `${c.name} paid their deposit by ${quote.paymentMethod || 'an uncharged method'}, so there is no card on file.\n`
      + `A payment link for ${money(quote.remainingBalance)} has been emailed to ${c.email}.\n`
      + `Pickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `Reference: ${quote._id}\n\n`
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
          ['Reference', String(quote._id)],
        ])
        + (site() ? button(`${site()}/admin.html`, 'Open the dashboard') : '')
        + para(`<span style="font-size:13px;color:${BRAND.muted};">Confirm payment before the vehicle leaves the base.</span>`),
    }),
  });
}

// Zelle and cash settle outside the app, so the customer needs telling how
async function sendOfflineInstructions(quote, amount, method, isDeposit) {
  const { instructionsFor } = require('../controllers/offline.controller.js');
  const how = instructionsFor(method);
  const label = method === 'zelle' ? 'Zelle' : 'cash';
  const c = quote.customer;

  await transporter.sendMail({
    from: FROM(),
    to: [c.email],
    subject: `How to pay for your Tour Rider booking — ${money(amount)} by ${label}`,
    text: `Hello ${c.name},\n\nYour booking is held for you. ${money(amount)} is due by ${label}.\n\n${how}\n\n`
      + `There is no processing fee on ${label}.\n`
      + (isDeposit ? `The remaining ${money(quote.remainingBalance)} is due on the day of pickup.\n` : ''),
    html: shell({
      heading: `Pay by ${esc(label)}`,
      preheader: `${money(amount)} due by ${esc(label)} to confirm your booking`,
      body:
        para(`Hello ${esc(c.name)},`)
        + para('Your booking is held for you. Here is what is due and how to send it.')
        + amountPanel(isDeposit ? 'Deposit due' : 'Amount due', money(amount), `No processing fee on ${esc(label)}`)
        + para(`<strong>${esc(how)}</strong>`)
        + detailRows(tripRows(quote))
        + (isDeposit
          ? para(`The remaining <strong>${money(quote.remainingBalance)}</strong> is due on the day of pickup.`)
          : '')
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
  await transporter.sendMail({
    from: FROM(),
    to,
    subject: `${c.name} will pay ${money(amount)} by ${label}`,
    text: `${c.name} chose to pay by ${label}.\n`
      + `Expecting ${money(amount)}.\n`
      + `Customer: ${c.email}${c.phone ? ` / ${c.phone}` : ''}\n`
      + `Pickup: ${new Date(quote.pickupDateTime).toLocaleString()}\n`
      + `Reference: ${quote._id}\n\n`
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
          ['Reference', String(quote._id)],
        ])
        + (site() ? button(`${site()}/admin.html`, 'Open the dashboard') : ''),
    }),
  });
}

module.exports = {
  sendAdminNewRequest,
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
