import mongoose from 'mongoose';

/// Someone who works a hub. Every hub staff member signs in with the JWT
/// role `hub_manager` (the role the auth middleware resolves to this model);
/// `role` here separates managers from operators for the few actions that
/// need it.
const hubStaffSchema = new mongoose.Schema(
  {
    hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    email: { type: String, default: '', lowercase: true, trim: true },
    passwordHash: { type: String, default: '', select: false },
    role: { type: String, enum: ['hub_manager', 'hub_operator'], default: 'hub_operator' },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

hubStaffSchema.index({ email: 1 });

export const HubStaff = mongoose.models.LogisticsHubStaff || mongoose.model('LogisticsHubStaff', hubStaffSchema);
