const nodemailer = require('nodemailer');

// SMTP_HOST set = generic SMTP provider; otherwise fall back to Gmail
const transporter = nodemailer.createTransport(
  process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: String(process.env.SMTP_SECURE) === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      }
    : {
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      }
);

const FROM = () => process.env.MAIL_FROM || 'Tour Rider <booking@tour-rider.com>';
const money = (n) => `$${Number(n).toFixed(2)}`;

const shell = (body) => `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#222;max-width:600px">
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:12px;color:#888">Tour Rider &middot; This mailbox accepts replies.</p>
  </div>`;

const tripRows = (q) => `
  <p><strong>Vehicle:</strong> ${q.vehicle?.name || q.vehicle?.type || 'Selected vehicle'}</p>
  <p><strong>Date:</strong> ${q.date} at ${q.pickupTime}</p>
  <p><strong>Pick-up:</strong> ${q.pickupAddress}</p>
  ${q.stopoverAddress ? `<p><strong>Stop over:</strong> ${q.stopoverAddress}</p>` : ''}
  <p><strong>Drop-off:</strong> ${q.dropoffAddress}</p>
  <p><strong>Passengers:</strong> ${q.passengers}</p>`;

async function sendAdminNewRequest(quote) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) return console.warn('ADMIN_EMAIL not set; skipping admin notification');
  await transporter.sendMail({
    from: FROM(),
    to: [to],
    subject: `New quote request — ${quote.customer.name}`,
    html: shell(`
      <h2>New quote request</h2>
      <p><strong>From:</strong> ${quote.customer.name} (${quote.customer.email}${quote.customer.phone ? `, ${quote.customer.phone}` : ''})</p>
      ${tripRows(quote)}
      <p><strong>Trip type:</strong> ${quote.tripType}</p>
      ${quote.message ? `<p><strong>Message:</strong> ${quote.message}</p>` : ''}
      <p>Review it on the admin dashboard to accept with a price or decline.</p>`),
  });
}

async function sendQuoteAccepted(quote, paymentUrl, depositAmount) {
  await transporter.sendMail({
    from: FROM(),
    to: [quote.customer.email],
    subject: 'Your Tour Rider quote is ready',
    html: shell(`
      <h2>Your quote is ready</h2>
      <p>Hello ${quote.customer.name},</p>
      <p>Thanks for your request. We can cover this trip for <strong>${money(quote.quotedAmount)}</strong>.</p>
      ${tripRows(quote)}
      <p>You can pay in full, or pay a <strong>${money(depositAmount)}</strong> deposit now and the balance
      on the day of pickup using the same card.</p>
      <p style="margin:28px 0">
        <a href="${paymentUrl}" style="background:#c9a227;color:#101010;padding:14px 28px;
           border-radius:6px;text-decoration:none;font-weight:bold">Complete your booking</a>
      </p>
      <p style="font-size:13px;color:#666">This link is personal to you and expires in
      ${process.env.QUOTE_LINK_TTL_DAYS || 7} days.</p>`),
  });
}

async function sendQuoteDeclined(quote) {
  await transporter.sendMail({
    from: FROM(),
    to: [quote.customer.email],
    subject: 'About your Tour Rider request',
    html: shell(`
      <h2>We can't take this trip</h2>
      <p>Hello ${quote.customer.name},</p>
      <p>Thank you for considering Tour Rider. Unfortunately we're unable to fulfil this request.</p>
      ${quote.declineReason ? `<p><strong>Reason:</strong> ${quote.declineReason}</p>` : ''}
      ${tripRows(quote)}
      <p>If your plans are flexible, reply to this email and we'll do our best to find an alternative.</p>`),
  });
}

async function sendPaymentReceipt(quote, amount, isDeposit) {
  const to = [quote.customer.email];
  if (process.env.ADMIN_EMAIL) to.push(process.env.ADMIN_EMAIL);
  await transporter.sendMail({
    from: FROM(),
    to,
    subject: 'Payment received — your ride is confirmed',
    html: shell(`
      <h2>Payment received</h2>
      <p>Hello ${quote.customer.name},</p>
      <p>We've received <strong>${money(amount)}</strong> and your ride is confirmed.</p>
      ${tripRows(quote)}
      ${isDeposit
        ? `<p>The remaining <strong>${money(quote.remainingBalance)}</strong> will be charged to the same
           card on the day of pickup.</p>`
        : '<p>Your trip is paid in full. Nothing further is due.</p>'}
      <p><strong>Reference:</strong> ${quote._id}</p>`),
  });
}

async function sendBalanceCharged(quote) {
  const to = [quote.customer.email];
  if (process.env.ADMIN_EMAIL) to.push(process.env.ADMIN_EMAIL);
  await transporter.sendMail({
    from: FROM(),
    to,
    subject: 'Your remaining balance has been charged',
    html: shell(`
      <h2>Balance charged</h2>
      <p>Hello ${quote.customer.name},</p>
      <p>Your remaining balance of <strong>${money(quote.remainingBalance)}</strong> has been charged
      to the card on file.</p>
      <p><strong>Pickup:</strong> ${new Date(quote.pickupDateTime).toLocaleString()}</p>
      <p><strong>Reference:</strong> ${quote._id}</p>`),
  });
}

module.exports = {
  sendAdminNewRequest,
  sendQuoteAccepted,
  sendQuoteDeclined,
  sendPaymentReceipt,
  sendBalanceCharged,
};
