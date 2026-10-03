import mongoose from 'mongoose';

/// A damage claim on a rental booking.
///
/// Raised by the rider during the rental, by service-centre staff at the
/// handover (`pre`, a record of existing damage the rider must not be charged
/// for) or at the return (`post`), or by an admin. Only an admin moves money:
/// `charged` takes the amount from the security deposit first and adds what
/// the deposit cannot cover to the booking's final charge.
const damageItemSchema = new mongoose.Schema(
  {
    part: { type: String, default: '', trim: true },
    severity: {
      type: String,
      enum: ['minor', 'moderate', 'major'],
      default: 'minor',
    },
    description: { type: String, default: '', trim: true },
    photos: { type: [String], default: [] },
    estimatedCost: { type: Number, default: 0, min: 0 },
  },
  { _id: true },
);

const damageHistorySchema = new mongoose.Schema(
  {
    action: { type: String, default: '', trim: true },
    byRole: { type: String, default: '', trim: true },
    byId: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    amount: { type: Number, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const rentalDamageReportSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRentalBookingRequest',
      required: true,
    },
    bookingReference: { type: String, default: '', trim: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      default: null,
    },
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRentalVehicleUnit',
      default: null,
    },
    reportedBy: {
      role: {
        type: String,
        enum: ['user', 'service_center', 'service_center_staff', 'admin'],
        default: 'user',
      },
      id: { type: String, default: '', trim: true },
      name: { type: String, default: '', trim: true },
    },
    stage: {
      type: String,
      enum: ['pre', 'post', 'during'],
      default: 'during',
    },
    items: { type: [damageItemSchema], default: [] },
    notes: { type: String, default: '', trim: true },
    totalEstimatedCost: { type: Number, default: 0, min: 0 },
    assessedAmount: { type: Number, default: null, min: 0 },
    status: {
      type: String,
      enum: ['open', 'assessed', 'charged', 'waived', 'disputed'],
      default: 'open',
    },
    chargedAmount: { type: Number, default: 0, min: 0 },
    chargedFromDeposit: { type: Number, default: 0, min: 0 },
    chargedToFinal: { type: Number, default: 0, min: 0 },
    dispute: {
      raisedAt: { type: Date, default: null },
      reason: { type: String, default: '', trim: true },
    },
    resolution: { type: String, default: '', trim: true },
    resolvedAt: { type: Date, default: null },
    history: { type: [damageHistorySchema], default: [] },
  },
  { timestamps: true },
);

rentalDamageReportSchema.index({ bookingId: 1, createdAt: -1 });
rentalDamageReportSchema.index({ status: 1, createdAt: -1 });

export const RentalDamageReport =
  mongoose.models.TaxiRentalDamageReport ||
  mongoose.model('TaxiRentalDamageReport', rentalDamageReportSchema);
