import mongoose from 'mongoose';

/// A gateway order we created and expect to be paid, plus the settlement
/// claim for it.
///
/// Two jobs:
///  1. PhonePe webhooks carry only the merchant order id, which does not
///     contain the full user/driver id. Remembering the order at creation
///     time is how a webhook finds whose wallet to credit.
///  2. Settlement claim. The client verify call, the redirect callback and
///     the webhook can all arrive for the same payment, concurrently. The
///     unique (provider, orderId) index plus a conditional update on `status`
///     lets exactly one of them settle; the others see `paid` and return the
///     existing result.
const paymentOrderSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, trim: true },
    // Razorpay order id / PhonePe merchant order id. For Razorpay payments
    // without an order (payment links) this is `pay:<paymentId>`.
    orderId: { type: String, required: true, trim: true },
    purpose: { type: String, default: '', trim: true },
    owner: {
      type: { type: String, default: '', trim: true },
      id: { type: String, default: '', trim: true },
    },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'INR', trim: true },
    status: {
      type: String,
      enum: ['created', 'settling', 'paid', 'failed'],
      default: 'created',
      index: true,
    },
    paymentId: { type: String, default: '', trim: true, index: true },
    settledVia: { type: String, default: '', trim: true },
    settledAt: { type: Date, default: null },
    lastError: { type: String, default: '', trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

paymentOrderSchema.index({ provider: 1, orderId: 1 }, { unique: true });

export const PaymentOrder =
  mongoose.models.TaxiPaymentOrder || mongoose.model('TaxiPaymentOrder', paymentOrderSchema);
