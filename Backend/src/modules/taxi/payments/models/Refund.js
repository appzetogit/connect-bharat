import mongoose from 'mongoose';

/// A refund owed to a customer, from request to settlement.
///
/// Every cancel path that owes money creates one of these. With
/// `payments.auto_refund_enabled` off (the default) it stays `requested`
/// until an admin approves it; with it on, it moves straight to
/// `processing` (gateway call made) and then `processed`/`failed` from the
/// gateway response or the refund webhook.
export const REFUND_STATUSES = ['requested', 'processing', 'processed', 'failed', 'rejected'];

const refundSchema = new mongoose.Schema(
  {
    refundNumber: { type: String, required: true, unique: true },
    status: { type: String, enum: REFUND_STATUSES, default: 'requested', index: true },
    // 'razorpay' | 'phonepe' | 'wallet'. 'wallet' credits the user wallet
    // (or refundWallet) instead of sending money back to the card/UPI.
    provider: { type: String, required: true, trim: true },
    destination: { type: String, enum: ['source', 'wallet', 'refund_wallet'], default: 'source' },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', trim: true },
    reason: { type: String, default: '', trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', default: null, index: true },
    reference: {
      // ride | delivery | pooling_booking | bus_booking | rental_booking | manual ...
      kind: { type: String, default: '', trim: true },
      id: { type: String, default: '', trim: true },
    },
    service: { type: String, default: '', trim: true },
    gateway: {
      paymentId: { type: String, default: '', trim: true },
      orderId: { type: String, default: '', trim: true },
      refundId: { type: String, default: '', trim: true },
      status: { type: String, default: '', trim: true },
      response: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    idempotencyKey: { type: String, required: true, unique: true },
    ledgerEntryIds: { type: [String], default: [] },
    initiatedBy: {
      type: { type: String, default: 'system', trim: true },
      id: { type: String, default: '', trim: true },
    },
    approvedBy: { type: String, default: '', trim: true },
    approvedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    failureReason: { type: String, default: '', trim: true },
    attempts: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

refundSchema.index({ 'reference.kind': 1, 'reference.id': 1 });
refundSchema.index({ 'gateway.refundId': 1 });
refundSchema.index({ 'gateway.paymentId': 1 });
refundSchema.index({ createdAt: -1 });

export const Refund = mongoose.models.TaxiRefund || mongoose.model('TaxiRefund', refundSchema);
