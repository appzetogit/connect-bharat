import mongoose from 'mongoose';

/**
 * One daily pass a driver bought: what they paid, how they paid, and the
 * window it covers.
 *
 * The window is stored rather than derived, so a change to the cycle hour
 * later never moves a pass somebody already paid for.
 *
 * `status` is written when the pass is created and when it is refunded or
 * cancelled; expiry is not a status change but a comparison against
 * `expiresAt`, so nothing has to run at 6am for a pass to lapse.
 */
const driverSubscriptionSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiDriver',
      required: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiSubscriptionPlan',
      default: null,
    },
    planName: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 },
    // The vehicle classes this pass covers, e.g. ['bike','auto'] or ['car'].
    // Copied from the plan at purchase so editing a plan cannot change what
    // someone already paid for.
    vehicleClasses: { type: [String], default: [] },

    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ['active', 'cancelled', 'refunded'],
      default: 'active',
      index: true,
    },

    paymentMethod: {
      type: String,
      enum: ['wallet', 'razorpay', 'phonepe', 'admin', 'bonus'],
      required: true,
    },
    // Gateway order/payment id, or the wallet transaction id.
    paymentReference: { type: String, default: '' },
    // Set while a gateway payment is still unconfirmed; an unpaid row never
    // counts as cover.
    paidAt: { type: Date, default: null },

    // What the pass was worth in practice, for the admin history: trips taken
    // and commission not charged while it was active.
    tripsCovered: { type: Number, default: 0 },
    commissionWaived: { type: Number, default: 0 },

    // Set (atomically, by whichever server instance gets there first) when the
    // "your subscription has ended" push is sent, so the four instances never
    // notify the same driver twice for the same pass.
    expiryNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The lookup on every ride offer and settlement: this driver, paid, covering
// now.
driverSubscriptionSchema.index({ driverId: 1, status: 1, paidAt: 1, expiresAt: -1 });

export const DriverSubscription =
  mongoose.models.TaxiDriverSubscription ||
  mongoose.model('TaxiDriverSubscription', driverSubscriptionSchema);
