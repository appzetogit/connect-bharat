import mongoose from 'mongoose';

export const CORPORATE_ADMIN_ROLES = Object.freeze(['owner', 'admin', 'approver', 'finance']);

/// A person who signs in to the corporate web panel.
///
/// Distinct from `CorporateEmployee` (riders who bill trips to the company):
/// a travel desk manager may never ride, and most riders never see the panel.
/// Authenticated as JWT role `corporate_admin`.
const corporateAdminSchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    name: { type: String, required: true, trim: true },
    /// Globally unique so email + password login needs no company picker.
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, default: '', trim: true },
    passwordHash: { type: String, default: '', select: false },
    role: { type: String, enum: CORPORATE_ADMIN_ROLES, default: 'admin' },
    /// Approvers only see and decide on trips from these departments. Empty for
    /// an approver means every department.
    departmentIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporateDepartment' }], default: [] },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    loginOtp: {
      hash: { type: String, default: '', select: false },
      expiresAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

corporateAdminSchema.index({ email: 1 }, { unique: true });
corporateAdminSchema.index({ phone: 1 });

export const CorporateAdmin =
  mongoose.models.TaxiCorporateAdmin || mongoose.model('TaxiCorporateAdmin', corporateAdminSchema);
