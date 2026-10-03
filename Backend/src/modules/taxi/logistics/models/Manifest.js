import mongoose from 'mongoose';

/// A bag or truck load of shipments moving hub to hub. Reconciled on
/// receipt: anything expected but not scanned in, scanned in but not
/// expected, or a broken seal is recorded as a discrepancy.
const manifestSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    fromHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', required: true, index: true },
    toHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', required: true, index: true },
    shipmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsShipment' }],
    /// Filled by inbound scans at the receiving hub before the manifest is
    /// closed out, so a hub can scan parcels as they come off the truck.
    receivedShipmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsShipment' }],
    vehicle: {
      number: { type: String, default: '', trim: true },
      type: { type: String, default: '', trim: true },
    },
    driver: {
      driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null },
      name: { type: String, default: '', trim: true },
      phone: { type: String, default: '', trim: true },
    },
    sealNumber: { type: String, default: '', trim: true },
    sealedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['created', 'dispatched', 'in_transit', 'received', 'closed'],
      default: 'created',
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHubStaff', default: null },
    dispatchedAt: { type: Date, default: null },
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHubStaff', default: null },
    receivedAt: { type: Date, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHubStaff', default: null },
    closedAt: { type: Date, default: null },
    discrepancies: {
      type: [
        {
          _id: false,
          type: { type: String, enum: ['missing', 'extra', 'seal_mismatch', 'damaged'], required: true },
          shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsShipment', default: null },
          awb: { type: String, default: '' },
          note: { type: String, default: '' },
          resolved: { type: Boolean, default: false },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const Manifest = mongoose.models.LogisticsManifest || mongoose.model('LogisticsManifest', manifestSchema);
