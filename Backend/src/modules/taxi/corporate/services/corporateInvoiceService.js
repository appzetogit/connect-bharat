import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { sendEmail } from '../../services/mailService.js';
import { resolveConfiguredGatewayCredentials } from '../../services/paymentGatewayService.js';
import { Ride } from '../../user/models/Ride.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateAdmin } from '../models/CorporateAdmin.js';
import { CorporateDepartment } from '../models/CorporateDepartment.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { CorporateCounter, CorporateInvoice } from '../models/CorporateInvoice.js';
import { renderCorporateInvoicePdf } from './corporateInvoicePdf.js';
import { chargeCorporateAccount, recordCorporatePayment, reverseCorporateCharge } from './corporateLedger.js';
import {
  buildAgingBuckets,
  buildInvoiceTotals,
  computeCorporateDiscount,
  getIstClock,
  getPreviousIstMonthRange,
  resolveGstMode,
  resolveInvoicePaymentStatus,
  round2,
} from './corporatePolicyEngine.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';

/// Consolidated monthly invoicing (SOW 8.7), payments and overdue tracking
/// (8.9).
///
/// The credit account and the invoices are deliberately independent: every
/// completed trip is charged to the account when it completes, an invoice is
/// just the statement of a period's trips, and payments are recorded against
/// an invoice and credited to the account. Voiding an invoice therefore frees
/// its trips for a new invoice without touching the outstanding.

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));
const isDuplicateKeyError = (error) => error?.code === 11000;

/// "2627" for FY 2026-27 (April to March, IST).
const financialYearCode = (date = new Date()) => {
  const { year, month } = getIstClock(date);
  const start = month >= 3 ? year : year - 1;
  return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`;
};

const nextInvoiceNumber = async (prefix, date) => {
  const fy = financialYearCode(date);
  const counter = await CorporateCounter.findOneAndUpdate(
    { _id: `invoice:${prefix}:${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return `${prefix}/${fy}/${String(counter.seq).padStart(5, '0')}`;
};

const loadSupplier = async (settings) => {
  const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('general').lean().catch(() => null);
  const appName = String(doc?.general?.app_name || 'Connect Bharat').trim();
  return {
    name: appName,
    legalName: settings.supplier_legal_name || appName,
    gstin: settings.supplier_gstin || '',
    address: settings.supplier_address || '',
    footer: settings.invoice_footer_note || '',
  };
};

/// Rental spend for the period. The rental agent is adding `corporateId`,
/// `corporateEmployeeId` and `billingMode` to RentalBookingRequest; they may
/// not be in this schema yet, so the raw collection is read (the strict-mode
/// equivalent of `strict: false`) and every field is treated as optional.
const loadRentalItems = async ({ corporate, from, to, invoiceId = null }) => {
  try {
    const rentals = await RentalBookingRequest.collection
      .find({
        corporateId: toObjectId(corporate._id),
        billingMode: { $in: ['corporate', null] },
        status: 'completed',
        $and: [
          { $or: [{ corporateInvoiceId: null }, { corporateInvoiceId: { $exists: false } }, ...(invoiceId ? [{ corporateInvoiceId: toObjectId(invoiceId) }] : [])] },
          {
            $or: [
              { completedAt: { $gte: from, $lt: to } },
              { completedAt: { $exists: false }, updatedAt: { $gte: from, $lt: to } },
              { completedAt: null, updatedAt: { $gte: from, $lt: to } },
            ],
          },
        ],
      })
      .project({ _id: 1, corporateEmployeeId: 1, totalCost: 1, corporateBilledAmount: 1, completedAt: 1, updatedAt: 1, pickupDateTime: 1, returnDateTime: 1, vehicleName: 1, serviceLocation: 1 })
      .toArray();

    return rentals.map((rental) => {
      const gross = round2(rental.totalCost || 0);
      const discount = computeCorporateDiscount({ discount: corporate.discount, serviceType: 'rental', fare: gross });
      const billed = rental.corporateBilledAmount !== undefined && rental.corporateBilledAmount !== null
        ? round2(rental.corporateBilledAmount)
        : discount.billableAmount;
      return {
        kind: 'rental',
        refId: rental._id,
        employeeId: rental.corporateEmployeeId || null,
        date: rental.completedAt || rental.updatedAt,
        serviceType: 'rental',
        pickup: rental.vehicleName ? `Rental: ${rental.vehicleName}` : 'Rental',
        drop: rental.serviceLocation?.name || '',
        grossAmount: gross,
        discountAmount: round2(gross - billed),
        netAmount: billed,
      };
    });
  } catch (error) {
    console.warn('[corporate-invoice] rental lookup failed', error.message);
    return [];
  }
};

const loadRideItems = async ({ corporateId, from, to, invoiceId = null }) => {
  const rides = await Ride.find({
    paymentMethod: 'corporate',
    'corporate.corporateId': corporateId,
    status: 'completed',
    'corporate.chargedAt': { $gte: from, $lt: to },
    'corporate.invoiceId': { $in: invoiceId ? [null, invoiceId] : [null] },
  })
    .select('_id fare serviceType pickupAddress dropAddress completedAt corporate')
    .lean();

  return rides.map((ride) => ({
    kind: 'ride',
    refId: ride._id,
    employeeId: ride.corporate.employeeId,
    departmentId: ride.corporate.departmentId || null,
    date: ride.completedAt || ride.corporate.chargedAt,
    serviceType: ride.serviceType || 'ride',
    pickup: ride.pickupAddress || '',
    drop: ride.dropAddress || '',
    grossAmount: round2(ride.fare),
    discountAmount: round2(ride.corporate.discountAmount),
    netAmount: round2(ride.corporate.billedAmount),
  }));
};

/// Fills department and employee names onto annex items.
const decorateItems = async (corporateId, items) => {
  const employeeIds = [...new Set(items.map((item) => item.employeeId).filter(Boolean).map(String))];
  const employees = await CorporateEmployee.find({ _id: { $in: employeeIds } }).select('name employeeCode departmentId').lean();
  const employeeById = new Map(employees.map((item) => [String(item._id), item]));
  for (const item of items) {
    const employee = item.employeeId ? employeeById.get(String(item.employeeId)) : null;
    item.employeeName = employee?.name || '';
    item.employeeCode = employee?.employeeCode || '';
    if (!item.departmentId && employee?.departmentId) item.departmentId = employee.departmentId;
  }

  const departments = await CorporateDepartment.find({ corporateId }).select('name costCenter').lean();
  const departmentById = new Map(departments.map((item) => [String(item._id), item]));
  for (const item of items) {
    const department = item.departmentId ? departmentById.get(String(item.departmentId)) : null;
    item.departmentName = department?.name || 'Unassigned';
    item.costCenter = department?.costCenter || '';
  }
  return items;
};

/// Builds (or rebuilds, while still a draft) the invoice for one company and
/// period. `periodKey` defaults to the month for a calendar-month range.
export const generateCorporateInvoice = async ({ corporateId, from, to, periodKey = '', generatedBy = 'system', skipEmpty = false }) => {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
    throw new ApiError(400, 'A valid from/to range is required');
  }
  const corporate = await Corporate.findById(corporateId).lean();
  if (!corporate) throw new ApiError(404, 'Corporate not found');

  const settings = await getCorporateSettings();
  const key = periodKey || `${fromDate.toISOString().slice(0, 10)}_${toDate.toISOString().slice(0, 10)}`;

  const existing = await CorporateInvoice.findOne({ corporateId, periodKey: key, live: true });
  if (existing && existing.status !== 'draft') {
    throw new ApiError(409, `Invoice ${existing.invoiceNumber} for this period is already ${existing.status}`);
  }

  const [rideItems, rentalItems] = await Promise.all([
    loadRideItems({ corporateId: corporate._id, from: fromDate, to: toDate, invoiceId: existing?._id }),
    loadRentalItems({ corporate, from: fromDate, to: toDate, invoiceId: existing?._id }),
  ]);
  const items = await decorateItems(corporate._id, [...rideItems, ...rentalItems]);
  if (skipEmpty && !items.length && !existing) return null;

  const totals = buildInvoiceTotals({
    items,
    gstPercent: settings.invoice_gst_percent,
    inclusive: isFlagOn(settings.invoice_fare_includes_tax),
    mode: resolveGstMode(settings.supplier_gstin, corporate.gstin),
  });

  const address = corporate.billingAddress || {};
  const payload = {
    corporateId: corporate._id,
    periodFrom: fromDate,
    periodTo: toDate,
    periodKey: key,
    live: true,
    ...totals,
    amountPaid: 0,
    balanceDue: totals.total,
    status: 'draft',
    billTo: {
      name: corporate.legalName || corporate.name,
      gstin: corporate.gstin || '',
      address: [address.line1, address.line2, address.city, address.state, address.pincode].filter(Boolean).join(', '),
      email: corporate.billingEmail || corporate.contact?.email || '',
    },
    generatedBy,
  };

  let invoice;
  if (existing) {
    // Release what the draft held, then re-take what is still in range.
    await releaseInvoiceItems(existing._id);
    existing.set(payload);
    invoice = await existing.save();
  } else {
    try {
      invoice = await CorporateInvoice.create({
        ...payload,
        invoiceNumber: await nextInvoiceNumber(settings.invoice_prefix || 'CORP', toDate),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new ApiError(409, 'An invoice for this period is being generated already');
      throw error;
    }
  }

  const rideIds = items.filter((item) => item.kind === 'ride').map((item) => item.refId);
  const rentalIds = items.filter((item) => item.kind === 'rental').map((item) => item.refId);
  if (rideIds.length) {
    await Ride.updateMany({ _id: { $in: rideIds } }, { $set: { 'corporate.invoiceId': invoice._id, 'corporate.billed': true } });
  }
  if (rentalIds.length) {
    await RentalBookingRequest.collection.updateMany({ _id: { $in: rentalIds } }, { $set: { corporateInvoiceId: invoice._id } });
    // Rentals are not charged on completion by this module, so the account is
    // charged here; per-rental references keep it idempotent if the rental
    // flow (or a regenerated draft) charges the same booking again.
    for (const item of items.filter((entry) => entry.kind === 'rental')) {
      await chargeCorporateAccount({
        corporateId: corporate._id,
        amount: item.netAmount,
        reference: { type: 'rental', id: String(item.refId) },
        description: 'Rental charge',
      });
    }
  }

  return invoice.toObject();
};

const releaseInvoiceItems = async (invoiceId) => {
  await Ride.updateMany({ 'corporate.invoiceId': invoiceId }, { $set: { 'corporate.invoiceId': null, 'corporate.billed': false } });
  await RentalBookingRequest.collection.updateMany({ corporateInvoiceId: invoiceId }, { $set: { corporateInvoiceId: null } }).catch(() => null);
};

const getInvoiceOrThrow = async (invoiceId, corporateId = null) => {
  if (!mongoose.Types.ObjectId.isValid(String(invoiceId))) throw new ApiError(400, 'Invalid invoice id');
  const filter = { _id: invoiceId };
  if (corporateId) filter.corporateId = corporateId;
  const invoice = await CorporateInvoice.findOne(filter);
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  return invoice;
};

export const issueCorporateInvoice = async ({ invoiceId, email = false }) => {
  const invoice = await getInvoiceOrThrow(invoiceId);
  if (invoice.status !== 'draft') throw new ApiError(409, `Invoice is already ${invoice.status}`);
  const corporate = await Corporate.findById(invoice.corporateId).lean();

  const now = new Date();
  invoice.status = 'issued';
  invoice.issuedAt = now;
  invoice.dueDate = new Date(now.getTime() + Math.max(0, Number(corporate?.paymentTermsDays ?? 30)) * 24 * 60 * 60 * 1000);
  await invoice.save();

  // With tax-exclusive fares the invoice is larger than what the trips charged
  // to the account; the difference is charged once, on issue.
  const taxAddOn = round2(invoice.total - invoice.netAmount);
  if (taxAddOn > 0) {
    await chargeCorporateAccount({
      corporateId: invoice.corporateId,
      amount: taxAddOn,
      reference: { type: 'invoice_tax', id: String(invoice._id) },
      description: `GST on ${invoice.invoiceNumber}`,
    });
  }

  if (email) {
    await emailCorporateInvoice({ invoiceId: invoice._id }).catch((error) =>
      console.warn('[corporate-invoice] email failed', error.message),
    );
  }

  return invoice.toObject();
};

export const buildCorporateInvoicePdf = async ({ invoiceId, corporateId = null }) => {
  const invoice = await getInvoiceOrThrow(invoiceId, corporateId);
  const [corporate, settings] = await Promise.all([
    Corporate.findById(invoice.corporateId).lean(),
    getCorporateSettings(),
  ]);
  const supplier = await loadSupplier(settings);
  const buffer = await renderCorporateInvoicePdf({ invoice: invoice.toObject(), corporate: corporate || {}, supplier });
  return { buffer, filename: `${invoice.invoiceNumber.replace(/[^\w-]+/g, '_')}.pdf` };
};

export const emailCorporateInvoice = async ({ invoiceId, to = '' }) => {
  const invoice = await getInvoiceOrThrow(invoiceId);
  if (invoice.status === 'draft' || invoice.status === 'void') throw new ApiError(409, 'Only issued invoices can be emailed');
  const corporate = await Corporate.findById(invoice.corporateId).lean();
  const owner = await CorporateAdmin.findOne({ corporateId: invoice.corporateId, role: { $in: ['finance', 'owner'] }, active: true })
    .sort({ role: 1 })
    .lean();
  const recipient = String(to || corporate?.billingEmail || corporate?.contact?.email || owner?.email || '').trim();
  if (!recipient) throw new ApiError(400, 'No billing email on file for this company');

  const { buffer, filename } = await buildCorporateInvoicePdf({ invoiceId });
  const result = await sendEmail({
    to: recipient,
    subject: `Invoice ${invoice.invoiceNumber} - Rs ${invoice.total}`,
    text: [
      `Dear ${corporate?.name || 'Customer'},`,
      '',
      `Please find attached invoice ${invoice.invoiceNumber} for ${invoice.tripCount} trips.`,
      `Amount due: Rs ${invoice.balanceDue} by ${invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-'}.`,
      invoice.paymentLink?.url ? `Pay online: ${invoice.paymentLink.url}` : '',
    ].filter((line) => line !== null).join('\n'),
    attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
  });

  if (!result?.skipped) {
    invoice.emailedAt = new Date();
    invoice.emailedTo = recipient;
    await invoice.save();
  }
  return { sent: !result?.skipped, to: recipient, reason: result?.reason || '' };
};

export const recordCorporateInvoicePayment = async ({ invoiceId, amount, method = 'manual', reference = '', note = '', paidAt, recordedBy = '' }) => {
  const invoice = await getInvoiceOrThrow(invoiceId);
  if (!['issued', 'partially_paid', 'overdue'].includes(invoice.status)) {
    throw new ApiError(409, `Payments cannot be recorded on a ${invoice.status} invoice`);
  }
  const value = round2(amount);
  if (!(value > 0)) throw new ApiError(400, 'amount must be greater than zero');
  if (value > round2(invoice.balanceDue) + 0.01) throw new ApiError(400, `amount exceeds the balance due (${invoice.balanceDue})`);

  invoice.payments.push({ amount: value, method, reference, note, paidAt: paidAt ? new Date(paidAt) : new Date(), recordedBy });
  const payment = invoice.payments[invoice.payments.length - 1];
  invoice.amountPaid = round2(invoice.amountPaid + value);
  invoice.balanceDue = round2(Math.max(0, invoice.total - invoice.amountPaid));
  invoice.status = resolveInvoicePaymentStatus({ total: invoice.total, amountPaid: invoice.amountPaid, dueDate: invoice.dueDate, currentStatus: invoice.status });
  if (invoice.status === 'paid') invoice.paidAt = new Date();
  await invoice.save();

  await recordCorporatePayment({
    corporateId: invoice.corporateId,
    amount: value,
    reference: { type: 'invoice_payment', id: String(payment._id) },
    description: `Payment on ${invoice.invoiceNumber}${reference ? ` (${reference})` : ''}`,
    metadata: { invoiceId: String(invoice._id), method },
  });

  return invoice.toObject();
};

export const voidCorporateInvoice = async ({ invoiceId, reason = '' }) => {
  const invoice = await getInvoiceOrThrow(invoiceId);
  if (invoice.status === 'void') return invoice.toObject();
  if (invoice.amountPaid > 0) throw new ApiError(409, 'An invoice with payments cannot be voided');

  const wasIssued = invoice.status !== 'draft';
  invoice.status = 'void';
  invoice.live = false;
  invoice.voidedAt = new Date();
  invoice.voidReason = String(reason || '').trim();
  await invoice.save();
  await releaseInvoiceItems(invoice._id);

  const taxAddOn = round2(invoice.total - invoice.netAmount);
  if (wasIssued && taxAddOn > 0) {
    await reverseCorporateCharge({
      corporateId: invoice.corporateId,
      amount: taxAddOn,
      reference: { type: 'invoice_tax_void', id: String(invoice._id) },
      description: `GST reversal, ${invoice.invoiceNumber} voided`,
    });
  }
  return invoice.toObject();
};

const razorpayRequest = async ({ method, path, body, keyId, keySecret }) => {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status || 502, payload?.error?.description || 'Razorpay request failed');
  }
  return payload;
};

/// A Razorpay Payment Link for the balance due. Reuses an open link for the
/// same amount rather than minting a new one per click.
export const createInvoicePaymentLink = async ({ invoiceId, corporateId = null }) => {
  const invoice = await getInvoiceOrThrow(invoiceId, corporateId);
  if (!['issued', 'partially_paid', 'overdue'].includes(invoice.status)) throw new ApiError(409, 'Invoice is not payable');
  if (invoice.paymentLink?.url && invoice.paymentLink.status === 'created' && round2(invoice.paymentLink.amount) === round2(invoice.balanceDue)) {
    return invoice.paymentLink;
  }

  const { keyId, keySecret } = await resolveConfiguredGatewayCredentials('razor_pay');
  const corporate = await Corporate.findById(invoice.corporateId).lean();
  const link = await razorpayRequest({
    method: 'POST',
    path: '/payment_links',
    keyId,
    keySecret,
    body: {
      amount: Math.round(invoice.balanceDue * 100),
      currency: 'INR',
      accept_partial: false,
      description: `Invoice ${invoice.invoiceNumber}`,
      reference_id: `${invoice.invoiceNumber}-${Date.now().toString(36)}`.slice(0, 40),
      customer: {
        name: corporate?.name || '',
        email: corporate?.billingEmail || corporate?.contact?.email || undefined,
        contact: corporate?.contact?.phone || undefined,
      },
      notify: { sms: false, email: false },
      notes: { invoiceId: String(invoice._id), corporateId: String(invoice.corporateId) },
    },
  });

  invoice.paymentLink = {
    provider: 'razorpay',
    id: link.id,
    url: link.short_url,
    status: link.status,
    amount: round2(invoice.balanceDue),
    createdAt: new Date(),
  };
  await invoice.save();
  return invoice.paymentLink;
};

/// Pulls the link's state from Razorpay and records whatever was paid that is
/// not recorded yet. Safe to call repeatedly (the job does, and so can the
/// panel's "I've paid" button); webhook handling belongs to the payments agent.
export const syncInvoicePaymentLink = async ({ invoiceId }) => {
  const invoice = await getInvoiceOrThrow(invoiceId);
  if (!invoice.paymentLink?.id) return invoice.toObject();

  const { keyId, keySecret } = await resolveConfiguredGatewayCredentials('razor_pay');
  const link = await razorpayRequest({ method: 'GET', path: `/payment_links/${invoice.paymentLink.id}`, keyId, keySecret });
  invoice.paymentLink.status = link.status;
  await invoice.save();

  const paidOnLink = round2(Number(link.amount_paid || 0) / 100);
  const alreadyRecorded = round2(invoice.payments
    .filter((payment) => payment.method === 'razorpay' && payment.reference === invoice.paymentLink.id)
    .reduce((sum, payment) => sum + payment.amount, 0));
  const unrecorded = round2(Math.min(paidOnLink - alreadyRecorded, invoice.balanceDue));

  if (unrecorded > 0 && ['issued', 'partially_paid', 'overdue'].includes(invoice.status)) {
    return recordCorporateInvoicePayment({
      invoiceId,
      amount: unrecorded,
      method: 'razorpay',
      reference: invoice.paymentLink.id,
      note: (link.payments || []).map((payment) => payment.payment_id).filter(Boolean).join(','),
      recordedBy: 'razorpay',
    });
  }
  return invoice.toObject();
};

export const markOverdueInvoices = async (now = new Date()) => {
  const result = await CorporateInvoice.updateMany(
    { status: { $in: ['issued', 'partially_paid'] }, dueDate: { $lt: now }, balanceDue: { $gt: 0 } },
    { $set: { status: 'overdue' } },
  );
  return result.modifiedCount || 0;
};

/// Monthly run, on days 1-3 of the IST month so a server that was down on the
/// 1st still catches up. The (corporateId, periodKey) unique index makes it
/// safe for every instance to run it.
export const runMonthlyInvoiceGeneration = async (now = new Date()) => {
  const settings = await getCorporateSettings();
  if (!isFlagOn(settings.auto_generate_invoices)) return { skipped: 'disabled' };
  if (getIstClock(now).date > 3) return { skipped: 'not-billing-day' };

  const { from, to, periodKey } = getPreviousIstMonthRange(now);
  const corporates = await Corporate.find({ status: { $in: ['approved', 'suspended'] } }).select('_id').lean();
  let generated = 0;

  for (const { _id } of corporates) {
    const exists = await CorporateInvoice.exists({ corporateId: _id, periodKey });
    if (exists) continue;
    try {
      const invoice = await generateCorporateInvoice({ corporateId: _id, from, to, periodKey, generatedBy: 'monthly-job', skipEmpty: true });
      if (!invoice) continue;
      generated += 1;
      if (isFlagOn(settings.auto_issue_invoices) && invoice.tripCount > 0) {
        await issueCorporateInvoice({ invoiceId: invoice._id, email: true });
      }
    } catch (error) {
      if (error?.statusCode !== 409) console.warn('[corporate-invoice] monthly generation failed', String(_id), error.message);
    }
  }
  return { generated, periodKey };
};

export const syncOpenPaymentLinks = async ({ limit = 20 } = {}) => {
  const invoices = await CorporateInvoice.find({
    status: { $in: ['issued', 'partially_paid', 'overdue'] },
    'paymentLink.id': { $gt: '' },
    'paymentLink.status': { $in: ['created', 'partially_paid'] },
  }).select('_id').limit(limit).lean();
  for (const { _id } of invoices) {
    await syncInvoicePaymentLink({ invoiceId: _id }).catch(() => null);
  }
};

export const listCorporateInvoices = async ({ corporateId = null, status = '', page = 1, limit = 25 }) => {
  const filter = {};
  if (corporateId) filter.corporateId = corporateId;
  if (status) filter.status = status;
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const [items, total] = await Promise.all([
    CorporateInvoice.find(filter)
      .select('-annex')
      .sort({ periodFrom: -1, createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('corporateId', 'name code')
      .lean(),
    CorporateInvoice.countDocuments(filter),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
};

export const getCorporateInvoice = async ({ invoiceId, corporateId = null }) => (await getInvoiceOrThrow(invoiceId, corporateId)).toObject();

/// Outstanding and aging (SOW 8.9). With `corporateId` it is one company's
/// report; without, one row per company plus the platform totals.
export const getAgingReport = async ({ corporateId = null, now = new Date() } = {}) => {
  const filter = { status: { $in: ['issued', 'partially_paid', 'overdue'] } };
  if (corporateId) filter.corporateId = toObjectId(corporateId);
  const invoices = await CorporateInvoice.find(filter).select('corporateId invoiceNumber total amountPaid balanceDue dueDate status issuedAt').lean();

  const overall = buildAgingBuckets(invoices, now);
  const byCorporate = new Map();
  for (const invoice of invoices) {
    const key = String(invoice.corporateId);
    if (!byCorporate.has(key)) byCorporate.set(key, []);
    byCorporate.get(key).push(invoice);
  }
  const corporates = await Corporate.find({ _id: { $in: [...byCorporate.keys()] } }).select('name code currentOutstanding creditLimit').lean();
  const rows = corporates.map((corporate) => ({
    corporateId: String(corporate._id),
    name: corporate.name,
    code: corporate.code,
    currentOutstanding: round2(corporate.currentOutstanding),
    creditLimit: corporate.creditLimit,
    ...buildAgingBuckets(byCorporate.get(String(corporate._id)) || [], now),
  }));

  return { ...overall, corporates: rows, invoices: corporateId ? invoices : undefined };
};
