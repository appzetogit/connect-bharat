import mongoose from 'mongoose';
import { driverWalletTransactionLedgerPlugin } from '../../payments/plugins/walletLedgerPlugins.js';

const walletTransactionSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiDriver',
      required: true,
      index: true,
    },
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRide',
      default: null,
      index: true,
    },
    type: {
      type: String,
      // 'withdrawal' is used for withdrawals approved from now on; older
      // withdrawals were written as 'adjustment' and stay readable as such.
      enum: ['ride_earning', 'commission_deduction', 'top_up', 'adjustment', 'subscription_purchase', 'withdrawal'],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    cashLimit: {
      type: Number,
      required: true,
    },
    isBlockedAfter: {
      type: Boolean,
      required: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

walletTransactionSchema.index({ driverId: 1, createdAt: -1 });
/// Mirrors every driver wallet movement into the unified ledger.
walletTransactionSchema.plugin(driverWalletTransactionLedgerPlugin);

export const WalletTransaction =
  mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', walletTransactionSchema);
