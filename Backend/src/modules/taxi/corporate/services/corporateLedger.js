import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateLedgerEntry } from '../models/CorporateLedgerEntry.js';
import { round2 } from './corporatePolicyEngine.js';
import {
  chargeCorporateAccount as chargeSharedLedger,
  creditCorporateAccount as creditSharedLedger,
} from '../../payments/services/ledgerService.js';

/// Corporate credit accounting. Entries live in `CorporateLedgerEntry`, which
/// drives `Corporate.currentOutstanding` and the aging report; every posted
/// entry is also mirrored into the shared payments ledger for finance reports.
///
/// Written without transactions on purpose: production runs a standalone
/// mongod. The entry is inserted first and its unique (kind, reference) index
/// is the idempotency guard; the outstanding is only moved by whichever caller
/// inserted the entry. `recomputeCorporateOutstanding` repairs the cached
/// figure from the entries if a process died between the two writes.

const normalizeReference = (reference) => {
  if (!reference) return { type: '', id: '' };
  if (typeof reference === 'string') {
    const [type, ...rest] = reference.split(':');
    return rest.length ? { type, id: rest.join(':') } : { type: 'manual', id: reference };
  }
  return { type: String(reference.type || ''), id: String(reference.id || '') };
};

const isDuplicateKeyError = (error) => error?.code === 11000;

const postEntry = async ({ corporateId, kind, amount, reference, description = '', metadata = {} }) => {
  if (!mongoose.Types.ObjectId.isValid(String(corporateId))) {
    throw new ApiError(400, 'corporateId is invalid');
  }
  const signedAmount = round2(amount);
  if (!signedAmount) return { entry: null, duplicate: false, skipped: true };

  const ref = normalizeReference(reference);
  let entry;
  try {
    entry = await CorporateLedgerEntry.create({
      corporateId,
      kind,
      amount: signedAmount,
      reference: ref,
      description,
      metadata,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await CorporateLedgerEntry.findOne({
        corporateId,
        kind,
        'reference.type': ref.type,
        'reference.id': ref.id,
      }).lean();
      return { entry: existing, duplicate: true };
    }
    throw error;
  }

  const corporate = await Corporate.findByIdAndUpdate(
    corporateId,
    { $inc: { currentOutstanding: signedAmount } },
    { returnDocument: 'after', projection: { currentOutstanding: 1 } },
  ).lean();

  if (corporate) {
    await CorporateLedgerEntry.updateOne(
      { _id: entry._id },
      { $set: { balanceAfter: round2(corporate.currentOutstanding) } },
    );
  }

  await mirrorToSharedLedger({ corporateId, kind, amount: signedAmount, reference: ref, description, metadata });

  return { entry: entry.toObject(), duplicate: false, balance: corporate ? round2(corporate.currentOutstanding) : null };
};

/// Copies a posted entry into the platform-wide ledger (payments/), so finance
/// reports see corporate billing next to every other movement. The local
/// CorporateLedgerEntry stays the source of truth for outstanding and aging;
/// a failure here is logged, never thrown, so it cannot undo a posted charge.
const mirrorToSharedLedger = async ({ corporateId, kind, amount, reference, description, metadata }) => {
  try {
    const sharedReference = { kind: reference.type || kind, id: reference.id || `${kind}:${Date.now()}` };
    const input = {
      corporateId: String(corporateId),
      amount: Math.abs(amount),
      reference: sharedReference,
      description,
      metadata: { ...metadata, corporateLedgerKind: kind },
    };
    if (amount > 0) {
      await chargeSharedLedger(input);
    } else {
      await creditSharedLedger(input);
    }
  } catch (error) {
    console.error('[corporate] shared ledger mirror failed:', error?.message || error);
  }
};

/// Bill an amount to the company's credit account. Idempotent per reference.
export const chargeCorporateAccount = async ({ corporateId, amount, reference, description = 'Trip charge', metadata = {} }) =>
  postEntry({ corporateId, kind: 'charge', amount: Math.abs(Number(amount) || 0), reference, description, metadata });

/// A payment received against the account (lowers the outstanding).
export const recordCorporatePayment = async ({ corporateId, amount, reference, description = 'Payment received', metadata = {} }) =>
  postEntry({ corporateId, kind: 'payment', amount: -Math.abs(Number(amount) || 0), reference, description, metadata });

/// Undo an earlier charge (e.g. a voided invoice's tax add-on).
export const reverseCorporateCharge = async ({ corporateId, amount, reference, description = 'Reversal', metadata = {} }) =>
  postEntry({ corporateId, kind: 'reversal', amount: -Math.abs(Number(amount) || 0), reference, description, metadata });

/// Admin correction in either direction.
export const adjustCorporateAccount = async ({ corporateId, amount, reference, description = 'Adjustment', metadata = {} }) =>
  postEntry({ corporateId, kind: 'adjustment', amount: Number(amount) || 0, reference, description, metadata });

export const listCorporateLedger = async ({ corporateId, page = 1, limit = 50 }) => {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const [items, total] = await Promise.all([
    CorporateLedgerEntry.find({ corporateId })
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    CorporateLedgerEntry.countDocuments({ corporateId }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
};

/// Rebuilds `currentOutstanding` from the entries.
export const recomputeCorporateOutstanding = async (corporateId) => {
  const [row] = await CorporateLedgerEntry.aggregate([
    { $match: { corporateId: new mongoose.Types.ObjectId(String(corporateId)) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const outstanding = round2(row?.total || 0);
  await Corporate.updateOne({ _id: corporateId }, { $set: { currentOutstanding: outstanding } });
  return outstanding;
};
