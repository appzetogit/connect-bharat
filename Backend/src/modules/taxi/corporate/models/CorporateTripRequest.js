import mongoose from 'mongoose';
import { CORPORATE_SERVICES } from './Corporate.js';

export const TRIP_REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'cancelled', 'booked']);

/// One trip waiting on (or decided by) a corporate approver.
///
/// The ride itself already exists in `searching` state with
/// `corporate.approvalStatus = 'pending'`; dispatch is held back by the gate in
/// `startDispatchFlow` until this request is approved.
const corporateTripRequestSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateEmployee', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', default: null },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateDepartment', default: null },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRide', default: null, index: true },
    rentalBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRentalBookingRequest', default: null },
    serviceType: { type: String, enum: CORPORATE_SERVICES, default: 'ride' },
    estimatedFare: { type: Number, default: 0, min: 0 },
    /// Fare after the corporate discount, i.e. what the company will be billed.
    billableAmount: { type: Number, default: 0, min: 0 },
    pickupAddress: { type: String, default: '' },
    dropAddress: { type: String, default: '' },
    scheduledAt: { type: Date, default: null },
    /// Why approval was needed, e.g. "Fare above 500", "Outside allowed hours".
    reasons: { type: [String], default: [] },
    status: { type: String, enum: TRIP_REQUEST_STATUSES, default: 'pending', index: true },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateAdmin', default: null },
    decisionAt: { type: Date, default: null },
    note: { type: String, default: '', trim: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

corporateTripRequestSchema.index({ corporateId: 1, status: 1, createdAt: -1 });
corporateTripRequestSchema.index({ status: 1, expiresAt: 1 });

export const CorporateTripRequest =
  mongoose.models.TaxiCorporateTripRequest || mongoose.model('TaxiCorporateTripRequest', corporateTripRequestSchema);
