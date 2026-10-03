import mongoose from 'mongoose';

/// One pending OTP login per phone, mirroring DriverLoginSession. Its own
/// collection so hub logins never collide with the driver/owner sessions
/// keyed on the same phone number.
const hubLoginSessionSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, trim: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHubStaff', required: true },
    otpHash: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

hubLoginSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const HubLoginSession =
  mongoose.models.LogisticsHubLoginSession || mongoose.model('LogisticsHubLoginSession', hubLoginSessionSchema);
