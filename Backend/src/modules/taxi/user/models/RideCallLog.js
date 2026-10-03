import mongoose from 'mongoose';

/**
 * Audit of `ride:call` requests: who asked to call whom on which ride, through
 * which provider, and what the provider said. Its own collection rather than
 * an array on the ride, so a chatty rider can't grow the ride document and
 * support can query calls across rides.
 */
const rideCallLogSchema = new mongoose.Schema(
  {
    event: { type: String, default: 'ride:call', trim: true },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRide', required: true, index: true },
    initiatorRole: { type: String, enum: ['user', 'driver'], required: true },
    initiatorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    calleeRole: { type: String, enum: ['user', 'driver'], required: true },
    calleeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    provider: { type: String, default: 'none', trim: true },
    status: { type: String, default: '', trim: true },
    providerCallSid: { type: String, default: '', trim: true },
    error: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

rideCallLogSchema.index({ rideId: 1, createdAt: -1 });

export const RideCallLog = mongoose.models.TaxiRideCallLog || mongoose.model('TaxiRideCallLog', rideCallLogSchema);
