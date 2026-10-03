import mongoose from 'mongoose';

/// `Ride.corporate` — present only on rides billed to a company
/// (`paymentMethod: 'corporate'`). Kept in its own file so the Ride model only
/// gains one import and one field.
///
/// The ride's own `fare` stays the gross trip fare, so driver settlement and
/// commission are untouched by the company's negotiated discount; the discount
/// is the platform's concession and is applied only to what the company is
/// billed (`billedAmount`).
export const rideCorporateSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateEmployee', required: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateDepartment', default: null },
    tripRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateTripRequest', default: null },
    /// not_required | pending | approved | rejected | expired
    approvalStatus: { type: String, default: 'not_required' },
    discountType: { type: String, default: '' },
    discountValue: { type: Number, default: 0 },
    /// Estimated at booking, recomputed on the final fare at completion.
    discountAmount: { type: Number, default: 0 },
    billedAmount: { type: Number, default: 0 },
    chargedAt: { type: Date, default: null },
    billed: { type: Boolean, default: false },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateInvoice', default: null },
  },
  { _id: false },
);
