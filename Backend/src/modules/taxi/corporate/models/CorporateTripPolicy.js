import mongoose from 'mongoose';
import { CORPORATE_SERVICES } from './Corporate.js';

const timeWindowSchema = new mongoose.Schema(
  {
    /// 0 = Sunday ... 6 = Saturday, evaluated in IST. Empty = every day.
    days: { type: [Number], default: [] },
    /// "HH:mm". A window whose end is before its start runs past midnight.
    start: { type: String, default: '00:00', trim: true },
    end: { type: String, default: '23:59', trim: true },
  },
  { _id: false },
);

/// Travel rules for a company (departmentId null) or one department.
///
/// A department policy overrides the company policy field by field, and only
/// where it sets something: an empty list or a null number means "inherit".
/// See `mergePolicies` in corporatePolicyEngine.js.
const corporateTripPolicySchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateDepartment', default: null },
    name: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
    allowedServices: { type: [{ type: String, enum: CORPORATE_SERVICES }], default: [] },
    allowedVehicleTypeIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle' }], default: [] },
    allowedHours: { type: [timeWindowSchema], default: [] },
    /// What happens to a trip outside `allowedHours`.
    outsideHoursAction: { type: String, enum: ['block', 'approval'], default: null },
    /// null = no cap.
    maxFarePerTrip: { type: Number, default: null, min: 0 },
    overMaxFareAction: { type: String, enum: ['block', 'approval'], default: null },
    /// Trips whose billable fare is above this need an approver. 0 = every
    /// trip; null = never on fare alone.
    requireApprovalAbove: { type: Number, default: null, min: 0 },
    requireApprovalAlways: { type: Boolean, default: null },
  },
  { timestamps: true },
);

corporateTripPolicySchema.index({ corporateId: 1, departmentId: 1 }, { unique: true });

export const CorporateTripPolicy =
  mongoose.models.TaxiCorporateTripPolicy || mongoose.model('TaxiCorporateTripPolicy', corporateTripPolicySchema);
