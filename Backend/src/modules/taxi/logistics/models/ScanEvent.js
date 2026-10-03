import mongoose from 'mongoose';

/// The custody log: one row per physical touch of a parcel. Append-only by
/// convention (nothing in the module updates or deletes a row), so the
/// public timeline, the dwell-time report and any dispute about who last
/// held a parcel all read the same history.
export const SCAN_EVENT_TYPES = [
  'booked',
  'pickup',
  'inbound',
  'outbound',
  'manifest_add',
  'manifest_remove',
  'out_for_delivery',
  'delivered',
  'failed',
  'rto',
  'exception',
  'cancelled',
  'rescheduled',
  'leg_assigned',
];

const scanEventSchema = new mongoose.Schema(
  {
    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsShipment', required: true, index: true },
    awb: { type: String, required: true, index: true },
    hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHubStaff', default: null },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null },
    /// 'hub_staff' | 'driver' | 'customer' | 'admin' | 'system'
    actorType: { type: String, default: 'system' },
    type: { type: String, enum: SCAN_EVENT_TYPES, required: true },
    fromStatus: { type: String, default: '' },
    toStatus: { type: String, default: '' },
    manifestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsManifest', default: null },
    location: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    note: { type: String, default: '', trim: true },
    reasonCode: { type: String, default: '' },
    photo: { type: String, default: '' },
    discrepancy: { type: Boolean, default: false },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

scanEventSchema.index({ hubId: 1, at: -1 });
scanEventSchema.index({ shipmentId: 1, at: 1 });

export const ScanEvent = mongoose.models.LogisticsScanEvent || mongoose.model('LogisticsScanEvent', scanEventSchema);
