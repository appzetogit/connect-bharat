import mongoose from 'mongoose';
import { SHIPMENT_STATUSES } from '../services/shipmentStateMachine.js';

/// A hub-network parcel. Distinct from the single-driver `Ride`/`Delivery`
/// parcel, which stays the fast path for same-city express work; a shipment
/// may still use taxi rides for its first and last mile (see `rideIds`).
const partySchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    landmark: { type: String, default: '', trim: true },
    pincode: { type: String, default: '', trim: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
  },
  { _id: false },
);

const attemptSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true },
    legId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsShipmentLeg', default: null },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null },
    outAt: { type: Date, default: null },
    result: { type: String, enum: ['pending', 'delivered', 'failed'], default: 'pending' },
    reasonCode: { type: String, default: '' },
    note: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const shipmentSchema = new mongoose.Schema(
  {
    awb: { type: String, required: true, unique: true, uppercase: true, trim: true },
    /// What the label QR encodes (tracking URL or bare AWB). The Code128
    /// barcode always encodes the bare AWB.
    qrPayload: { type: String, default: '' },
    bookingUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', default: null, index: true },
    bookedVia: { type: String, enum: ['app', 'hub_counter', 'admin'], default: 'app' },
    sender: { type: partySchema, required: true },
    receiver: { type: partySchema, required: true },
    /// 'pickup': a first-mile driver collects from the sender.
    /// 'drop_at_hub': the sender walks it into the origin hub.
    pickupMode: { type: String, enum: ['pickup', 'drop_at_hub'], default: 'pickup' },
    originHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null, index: true },
    destinationHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null, index: true },
    /// Where the parcel physically is right now; null while it is on a
    /// vehicle between hubs or with a driver.
    currentHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null, index: true },
    currentManifestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsManifest', default: null },
    serviceLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation', default: null },
    scope: { type: String, enum: ['intracity', 'intercity', 'long_distance'], required: true },
    distanceKm: { type: Number, default: 0 },
    weightKg: { type: Number, required: true, min: 0 },
    dimensions: {
      l: { type: Number, default: 0 },
      w: { type: Number, default: 0 },
      h: { type: Number, default: 0 },
    },
    volumetricWeight: { type: Number, default: 0 },
    chargeableWeight: { type: Number, default: 0 },
    sizeCategory: { type: String, default: '' },
    goodsTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiGoodsType', default: null },
    description: { type: String, default: '', trim: true },
    instructions: { type: String, default: '', trim: true },
    fragile: { type: Boolean, default: false },
    express: { type: Boolean, default: false },
    declaredValue: { type: Number, default: 0, min: 0 },
    insurance: {
      opted: { type: Boolean, default: false },
      premium: { type: Number, default: 0 },
      coverAmount: { type: Number, default: 0 },
    },
    scheduledPickupAt: { type: Date, default: null },
    pickupSlot: {
      slot: { type: String, default: '' },
      startsAt: { type: Date, default: null },
      endsAt: { type: Date, default: null },
    },
    rateCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsParcelRateCard', default: null },
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    payment: {
      /// online: paid in the app before pickup. cash: sender pays the pickup
      /// driver / hub counter. cod: receiver pays on delivery.
      method: { type: String, enum: ['online', 'cash', 'cod'], default: 'cash' },
      status: { type: String, enum: ['pending', 'paid', 'refunded', 'failed'], default: 'pending' },
      amount: { type: Number, default: 0 },
      paidAt: { type: Date, default: null },
      reference: { type: String, default: '' },
      codCollectedAmount: { type: Number, default: 0 },
      codCollectedAt: { type: Date, default: null },
      codCollectedByHubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null },
    },
    status: { type: String, enum: SHIPMENT_STATUSES, default: 'booked', index: true },
    statusUpdatedAt: { type: Date, default: Date.now },
    slaDueAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
    rtoReason: { type: String, default: '' },
    reattemptAt: { type: Date, default: null },
    attempts: { type: [attemptSchema], default: [] },
    legs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsShipmentLeg' }],
    rideIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRide' }],
    /// Inbound re-weigh found the parcel heavier/lighter than booked by more
    /// than the tolerance. Flagged for the hub/admin; never auto-charged.
    weightDiscrepancy: {
      flagged: { type: Boolean, default: false },
      bookedChargeableKg: { type: Number, default: 0 },
      measuredChargeableKg: { type: Number, default: 0 },
      measuredWeightKg: { type: Number, default: 0 },
      hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'LogisticsHub', default: null },
      at: { type: Date, default: null },
      resolved: { type: Boolean, default: false },
    },
    deliveryOtp: {
      hash: { type: String, default: '', select: false },
      sentAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
      verifiedAt: { type: Date, default: null },
    },
    proofOfDelivery: {
      photo: { type: String, default: '' },
      signature: { type: String, default: '' },
      receivedBy: { type: String, default: '' },
      otpVerified: { type: Boolean, default: false },
      at: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

shipmentSchema.index({ 'sender.phone': 1 });
shipmentSchema.index({ 'receiver.phone': 1 });
shipmentSchema.index({ currentHubId: 1, status: 1 });
shipmentSchema.index({ createdAt: -1 });

export const Shipment = mongoose.models.LogisticsShipment || mongoose.model('LogisticsShipment', shipmentSchema);
