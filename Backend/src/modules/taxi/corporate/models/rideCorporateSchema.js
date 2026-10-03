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

    // --- Corporate v2 (docs/plans/corporate-v2.md §1.4) ---
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateRole', default: null },
    /// Set on travel-desk bookings (a panel user booked for the employee).
    bookedByCorporateAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateAdmin', default: null },
    bookingNote: { type: String, default: '', trim: true },
    /// 'company_tariff' when the fare came from Corporate.tariff.
    pricing: { type: String, enum: ['company_tariff', 'standard'], default: 'standard' },
    /// The commission override the trip was booked under (audit copy; the
    /// figures settlement uses are written into pricingSnapshot).
    driverCommission: {
      type: new mongoose.Schema(
        { type: { type: String, default: '' }, value: { type: Number, default: 0 } },
        { _id: false },
      ),
      default: undefined,
    },
    allowance: {
      type: new mongoose.Schema(
        {
          enabled: { type: Boolean, default: false },
          period: { type: String, default: '' },
          periodKey: { type: String, default: '' },
          allowanceKm: { type: Number, default: 0 },
          remainingKmAtBooking: { type: Number, default: 0 },
          estimatedKm: { type: Number, default: 0 },
          /// Km held on CorporateAllowanceUsage.reservedKm for this ride while
          /// `reservationOpen`; released once, on completion or cancellation.
          reservedKm: { type: Number, default: 0 },
          reservationOpen: { type: Boolean, default: false },
          actualKm: { type: Number, default: 0 },
          coveredKm: { type: Number, default: 0 },
          excessKm: { type: Number, default: 0 },
          settledAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: undefined,
    },
    split: {
      type: new mongoose.Schema(
        {
          companyAmount: { type: Number, default: 0 },
          employeeAmount: { type: Number, default: 0 },
          employeePaymentMethod: { type: String, enum: ['cash', 'online', 'wallet', ''], default: '' },
          employeePaymentStatus: { type: String, enum: ['not_required', 'pending', 'paid'], default: 'not_required' },
          /// 'estimate' at booking, 'final' once completion recomputed it.
          stage: { type: String, default: 'estimate' },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { _id: false },
);
