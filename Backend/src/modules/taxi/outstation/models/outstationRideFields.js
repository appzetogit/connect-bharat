import mongoose from 'mongoose';

/// Schema paths the outstation module adds to `Ride`.
///
/// They live here rather than inline in user/models/Ride.js because Ride.js is
/// edited by several workstreams at once; Ride.js spreads these two objects in
/// with one line each, so outstation changes never touch its body again.
///
/// Every path has a default that means "not an outstation concern", so rides of
/// every other service type - and every outstation ride booked before this
/// existed - read exactly as they did.

/// Added inside `Ride.intercity`.
export const outstationIntercityFields = {
  // Human label for `tripType` ('One Way', 'Round Trip', 'Multi Day'). The
  // web driver app has always printed tripType verbatim; now that tripType is
  // an enum code, this keeps a readable string next to it.
  tripTypeLabel: {
    type: String,
    default: '',
    trim: true,
  },
  // Pickup time, parsed from travelDate / startAt. travelDate stays the raw
  // string the app sent.
  startAt: {
    type: Date,
    default: null,
  },
  // When the rider wants to be back (round trip / multi-day).
  returnAt: {
    type: Date,
    default: null,
  },
  // Calendar days the vehicle is booked for, counted on the IST calendar.
  // One-way and same-day round trips are 1.
  days: {
    type: Number,
    default: 1,
    min: 1,
  },
  // Rates locked from the Set Price row at booking, so a later admin edit
  // does not move a trip already sold.
  driverAllowancePerDay: {
    type: Number,
    default: 0,
    min: 0,
  },
  nightAllowancePerNight: {
    type: Number,
    default: 0,
    min: 0,
  },
  // Tolls, parking, permits and state taxes the driver paid on the way, each
  // with a receipt photo. They are passed through to the rider at completion.
  tollsAndPermits: {
    type: [
      {
        type: {
          type: String,
          enum: ['toll', 'parking', 'permit', 'state_tax', 'other'],
          default: 'toll',
        },
        label: { type: String, default: '', trim: true, maxlength: 120 },
        amount: { type: Number, default: 0, min: 0 },
        receiptUrl: { type: String, default: '', trim: true, maxlength: 2048 },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  // Sum of the 'state_tax' entries above, kept as one figure for the invoice.
  stateTaxes: {
    type: Number,
    default: 0,
    min: 0,
  },
};

/// Added at the top level of `Ride`.
export const outstationRideFields = {
  // Mandatory advance for outstation (SOW 6.4 / 2.8). While `required` and
  // `status: 'pending'`, the ride sits in `searching` but dispatch will not
  // start (see outstation/services/advanceGate.js).
  advance: {
    required: { type: Boolean, default: false },
    amount: { type: Number, default: 0, min: 0 },
    type: { type: String, default: 'none', trim: true },
    value: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['none', 'pending', 'paid', 'waived', 'expired', 'refunded'],
      default: 'none',
    },
    provider: { type: String, default: '', trim: true },
    orderId: { type: String, default: '', trim: true },
    paymentId: { type: String, default: '', trim: true },
    paidAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0, min: 0 },
  },
  // Odometer readings the driver photographs at the start and end (SOW 6.5,
  // 6.7). The difference is the preferred source of actual km.
  odometer: {
    startReading: { type: Number, default: null },
    startPhoto: { type: String, default: '', trim: true },
    startAt: { type: Date, default: null },
    endReading: { type: Number, default: null },
    endPhoto: { type: String, default: '', trim: true },
    endAt: { type: Date, default: null },
  },
  // What the final fare came to against the booked one (SOW 6.5, 6.6, 6.8).
  // `applied: false` is a dry run: recorded so ops can compare, but the fare
  // the rider pays was not changed.
  fareAdjustment: {
    computedAt: { type: Date, default: null },
    applied: { type: Boolean, default: false },
    bookedFare: { type: Number, default: 0 },
    finalFare: { type: Number, default: 0 },
    actualKm: { type: Number, default: 0 },
    distanceSource: { type: String, default: '', trim: true },
    bookedKm: { type: Number, default: 0 },
    extraKm: { type: Number, default: 0 },
    extraKmCharge: { type: Number, default: 0 },
    extraTimeMinutes: { type: Number, default: 0 },
    extraTimeCharge: { type: Number, default: 0 },
    waitingMinutes: { type: Number, default: 0 },
    waitingCharge: { type: Number, default: 0 },
    extraDays: { type: Number, default: 0 },
    allowances: { type: Number, default: 0 },
    tollsTotal: { type: Number, default: 0 },
    stateTaxes: { type: Number, default: 0 },
    taxOnExtras: { type: Number, default: 0 },
    reason: { type: String, default: '', trim: true },
    // The booked quote, copied here because wallet settlement rewrites
    // pricingSnapshot after completion.
    bookedBreakdown: { type: mongoose.Schema.Types.Mixed, default: null },
  },
};
