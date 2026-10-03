import mongoose from 'mongoose';

/// The services a company can be billed for. Ride `serviceType` values plus
/// rental, which lives in its own stack (`RentalBookingRequest`).
export const CORPORATE_SERVICES = Object.freeze(['ride', 'parcel', 'intercity', 'rental']);

export const CORPORATE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'suspended']);

const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, default: '', trim: true },
    line2: { type: String, default: '', trim: true },
    city: { type: String, default: '', trim: true },
    state: { type: String, default: '', trim: true },
    pincode: { type: String, default: '', trim: true },
    country: { type: String, default: 'India', trim: true },
  },
  { _id: false },
);

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    phone: { type: String, default: '', trim: true },
    designation: { type: String, default: '', trim: true },
  },
  { _id: false },
);

/// A company that rides on credit.
///
/// Money fields are kept here rather than derived on every request because the
/// booking path checks `currentOutstanding` against `creditLimit` on each
/// corporate ride; the authoritative history is `CorporateLedgerEntry`, and
/// `currentOutstanding` is only ever moved by the ledger service.
const corporateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, default: '', trim: true },
    /// Short human code shown in the panel and printed on invoices.
    code: { type: String, trim: true, uppercase: true, default: '' },
    gstin: { type: String, default: '', trim: true, uppercase: true },
    pan: { type: String, default: '', trim: true, uppercase: true },
    industry: { type: String, default: '', trim: true },
    employeeCountEstimate: { type: Number, default: 0, min: 0 },
    billingAddress: { type: addressSchema, default: () => ({}) },
    contact: { type: contactSchema, default: () => ({}) },
    /// Where invoices are mailed. Falls back to `contact.email`.
    billingEmail: { type: String, default: '', trim: true, lowercase: true },

    status: { type: String, enum: CORPORATE_STATUSES, default: 'pending', index: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '', trim: true },
    suspendedReason: { type: String, default: '', trim: true },
    source: { type: String, enum: ['self', 'admin', 'enquiry'], default: 'self' },
    enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiWebsiteEnquiry', default: null },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },

    /// 0 means no credit: every corporate booking is refused until an admin
    /// sets a limit. An unlimited account is deliberately not expressible.
    creditLimit: { type: Number, default: 0, min: 0 },
    /// Per-company override of the global grace (percent of the limit). null
    /// means "use the business setting".
    creditGracePercent: { type: Number, default: null, min: 0 },
    billingCycle: { type: String, enum: ['monthly'], default: 'monthly' },
    paymentTermsDays: { type: Number, default: 30, min: 0 },
    currentOutstanding: { type: Number, default: 0 },
    discount: {
      type: { type: String, enum: ['percentage', 'flat'], default: 'percentage' },
      value: { type: Number, default: 0, min: 0 },
      /// Caps a percentage discount per trip. 0 = no cap.
      maxPerTrip: { type: Number, default: 0, min: 0 },
      appliesTo: { type: [{ type: String, enum: CORPORATE_SERVICES }], default: () => [...CORPORATE_SERVICES] },
    },
    /// Empty = every service.
    allowedServices: { type: [{ type: String, enum: CORPORATE_SERVICES }], default: [] },
    /// Empty = every vehicle type.
    allowedVehicleTypeIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle' }], default: [] },
    serviceLocationIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation' }], default: [] },
    /// How long a trip waits for an approver before it is cancelled. null = the
    /// business-setting default.
    approvalExpiryMinutes: { type: Number, default: null, min: 1 },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

corporateSchema.index({ status: 1, createdAt: -1 });
corporateSchema.index({ name: 1 });
corporateSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $gt: '' } } });

export const Corporate = mongoose.models.TaxiCorporate || mongoose.model('TaxiCorporate', corporateSchema);
