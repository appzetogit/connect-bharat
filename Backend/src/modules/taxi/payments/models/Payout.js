import mongoose from 'mongoose';

/// A bank/UPI payout sent through RazorpayX for an approved withdrawal.
///
/// Kept separate from WithdrawalRequest so the payout webhook can find the
/// payout by its RazorpayX id with an index, and so a failed payout that is
/// retried keeps its history.
const payoutSchema = new mongoose.Schema(
  {
    provider: { type: String, default: 'razorpayx', trim: true },
    status: {
      type: String,
      // Mirrors RazorpayX: queued/pending/processing are all "in flight".
      enum: ['created', 'queued', 'pending', 'processing', 'processed', 'reversed', 'cancelled', 'rejected', 'failed'],
      default: 'created',
      index: true,
    },
    withdrawalRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiWithdrawalRequest', index: true },
    account: {
      type: { type: String, enum: ['driver', 'owner'], required: true },
      id: { type: String, required: true, trim: true },
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', trim: true },
    mode: { type: String, default: 'IMPS', trim: true },
    contactId: { type: String, default: '', trim: true },
    fundAccountId: { type: String, default: '', trim: true },
    payoutId: { type: String, default: '', trim: true, index: true },
    utr: { type: String, default: '', trim: true },
    idempotencyKey: { type: String, required: true, unique: true },
    failureReason: { type: String, default: '', trim: true },
    walletReversed: { type: Boolean, default: false },
    response: { type: mongoose.Schema.Types.Mixed, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

export const Payout = mongoose.models.TaxiPayout || mongoose.model('TaxiPayout', payoutSchema);
