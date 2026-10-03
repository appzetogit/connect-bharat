import mongoose from 'mongoose';

/// One movement of a shipment: sender → origin hub (first_mile), hub → hub
/// (linehaul, on a manifest), destination hub → receiver (last_mile), and
/// origin hub → sender for a returned parcel (rto_last_mile). A first/last
/// mile leg done by a taxi driver carries the parcel Ride it was dispatched
/// as, which is how ride completion finds its way back to the shipment.
const placeSchema = new mongoose.Schema(
  {
    address: { type: String, default: '' },
    coordinates: { type: [Number], default: undefined },
  },
  { _id: false },
);

const shipmentLegSchema = new mongoose.Schema(
  {
    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsShipment', required: true, index: true },
    awb: { type: String, default: '', index: true },
    type: { type: String, enum: ['first_mile', 'linehaul', 'last_mile', 'rto_last_mile'], required: true },
    fromHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null },
    fromAddress: { type: placeSchema, default: null },
    toHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null },
    toAddress: { type: placeSchema, default: null },
    /// 'taxi_dispatch' (auto, via the ride dispatcher), 'manual_driver' (hub
    /// picked an online driver), 'hub_staff' (hub's own runner), 'manifest'.
    assignmentMode: { type: String, default: '' },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null, index: true },
    assignee: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
    },
    vehicle: {
      vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle', default: null },
      number: { type: String, default: '' },
      type: { type: String, default: '' },
    },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRide', default: null, index: true },
    manifestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsManifest', default: null },
    fare: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    scheduledAt: { type: Date, default: null },
    assignedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHubStaff', default: null },
  },
  { timestamps: true },
);

export const ShipmentLeg = mongoose.models.LogisticsShipmentLeg || mongoose.model('LogisticsShipmentLeg', shipmentLegSchema);
