import mongoose from 'mongoose';

/// The price list for hub-network shipments in one city and scope.
///
/// A card with no serviceLocationId is the fallback for every city that has
/// no card of its own for that scope. See shipmentPricing.js for how each
/// field is applied and in what order.
const rateCardSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    serviceLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation', default: null, index: true },
    scope: { type: String, enum: ['intracity', 'intercity', 'long_distance'], required: true, index: true },
    currency: { type: String, default: 'INR' },
    volumetricDivisor: { type: Number, default: 5000, min: 1 },
    weightStepKg: { type: Number, default: 0.5, min: 0.01 },
    /// Full price for a parcel up to `upToKg`; the SOW slabs are 0.5, 1, 2,
    /// 5 and 10kg, with `extraPerKg` for every started kg beyond the last.
    slabs: {
      type: [{ _id: false, upToKg: { type: Number, required: true }, price: { type: Number, required: true, min: 0 } }],
      default: [],
    },
    extraPerKg: { type: Number, default: 0, min: 0 },
    /// Intercity / long-distance: freight × multiplier + flat for the first
    /// band covering the distance.
    distanceBands: {
      type: [
        {
          _id: false,
          upToKm: { type: Number, required: true },
          multiplier: { type: Number, default: 1 },
          flat: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    minCharge: { type: Number, default: 0, min: 0 },
    expressAllowed: { type: Boolean, default: true },
    expressMultiplier: { type: Number, default: 1.5, min: 1 },
    fragileSurcharge: {
      type: { type: String, enum: ['flat', 'percent'], default: 'flat' },
      value: { type: Number, default: 0, min: 0 },
    },
    insurance: {
      percent: { type: Number, default: 0, min: 0 },
      min: { type: Number, default: 0, min: 0 },
      max: { type: Number, default: 0, min: 0 },
      maxDeclaredValue: { type: Number, default: 0, min: 0 },
    },
    codAllowed: { type: Boolean, default: true },
    codFee: {
      type: { type: String, enum: ['flat', 'percent'], default: 'flat' },
      value: { type: Number, default: 0, min: 0 },
      min: { type: Number, default: 0, min: 0 },
    },
    pickupCharge: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 18, min: 0 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

export const ParcelRateCard =
  mongoose.models.LogisticsParcelRateCard || mongoose.model('LogisticsParcelRateCard', rateCardSchema);
