import mongoose from 'mongoose';

/// MERGE NOTE: stand-in for the unified ledger another agent is building at
/// `payments/services/ledgerService.js`. When that lands, `corporateLedger.js`
/// should delegate to it and this collection can be migrated into it.
///
/// One row per movement on a company's credit account: a charge (trip billed)
/// raises the outstanding, a payment or reversal lowers it. The
/// (corporateId, kind, reference) unique index is what makes charging a
/// completed ride idempotent across retries and server instances.
const corporateLedgerEntrySchema = new mongoose.Schema(
  {
    corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCorporate', required: true, index: true },
    kind: { type: String, enum: ['charge', 'payment', 'reversal', 'adjustment'], required: true },
    /// Positive raises the outstanding, negative lowers it.
    amount: { type: Number, required: true },
    reference: {
      type: { type: String, default: '' },
      id: { type: String, default: '' },
    },
    description: { type: String, default: '' },
    balanceAfter: { type: Number, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

corporateLedgerEntrySchema.index(
  { corporateId: 1, kind: 1, 'reference.type': 1, 'reference.id': 1 },
  { unique: true, partialFilterExpression: { 'reference.id': { $gt: '' } } },
);
corporateLedgerEntrySchema.index({ corporateId: 1, createdAt: -1 });

export const CorporateLedgerEntry =
  mongoose.models.TaxiCorporateLedgerEntry || mongoose.model('TaxiCorporateLedgerEntry', corporateLedgerEntrySchema);
