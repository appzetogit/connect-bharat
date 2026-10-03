import mongoose from 'mongoose';

/// One webhook delivery from a gateway.
///
/// Gateways retry a webhook until they get a 2xx, and may deliver the same
/// event more than once even after one. The unique (provider, eventId) index
/// is what makes processing idempotent: the handler inserts first and only
/// acts when the insert wins.
const paymentEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, trim: true },
    eventId: { type: String, required: true, trim: true },
    event: { type: String, default: '', trim: true },
    // processing -> processed | ignored | failed | deferred. A failed event
    // is retried by the next delivery of the same event id; a deferred one
    // is settled by the sweeper once `processAfter` passes (see webhookService).
    status: {
      type: String,
      enum: ['received', 'processing', 'processed', 'ignored', 'failed', 'deferred'],
      default: 'received',
      index: true,
    },
    purpose: { type: String, default: '', trim: true },
    entityId: { type: String, default: '', trim: true },
    orderId: { type: String, default: '', trim: true },
    paymentId: { type: String, default: '', trim: true },
    amount: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    result: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: { type: String, default: '', trim: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    processAfter: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

paymentEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
paymentEventSchema.index({ paymentId: 1 });
paymentEventSchema.index({ createdAt: -1 });
paymentEventSchema.index({ status: 1, processAfter: 1 });

export const PaymentEvent =
  mongoose.models.TaxiPaymentEvent || mongoose.model('TaxiPaymentEvent', paymentEventSchema);
