import mongoose from 'mongoose';

/// One line of the unified money ledger.
///
/// Before this collection, money movements were split across seven places
/// (embedded UserWallet.transactions capped at 50, driver WalletTransaction,
/// OwnerWalletTransaction, WithdrawalRequest, BusBooking.payment, ride payment
/// collections, gateway dashboards). The ledger mirrors all of them in one
/// append-only shape so reports and audits read one collection.
///
/// Units: `amount` is rupees with two decimals (the unit used everywhere else
/// in this codebase); `amountMinor` is the same value in integer paise and is
/// what aggregations sum. Always positive — the sign is in `direction`.
///
/// `direction` is from the point of view of `account`: a `credit` increases
/// what the platform owes that account (user/driver/owner wallet up), a
/// `debit` decreases it. A double-entry transfer is two rows sharing a
/// `transferId`, one debit and one credit for the same amount.
export const LEDGER_ACCOUNT_TYPES = ['user', 'driver', 'owner', 'corporate', 'platform', 'gateway'];
export const LEDGER_DIRECTIONS = ['debit', 'credit'];
export const LEDGER_CATEGORIES = [
  'ride_fare',
  'commission',
  'tip',
  'wallet_topup',
  'wallet_credit',
  'wallet_debit',
  'wallet_transfer',
  'refund',
  'cancellation_fee',
  'withdrawal',
  'withdrawal_reversal',
  'payout',
  'payout_reversal',
  'deposit_hold',
  'deposit_release',
  'corporate_invoice',
  'corporate_charge',
  'subscription',
  'rental_payment',
  'bus_booking',
  'gateway_collection',
  'referral_bonus',
  'bonus',
  'adjustment',
  'other',
];

const ledgerEntrySchema = new mongoose.Schema(
  {
    entryId: { type: String, required: true, unique: true },
    transferId: { type: String, default: '', index: true },
    account: {
      type: { type: String, enum: LEDGER_ACCOUNT_TYPES, required: true },
      // ObjectId for user/driver/owner/corporate; a fixed label for platform
      // ('platform') and gateway ('razorpay', 'phonepe', 'razorpayx').
      id: { type: String, required: true, trim: true },
      // Which balance on the account moved: 'balance' or 'refundWallet' for
      // users, 'wallet' for drivers/owners, 'credit' for corporates.
      wallet: { type: String, default: '', trim: true },
    },
    direction: { type: String, enum: LEDGER_DIRECTIONS, required: true },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', uppercase: true, trim: true },
    balanceAfter: { type: Number, default: null },
    category: { type: String, enum: LEDGER_CATEGORIES, default: 'other', index: true },
    // Which service the money belongs to, for per-service reports:
    // ride, parcel, intercity, rental, bus, pooling, wallet, subscription, corporate...
    service: { type: String, default: '', trim: true, index: true },
    description: { type: String, default: '', trim: true },
    reference: {
      kind: { type: String, default: '', trim: true },
      id: { type: String, default: '', trim: true },
    },
    gateway: {
      provider: { type: String, default: '', trim: true },
      orderId: { type: String, default: '', trim: true },
      paymentId: { type: String, default: '', trim: true },
      refundId: { type: String, default: '', trim: true },
      payoutId: { type: String, default: '', trim: true },
    },
    // Unique: the same business event recorded twice (webhook + client
    // verify, a retried hook) collapses to one row.
    idempotencyKey: { type: String, required: true, unique: true },
    // Where this row came from: 'hook:user_wallet', 'hook:driver_wallet',
    // 'refund_service', 'payout_service', 'webhook', 'corporate', 'manual'...
    source: { type: String, default: '', trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: {
      type: { type: String, default: 'system', trim: true },
      id: { type: String, default: '', trim: true },
    },
  },
  { timestamps: true, minimize: false },
);

ledgerEntrySchema.index({ 'account.type': 1, 'account.id': 1, createdAt: -1 });
ledgerEntrySchema.index({ 'reference.kind': 1, 'reference.id': 1 });
ledgerEntrySchema.index({ 'gateway.paymentId': 1 });
ledgerEntrySchema.index({ createdAt: -1 });

export const LedgerEntry =
  mongoose.models.TaxiLedgerEntry || mongoose.model('TaxiLedgerEntry', ledgerEntrySchema);
