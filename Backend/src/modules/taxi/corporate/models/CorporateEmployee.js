import mongoose from 'mongoose';
import { CORPORATE_SERVICES } from './Corporate.js';

/// A rider allowed to bill trips to a company.
///
/// `userId` is the ordinary rider account (matched by phone, created if the
/// person has never used the app), so an employee keeps one login and one ride
/// history and simply gains a "Bill to company" option.
const corporateEmployeeSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateDepartment', default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', default: null, index: true },
    employeeCode: { type: String, default: '', trim: true },
    name: { type: String, required: true, trim: true },
    /// 10-digit Indian mobile, the join key to `User.phone`.
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    designation: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true, index: true },
    /// Hard cap on billed spend per calendar month (IST). 0 = no cap.
    monthlyLimit: { type: Number, default: 0, min: 0 },
    /// Every trip by this employee needs an approver, whatever the policy says.
    requiresApproval: { type: Boolean, default: false },
    /// Narrows the company/department services. Empty = no extra restriction.
    allowedServices: { type: [{ type: String, enum: CORPORATE_SERVICES }], default: [] },
    invitedAt: { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

corporateEmployeeSchema.index({ corporateId: 1, phone: 1 }, { unique: true });
corporateEmployeeSchema.index({ userId: 1, active: 1 });

export const CorporateEmployee =
  mongoose.models.TaxiCorporateEmployee || mongoose.model('TaxiCorporateEmployee', corporateEmployeeSchema);
