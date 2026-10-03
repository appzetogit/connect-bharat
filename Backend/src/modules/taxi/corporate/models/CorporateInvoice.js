import mongoose from 'mongoose';

export const INVOICE_STATUSES = Object.freeze(['draft', 'issued', 'paid', 'partially_paid', 'overdue', 'void']);

const departmentLineSchema = new mongoose.Schema(
  {
    departmentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    departmentName: { type: String, default: 'Unassigned' },
    costCenter: { type: String, default: '' },
    trips: { type: Number, default: 0 },
    grossAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
  },
  { _id: false },
);

/// One row of the per-trip annex. Copied, not referenced, so a later edit to a
/// ride or an employee never changes an invoice that has been issued.
const annexLineSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['ride', 'rental'], default: 'ride' },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    date: { type: Date, default: null },
    serviceType: { type: String, default: 'ride' },
    departmentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    departmentName: { type: String, default: '' },
    employeeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    employeeName: { type: String, default: '' },
    employeeCode: { type: String, default: '' },
    pickup: { type: String, default: '' },
    drop: { type: String, default: '' },
    grossAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    // --- Corporate v2 (§3.4). grossAmount above is the company's share
    // (companyAmount) so that grossAmount - discountAmount = netAmount still
    // holds; grossFare is the whole trip fare.
    roleName: { type: String, default: '' },
    pickupAddress: { type: String, default: '' },
    dropAddress: { type: String, default: '' },
    vehicleName: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    actualKm: { type: Number, default: 0 },
    coveredKm: { type: Number, default: 0 },
    excessKm: { type: Number, default: 0 },
    grossFare: { type: Number, default: 0 },
    employeeAmount: { type: Number, default: 0 },
    companyAmount: { type: Number, default: 0 },
    billedAmount: { type: Number, default: 0 },
    pricing: { type: String, default: 'standard' },
    roleId: { type: mongoose.Schema.Types.ObjectId, default: null },
    roleCode: { type: String, default: '' },
  },
  { _id: false },
);

const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ['manual', 'bank_transfer', 'cheque', 'upi', 'cash', 'razorpay'], default: 'manual' },
    reference: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    paidAt: { type: Date, default: Date.now },
    recordedBy: { type: String, default: '' },
  },
  { _id: true, timestamps: true },
);

/// Consolidated monthly bill for a company.
///
/// Money is in rupees with two decimals, like the rest of the codebase. The
/// totals are computed once by `buildInvoiceTotals` (pure, unit-tested) and
/// stored; the PDF is rendered on demand from the stored figures.
const corporateInvoiceSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true },
    periodFrom: { type: Date, required: true },
    periodTo: { type: Date, required: true },
    /// "2026-09" for a monthly run, "2026-W41" for a weekly one, or
    /// "<from>_<to>" for an admin-chosen range.
    /// Unique among live invoices so two server instances running the monthly
    /// job cannot both bill the same month.
    periodKey: { type: String, required: true },
    /// false once voided, which frees the period for a fresh invoice.
    live: { type: Boolean, default: true },
    lines: { type: [departmentLineSchema], default: [] },
    annex: { type: [annexLineSchema], default: [] },
    /// §3.4 / §5: byRole rows { roleId, roleName, roleCode, trips, km,
    /// coveredKm, excessKm, employeeAmount, billedAmount }; byEmployee rows
    /// have employeeId / employeeName / employeeCode instead.
    byRole: { type: [mongoose.Schema.Types.Mixed], default: [] },
    byEmployee: { type: [mongoose.Schema.Types.Mixed], default: [] },
    /// Total the employees paid themselves for km over their allowance; not
    /// part of this invoice's amount, printed for information.
    employeePaidTotal: { type: Number, default: 0 },
    tripCount: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    taxableAmount: { type: Number, default: 0 },
    tax: {
      mode: { type: String, enum: ['intra', 'inter'], default: 'intra' },
      percent: { type: Number, default: 0 },
      inclusive: { type: Boolean, default: true },
      cgst: { type: Number, default: 0 },
      sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    roundOff: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    balanceDue: { type: Number, default: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'draft', index: true },
    issuedAt: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: '' },
    emailedAt: { type: Date, default: null },
    emailedTo: { type: String, default: '' },
    payments: { type: [paymentSchema], default: [] },
    /// Set when a PDF has been stored somewhere; otherwise it is rendered on
    /// demand by GET .../pdf.
    pdfUrl: { type: String, default: '' },
    paymentLink: {
      provider: { type: String, default: '' },
      id: { type: String, default: '' },
      url: { type: String, default: '' },
      status: { type: String, default: '' },
      amount: { type: Number, default: 0 },
      createdAt: { type: Date, default: null },
    },
    /// Snapshot of who was billed, as printed.
    billTo: { type: mongoose.Schema.Types.Mixed, default: {} },
    generatedBy: { type: String, default: 'system' },
  },
  { timestamps: true },
);

corporateInvoiceSchema.index({ invoiceNumber: 1 }, { unique: true });
corporateInvoiceSchema.index(
  { corporateId: 1, periodKey: 1 },
  { unique: true, partialFilterExpression: { live: true } },
);
corporateInvoiceSchema.index({ status: 1, dueDate: 1 });

export const CorporateInvoice =
  mongoose.models.TaxiCorporateInvoice || mongoose.model('TaxiCorporateInvoice', corporateInvoiceSchema);

/// Sequence for invoice numbers. A counter document per prefix+year keeps the
/// numbers gap-free per financial year, which is what GST invoices expect.
const corporateCounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

export const CorporateCounter =
  mongoose.models.TaxiCorporateCounter || mongoose.model('TaxiCorporateCounter', corporateCounterSchema);
