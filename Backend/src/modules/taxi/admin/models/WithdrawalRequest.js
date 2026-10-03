import mongoose from 'mongoose';

const withdrawalRequestSchema = new mongoose.Schema({
  transactionId: String,
  driver_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver' },
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiOwner' },
  amount: Number,
  payment_method: String,
  bank_details_snapshot: {
    accountHolderName: {
      type: String,
      default: '',
      trim: true,
    },
    upiId: {
      type: String,
      default: '',
      trim: true,
    },
    qrCodeImage: {
      type: String,
      default: '',
      trim: true,
    },
    accountNumber: {
      type: String,
      default: '',
      trim: true,
    },
    ifsc: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
    },
    branchName: {
      type: String,
      default: '',
      trim: true,
    },
    updatedAt: {
      type: Date,
      default: null,
    },
  },
  // processing/failed only occur with payments.payout_mode = 'razorpayx':
  // processing while the bank payout is in flight, failed when it bounced
  // (the amount is then back in the wallet).
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'], default: 'pending' },
  payout: {
    provider: { type: String, default: '' },
    payoutId: { type: String, default: '' },
    status: { type: String, default: '' },
    utr: { type: String, default: '' },
    failureReason: { type: String, default: '' },
    processedAt: { type: Date, default: null },
  },
}, { timestamps: true });

export const WithdrawalRequest = mongoose.models.TaxiWithdrawalRequest || mongoose.model('TaxiWithdrawalRequest', withdrawalRequestSchema);
