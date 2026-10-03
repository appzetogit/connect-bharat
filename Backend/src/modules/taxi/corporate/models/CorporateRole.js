import mongoose from 'mongoose';
import { CORPORATE_SERVICES } from './Corporate.js';

export const ALLOWANCE_PERIODS = Object.freeze(['weekly', 'monthly']);

/// A seniority band inside a company (CEO, VP, Employee, ...), carrying the
/// free-km allowance and travel rules for everyone in it.
///
/// Travel rules use the same "null / empty = inherit" semantics as
/// CorporateTripPolicy; the merge order is company -> department -> role ->
/// employee (`mergePolicies` in corporatePolicyEngine.js). See
/// docs/plans/corporate-v2.md §1.1.
const corporateRoleSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    level: { type: Number, default: 10 },
    active: { type: Boolean, default: true },
    /// The role an employee gets when none is chosen. Exactly one per company,
    /// kept so by corporateRoleService (make-default clears the others).
    isDefault: { type: Boolean, default: false },
    allowance: {
      enabled: { type: Boolean, default: false },
      km: { type: Number, default: 0, min: 0 },
      period: { type: String, enum: ALLOWANCE_PERIODS, default: 'monthly' },
    },
    allowedServices: { type: [{ type: String, enum: CORPORATE_SERVICES }], default: [] },
    allowedVehicleTypeIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle' }], default: [] },
    maxFarePerTrip: { type: Number, default: null, min: 0 },
    requireApprovalAlways: { type: Boolean, default: null },
    requireApprovalAbove: { type: Number, default: null, min: 0 },
    /// Per-employee monthly cap on the company-paid amount for people in this
    /// role. 0 = none. An employee's own `monthlyLimit` (when > 0) wins.
    monthlySpendLimit: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

corporateRoleSchema.index({ corporateId: 1, code: 1 }, { unique: true });
corporateRoleSchema.index(
  { corporateId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);

export const CorporateRole = mongoose.models.TaxiCorporateRole || mongoose.model('TaxiCorporateRole', corporateRoleSchema);
