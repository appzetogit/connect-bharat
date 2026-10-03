import mongoose from 'mongoose';
import { ALLOWANCE_PERIODS } from './CorporateRole.js';

/// One employee's free-km usage for one period (IST week `2026-W41` or month
/// `2026-10`).
///
/// `reservedKm` holds km for trips booked but not completed, so two trips
/// booked together cannot both claim the same remaining km. Every change is a
/// single conditional update (corporateAllowanceService.js), never a
/// read-modify-write, and `usedKm + reservedKm` never exceeds `allowanceKm`
/// through those updates.
const corporateAllowanceUsageSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateEmployee', required: true },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateRole', default: null },
    periodKey: { type: String, required: true },
    period: { type: String, enum: ALLOWANCE_PERIODS, default: 'monthly' },
    allowanceKm: { type: Number, default: 0, min: 0 },
    usedKm: { type: Number, default: 0, min: 0 },
    reservedKm: { type: Number, default: 0, min: 0 },
    rides: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

corporateAllowanceUsageSchema.index({ employeeId: 1, periodKey: 1 }, { unique: true });
corporateAllowanceUsageSchema.index({ corporateId: 1, periodKey: 1 });

export const CorporateAllowanceUsage =
  mongoose.models.TaxiCorporateAllowanceUsage
  || mongoose.model('TaxiCorporateAllowanceUsage', corporateAllowanceUsageSchema);
