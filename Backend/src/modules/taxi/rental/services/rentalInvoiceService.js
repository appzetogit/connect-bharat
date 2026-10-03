import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { getLandingContent } from '../../admin/services/landingContentService.js';
import { sendEmail } from '../../services/mailService.js';
import { buildRentalInvoiceLines } from './rentalInvoiceLines.js';
import { getRentalSettings, isRentalFlagOn } from './rentalSettings.js';
import { emitRentalToUser, RENTAL_SOCKET_EVENTS } from './rentalEvents.js';

/// Rental invoice (7.9).
///
/// Built on demand from the booking, so the PDF always matches the current
/// bill (a damage charge added after completion shows up on the next
/// download). Emailed once, automatically, when the booking completes - see
/// the post-save hook on RentalBookingRequest.
///
/// The look follows services/invoiceService.js (same palette, layout and
/// font fallback). That file exports no styling helpers and is being edited
/// elsewhere, so the few constants are mirrored here instead of imported.

const PAGE_MARGIN = 48;
const INK = '#191713';
const MUTED = '#6B6660';
const RULE = '#DDD9D2';
const ACCENT = '#C8901F';

const FONT_CANDIDATES = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
  ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
];

const resolveFonts = () => {
  for (const [regular, bold] of FONT_CANDIDATES) {
    try {
      if (fs.existsSync(regular) && fs.existsSync(bold)) return { regular, bold, unicode: true };
    } catch {
      // try the next candidate
    }
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', unicode: false };
};

const FONTS = resolveFonts();

const money = (amount, symbol) => {
  const value = Number(amount || 0);
  const formatted = Math.abs(value).toLocaleString('en-IN', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}${symbol}${formatted}`;
};

const formatDateTime = (date) =>
  date
    ? new Date(date).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      })
    : '-';

export { buildRentalInvoiceLines };

export const rentalInvoiceNumber = (booking) => `RINV-${String(booking.bookingReference || booking._id).replace(/^RNT-/, '')}`;

export const buildRentalInvoiceModel = async ({ bookingId }) => {
  const booking = await RentalBookingRequest.findById(bookingId).populate('userId', 'name email phone').lean();
  if (!booking) throw new Error(`Rental booking ${bookingId} not found`);

  const [settingsDoc, landing] = await Promise.all([
    AdminBusinessSetting.findOne({ scope: 'default' }).select('general customization').lean(),
    getLandingContent().catch(() => null),
  ]);
  const general = settingsDoc?.general || {};
  const customization = settingsDoc?.customization || {};
  const contact = landing?.contact || {};
  const rawSymbol = String(customization.currency_symbol || '₹').trim() || '₹';
  const symbol = FONTS.unicode ? rawSymbol : 'Rs. ';

  const lines = buildRentalInvoiceLines(booking);

  return {
    bookingId: String(booking._id),
    invoiceNumber: rentalInvoiceNumber(booking),
    invoiceDate: formatDateTime(booking.completedAt || booking.billingEndedAt || booking.updatedAt),
    status: booking.status,
    company: {
      name: String(general.app_name || 'ZI CAB').trim(),
      tagline: String(contact.tagline || 'Reliable rides, simple journeys').trim(),
      address: String(contact.address || '').trim(),
      phone: String(contact.whatsappDisplay || general.contact_phone_1 || '').trim(),
      email: String(contact.email || '').trim(),
      city: String(contact.city || 'Bengaluru').trim(),
    },
    rental: {
      bookingReference: booking.bookingReference,
      customerName: String(booking.userId?.name || booking.contactName || 'Customer').trim(),
      customerEmail: String(booking.userId?.email || booking.contactEmail || '').trim(),
      customerPhone: String(booking.userId?.phone || booking.contactPhone || '').trim(),
      vehicleName: booking.vehicleName || '',
      registrationNumber: booking.assignedUnitRegistration || '',
      driveMode: booking.driveMode === 'with_driver' ? 'With driver' : 'Self drive',
      serviceCentre: booking.commissionSnapshot?.serviceStoreName || booking.serviceLocation?.name || '',
      pickup: formatDateTime(booking.assignedAt || booking.pickupDateTime),
      return: formatDateTime(booking.billingEndedAt || booking.completedAt || booking.returnDateTime),
      startOdometer: booking.rentalInspection?.pickupMeterReading ?? null,
      endOdometer: booking.rentalInspection?.returnMeterReading ?? null,
      distanceKm: lines.metrics.distanceKm,
    },
    currencySymbol: symbol,
    currency: 'INR',
    ...lines,
  };
};

const drawLabelled = (doc, x, y, width, label, value) => {
  doc.font(FONTS.bold).fontSize(7.5).fillColor(MUTED).text(String(label).toUpperCase(), x, y, { width, characterSpacing: 0.8 });
  doc.font(FONTS.regular).fontSize(10).fillColor(INK).text(value === null || value === undefined || value === '' ? '-' : String(value), x, y + 13, { width });
};

export const renderRentalInvoicePdf = (model) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = PAGE_MARGIN;
    const right = doc.page.width - PAGE_MARGIN;
    const width = right - left;
    const symbol = model.currencySymbol;
    let y = PAGE_MARGIN;

    const ensureSpace = (needed) => {
      if (y + needed > doc.page.height - PAGE_MARGIN - 40) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
    };

    doc.font(FONTS.bold).fontSize(20).fillColor(INK).text('RENTAL INVOICE', left, y, { characterSpacing: 1 });
    doc.font(FONTS.regular).fontSize(10).fillColor(MUTED).text(`${model.invoiceNumber}\n${model.invoiceDate}`, left, y, { width, align: 'right' });
    y += 36;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(2).strokeColor(INK).stroke();

    y += 16;
    doc.font(FONTS.bold).fontSize(13).fillColor(INK).text(model.company.name, left, y);
    doc.font(FONTS.regular).fontSize(9.5).fillColor(ACCENT).text(model.company.tagline, left, y + 17);
    y += 40;
    const half = (width - 24) / 2;
    if (model.company.address) drawLabelled(doc, left, y, half, 'Office Address', model.company.address);
    if (model.company.phone) drawLabelled(doc, left + half + 24, y, half, 'Phone', model.company.phone);
    y += 48;

    const sectionHeading = (text) => {
      ensureSpace(40);
      doc.font(FONTS.bold).fontSize(8.5).fillColor(MUTED).text(text.toUpperCase(), left, y, { characterSpacing: 1.2 });
      y += 14;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(RULE).stroke();
      y += 12;
    };

    sectionHeading('Rental Details');
    const third = (width - 32) / 3;
    const col = (index) => left + (third + 16) * index;
    const r = model.rental;
    drawLabelled(doc, col(0), y, third, 'Customer', r.customerName);
    drawLabelled(doc, col(1), y, third, 'Booking', r.bookingReference);
    drawLabelled(doc, col(2), y, third, 'Drive Mode', r.driveMode);
    y += 40;
    drawLabelled(doc, col(0), y, third, 'Vehicle', r.vehicleName);
    drawLabelled(doc, col(1), y, third, 'Registration', r.registrationNumber);
    drawLabelled(doc, col(2), y, third, 'Service Centre', r.serviceCentre);
    y += 40;
    drawLabelled(doc, col(0), y, third, 'Start', r.pickup);
    drawLabelled(doc, col(1), y, third, 'End', r.return);
    drawLabelled(doc, col(2), y, third, 'Distance', r.distanceKm === null ? '-' : `${r.distanceKm} km (${r.startOdometer} - ${r.endOdometer})`);
    y += 48;

    sectionHeading('Charges');
    const amountX = right - 130;
    const row = (label, amount, { bold = false, detail = '' } = {}) => {
      ensureSpace(detail ? 34 : 22);
      doc.font(bold ? FONTS.bold : FONTS.regular).fontSize(10.5).fillColor(INK).text(label, left, y, { width: amountX - left - 8 });
      doc.text(money(amount, symbol), amountX, y, { width: 130, align: 'right' });
      y += 16;
      if (detail) {
        doc.font(FONTS.regular).fontSize(8.5).fillColor(MUTED).text(detail, left, y, { width: amountX - left - 8 });
        y += 12;
      }
      y += 4;
    };
    const rule = () => {
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(RULE).stroke();
      y += 8;
    };

    for (const line of model.charges) row(line.label, line.amount, { detail: line.detail });
    rule();
    row('Subtotal', model.subtotal, { bold: true });
    if (model.tax.amount > 0) row(`Tax (${model.tax.percentage}%)`, model.tax.amount);
    row('Total', model.total, { bold: true });
    for (const credit of model.credits) row(`Less: ${credit.label}`, -credit.amount);
    if (model.deposit?.deductedForCharges > 0) row('Less: Taken from security deposit', -model.deposit.deductedForCharges);

    if (model.deposit) {
      y += 6;
      sectionHeading('Security Deposit');
      row('Deposit', model.deposit.amount, { detail: `Status: ${model.deposit.status}` });
      if (model.deposit.deductedForCharges > 0) row('Deducted for charges', -model.deposit.deductedForCharges);
      if (model.deposit.held > 0) row('Currently held', model.deposit.held);
      if (model.deposit.released > 0) row('Released to you', model.deposit.released);
    }

    ensureSpace(80);
    y += 8;
    doc.rect(left, y, width, 46).fillColor(INK).fill();
    doc.font(FONTS.bold).fontSize(9).fillColor('#FFFFFF').text('BALANCE DUE', left + 18, y + 17, { characterSpacing: 1.2 });
    doc.font(FONTS.bold).fontSize(16).fillColor('#FFFFFF').text(money(model.balance, symbol), left, y + 13, { width: width - 18, align: 'right' });
    y += 70;

    doc.font(FONTS.bold).fontSize(10.5).fillColor(INK).text(`Thank you for renting with ${model.company.name}.`, left, y, { width, align: 'center' });

    const footerY = doc.page.height - PAGE_MARGIN - 28;
    doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.75).strokeColor(RULE).stroke();
    doc.font(FONTS.bold).fontSize(9).fillColor(INK).text(model.company.name, left, footerY + 10);
    doc.font(FONTS.regular).fontSize(9).fillColor(MUTED).text(model.company.city, left, footerY + 10, { width, align: 'right' });

    doc.end();
  });

export const buildRentalInvoicePdf = async ({ bookingId }) => {
  const model = await buildRentalInvoiceModel({ bookingId });
  const buffer = await renderRentalInvoicePdf(model);
  return { buffer, model, filename: `${model.invoiceNumber}.pdf` };
};

/// Emails the invoice. Never throws (the completion that triggered it must
/// not fail on SMTP); the outcome is stored on the booking.
export const sendRentalInvoiceEmail = async ({ bookingId }) => {
  try {
    const { buffer, model, filename } = await buildRentalInvoicePdf({ bookingId });
    const to = model.rental.customerEmail;
    const stamp = { 'invoice.invoiceNumber': model.invoiceNumber, 'invoice.generatedAt': new Date() };

    if (!to) {
      await RentalBookingRequest.updateOne({ _id: bookingId }, { $set: { ...stamp, 'invoice.emailStatus': 'no-customer-email' } });
      return { sent: false, reason: 'no-customer-email' };
    }

    const balance = money(model.balance, model.currencySymbol);
    const total = money(model.total, model.currencySymbol);
    const result = await sendEmail({
      to,
      subject: `Your ${model.company.name} rental invoice ${model.invoiceNumber}`,
      text: [
        `Hi ${model.rental.customerName},`,
        '',
        `Thank you for renting with ${model.company.name}. Your invoice for booking ${model.rental.bookingReference} is attached.`,
        '',
        `Vehicle: ${model.rental.vehicleName}`,
        `Total:   ${total}`,
        `Balance: ${balance}`,
        '',
        model.company.name,
      ].join('\n'),
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#191713;line-height:1.6">
          <p>Hi ${model.rental.customerName},</p>
          <p>Thank you for renting with <strong>${model.company.name}</strong>.
             Your invoice for booking ${model.rental.bookingReference} is attached as a PDF.</p>
          <table style="border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:4px 16px 4px 0;color:#6B6660">Vehicle</td><td>${model.rental.vehicleName}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#6B6660">Total</td><td>${total}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#6B6660">Balance</td><td><strong>${balance}</strong></td></tr>
          </table>
          <p><strong>${model.company.name}</strong></p>
        </div>`,
      attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
    });

    if (result?.skipped) {
      await RentalBookingRequest.updateOne({ _id: bookingId }, { $set: { ...stamp, 'invoice.emailStatus': result.reason || 'skipped' } });
      return { sent: false, reason: result.reason };
    }

    await RentalBookingRequest.updateOne(
      { _id: bookingId },
      { $set: { ...stamp, 'invoice.emailedAt': new Date(), 'invoice.emailStatus': 'sent' } },
    );
    return { sent: true, to, filename };
  } catch (error) {
    console.error('[rental-invoice] failed to send rental invoice:', error.message);
    return { sent: false, reason: 'error', message: error.message };
  }
};

/// Called from the booking's post-save hook when it becomes `completed`.
/// Uses updateOne (not save) for its own writes so it cannot re-trigger the
/// hook.
export const sendRentalInvoiceOnCompletion = async ({ bookingId }) => {
  const booking = await RentalBookingRequest.findById(bookingId).select('userId bookingReference invoice status').lean();
  if (!booking || booking.status !== 'completed' || booking.invoice?.emailedAt) return { sent: false, reason: 'not-applicable' };

  const settings = await getRentalSettings();
  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.invoiceReady, {
    bookingId: String(booking._id),
    bookingReference: booking.bookingReference,
    invoiceNumber: rentalInvoiceNumber(booking),
  });

  if (!isRentalFlagOn(settings, 'email_invoice_on_completion')) {
    await RentalBookingRequest.updateOne(
      { _id: bookingId },
      { $set: { 'invoice.invoiceNumber': rentalInvoiceNumber(booking), 'invoice.generatedAt': new Date(), 'invoice.emailStatus': 'disabled' } },
    );
    return { sent: false, reason: 'disabled' };
  }

  const result = await sendRentalInvoiceEmail({ bookingId });
  if (!result.sent && !['no-customer-email', 'smtp-not-configured'].includes(result.reason)) {
    console.warn('[rental-invoice] not sent for booking', String(bookingId), '-', result.reason);
  }
  return result;
};
