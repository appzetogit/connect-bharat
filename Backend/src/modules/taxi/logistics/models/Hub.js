import mongoose from 'mongoose';

/// A parcel hub: a physical sorting point that receives, holds and
/// dispatches shipments. `type` says which legs it may serve; nearest-hub
/// assignment at booking only picks hubs whose type allows that end.
const hubSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['origin', 'transit', 'destination', 'any'],
      default: 'any',
    },
    /// Three letters printed in AWBs booked through this hub (BLR, DEL ...).
    /// Falls back to the hub code when blank.
    cityCode: { type: String, default: '', uppercase: true, trim: true },
    serviceLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation', default: null, index: true },
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiZone', default: null },
    address: { type: String, default: '', trim: true },
    contactPhone: { type: String, default: '', trim: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    /// Local-time opening hours per weekday (0 = Sunday). Informational for
    /// apps and the panel; scans are accepted at any hour.
    operatingHours: {
      type: [
        {
          _id: false,
          day: { type: Number, min: 0, max: 6 },
          open: { type: String, default: '09:00' },
          close: { type: String, default: '21:00' },
          closed: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    /// Parcels the hub can hold at once; the dashboard shows utilisation.
    capacity: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    managerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHubStaff' }],
  },
  { timestamps: true },
);

hubSchema.index({ location: '2dsphere' });

export const Hub = mongoose.models.LogisticsHub || mongoose.model('LogisticsHub', hubSchema);
