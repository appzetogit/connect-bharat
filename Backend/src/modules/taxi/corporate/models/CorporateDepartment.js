import mongoose from 'mongoose';

const corporateDepartmentSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, default: '', trim: true, uppercase: true },
    costCenter: { type: String, default: '', trim: true },
    /// Soft budget: going over it sends the trip for approval rather than
    /// refusing it, because a stranded employee is worse than an overspend.
    /// 0 = no budget.
    monthlyBudget: { type: Number, default: 0, min: 0 },
    /// CorporateAdmin ids who may approve this department's trips.
    approverIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateAdmin' }], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

corporateDepartmentSchema.index({ corporateId: 1, name: 1 }, { unique: true });

export const CorporateDepartment =
  mongoose.models.TaxiCorporateDepartment || mongoose.model('TaxiCorporateDepartment', corporateDepartmentSchema);
