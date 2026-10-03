import mongoose from 'mongoose';
import { ownerWalletTransactionLedgerPlugin } from '../../payments/plugins/walletLedgerPlugins.js';

const ownerWalletTransactionSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiOwner',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    kind: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    balance: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true },
);

/// Mirrors every owner wallet movement into the unified ledger.
ownerWalletTransactionSchema.plugin(ownerWalletTransactionLedgerPlugin);

export const OwnerWalletTransaction = mongoose.model('TaxiOwnerWalletTransaction', ownerWalletTransactionSchema);