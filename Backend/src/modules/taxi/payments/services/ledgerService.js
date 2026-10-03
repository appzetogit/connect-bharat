import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_CATEGORIES,
  LedgerEntry,
} from '../models/LedgerEntry.js';
import {
  buildIdempotencyKey,
  clampPagination,
  normalizePositiveAmount,
  roundMoney,
  toMinorUnits,
} from '../utils/paymentUtils.js';

/// Public API of the unified ledger. Other modules (corporate, rental,
/// outstation, hub) should write money movements through these functions,
/// never by inserting LedgerEntry documents directly, so idempotency and
/// validation stay in one place. See docs/api/payments.md.

const DUPLICATE_KEY = 11000;
const isDuplicateKeyError = (error) => error?.code === DUPLICATE_KEY || error?.cause?.code === DUPLICATE_KEY;

const newEntryId = () => `led_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;

const normalizeAccount = (account = {}) => {
  const type = String(account?.type || '').trim().toLowerCase();
  const id = String(account?.id ?? '').trim();
  if (!LEDGER_ACCOUNT_TYPES.includes(type)) {
    throw new ApiError(400, `Unknown ledger account type: ${type || '(empty)'}`);
  }
  if (!id) {
    throw new ApiError(400, 'Ledger account id is required');
  }
  return { type, id, wallet: String(account?.wallet || '').trim() };
};

const normalizeCategory = (category) => {
  const value = String(category || '').trim().toLowerCase();
  return LEDGER_CATEGORIES.includes(value) ? value : 'other';
};

const buildEntryDoc = ({
  account,
  direction,
  amount,
  currency = 'INR',
  balanceAfter = null,
  category,
  service = '',
  description = '',
  reference = {},
  gateway = {},
  idempotencyKey,
  transferId = '',
  source = '',
  metadata = {},
  createdBy = {},
}) => {
  const normalizedAmount = normalizePositiveAmount(amount);
  if (!normalizedAmount) {
    throw new ApiError(400, 'Ledger amount must be greater than zero');
  }
  const normalizedDirection = direction === 'debit' ? 'debit' : direction === 'credit' ? 'credit' : null;
  if (!normalizedDirection) {
    throw new ApiError(400, 'Ledger direction must be debit or credit');
  }
  if (!idempotencyKey) {
    throw new ApiError(400, 'Ledger idempotencyKey is required');
  }

  return {
    entryId: newEntryId(),
    transferId,
    account: normalizeAccount(account),
    direction: normalizedDirection,
    amount: normalizedAmount,
    amountMinor: toMinorUnits(normalizedAmount),
    currency: String(currency || 'INR').toUpperCase(),
    balanceAfter: Number.isFinite(Number(balanceAfter)) && balanceAfter !== null ? roundMoney(balanceAfter) : null,
    category: normalizeCategory(category),
    service: String(service || '').trim().toLowerCase(),
    description: String(description || '').trim().slice(0, 500),
    reference: {
      kind: String(reference?.kind || '').trim(),
      id: String(reference?.id ?? '').trim(),
    },
    gateway: {
      provider: String(gateway?.provider || '').trim(),
      orderId: String(gateway?.orderId || '').trim(),
      paymentId: String(gateway?.paymentId || '').trim(),
      refundId: String(gateway?.refundId || '').trim(),
      payoutId: String(gateway?.payoutId || '').trim(),
    },
    idempotencyKey: String(idempotencyKey),
    source: String(source || '').trim(),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdBy: {
      type: String(createdBy?.type || 'system'),
      id: String(createdBy?.id ?? ''),
    },
  };
};

/// Records a single ledger line. Idempotent on `idempotencyKey`: recording the
/// same key twice returns the first entry with `duplicate: true` instead of
/// throwing, so retries and webhook redeliveries are safe.
///
/// Pass `session` only when the caller wants the line to roll back with its
/// transaction. Note that a duplicate-key error inside a Mongo transaction
/// aborts that transaction, so with a session the duplicate check is done
/// with a read first.
///
/// @returns {Promise<{ entry: object, duplicate: boolean }>}
export const recordLedgerEntry = async (input = {}, { session = null } = {}) => {
  const doc = buildEntryDoc(input);

  if (session) {
    const existing = await LedgerEntry.findOne({ idempotencyKey: doc.idempotencyKey }).session(session).lean();
    if (existing) return { entry: existing, duplicate: true };
  }

  try {
    const [entry] = await LedgerEntry.create([doc], session ? { session } : {});
    return { entry: entry.toObject(), duplicate: false };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await LedgerEntry.findOne({ idempotencyKey: doc.idempotencyKey }).lean();
    return { entry: existing, duplicate: true };
  }
};

/// Records a double-entry transfer: `from` is debited and `to` is credited
/// with the same amount, linked by one transferId. The two lines use
/// `${idempotencyKey}:debit` and `${idempotencyKey}:credit`, so replaying a
/// transfer is a no-op and a half-written one (crash between the two inserts)
/// is completed by the replay.
///
/// @returns {Promise<{ transferId: string, debit: object, credit: object, duplicate: boolean }>}
export const recordTransfer = async (
  {
    from,
    to,
    amount,
    currency = 'INR',
    category,
    service = '',
    description = '',
    reference = {},
    gateway = {},
    idempotencyKey,
    source = '',
    metadata = {},
    createdBy = {},
    fromBalanceAfter = null,
    toBalanceAfter = null,
  } = {},
  { session = null } = {},
) => {
  if (!idempotencyKey) {
    throw new ApiError(400, 'Ledger idempotencyKey is required');
  }

  const transferId = `trf_${crypto.createHash('sha1').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`;
  const shared = { amount, currency, category, service, description, reference, gateway, transferId, source, metadata, createdBy };

  const debit = await recordLedgerEntry(
    { ...shared, account: from, direction: 'debit', balanceAfter: fromBalanceAfter, idempotencyKey: `${idempotencyKey}:debit` },
    { session },
  );
  const credit = await recordLedgerEntry(
    { ...shared, account: to, direction: 'credit', balanceAfter: toBalanceAfter, idempotencyKey: `${idempotencyKey}:credit` },
    { session },
  );

  return {
    transferId,
    debit: debit.entry,
    credit: credit.entry,
    duplicate: debit.duplicate && credit.duplicate,
  };
};

/// True while `session` is inside an uncommitted transaction.
const isInOpenTransaction = (session) => {
  try {
    return Boolean(session && typeof session.inTransaction === 'function' && session.inTransaction());
  } catch {
    return false;
  }
};

/// Called when the session ends. Skips only when the transaction is known to
/// have aborted: the driver moves a committed transaction to NO_TRANSACTION
/// as soon as the session runs any later non-transactional command, so
/// "not committed" alone would drop real payments from the ledger.
const didCommit = (session) => {
  const transaction = session?.transaction;
  if (!transaction) return true;
  if (transaction.isCommitted === true) return true;
  return !String(transaction.state || '').includes('ABORTED');
};

/// Runs `writer` and never throws. This is what the money-path hooks use:
/// the ledger is a mirror, and a ledger failure must never fail a payment,
/// a refund or a wallet credit.
///
/// When the money write happened inside a transaction, the ledger write is
/// deferred until that session ends and only runs if it committed, so an
/// aborted payment never leaves a ledger line behind (and the ledger insert
/// cannot abort the caller's transaction).
export const runLedgerWriteSafely = (label, writer, { session = null } = {}) => {
  const run = async () => {
    try {
      await writer();
    } catch (error) {
      console.error(`[ledger] ${label} failed:`, error?.message || error);
    }
  };

  if (isInOpenTransaction(session) && typeof session.once === 'function') {
    session.once('ended', () => {
      if (didCommit(session)) void run();
    });
    return Promise.resolve();
  }

  return run();
};

/// Safe single-entry write for hooks: same as recordLedgerEntry but never throws.
export const recordLedgerEntrySafe = (input, { session = null, label = 'entry' } = {}) =>
  runLedgerWriteSafely(label, () => recordLedgerEntry(input), { session });

/// Safe transfer write for hooks: same as recordTransfer but never throws.
export const recordTransferSafe = (input, { session = null, label = 'transfer' } = {}) =>
  runLedgerWriteSafely(label, () => recordTransfer(input), { session });

/// Corporate billing hook for the corporate module.
///
/// Records that a corporate account was charged `amount` (rupees) for a trip
/// or booking billed to its credit line: corporate is debited, platform is
/// credited. Idempotent per reference, so calling it again for the same
/// ride/booking returns the existing entry.
///
/// The corporate module owns the credit limit and invoice; this only writes
/// the ledger. Throws on bad input (unlike the hook helpers) because the
/// caller is billing code that should know when the charge was not recorded.
///
/// @param {{ corporateId: string, amount: number, reference: { kind: string, id: string },
///           description?: string, service?: string, metadata?: object, createdBy?: object,
///           idempotencyKey?: string, session?: object }} input
export const chargeCorporateAccount = async ({
  corporateId,
  amount,
  reference = {},
  description = '',
  service = 'corporate',
  metadata = {},
  createdBy = {},
  idempotencyKey = '',
  session = null,
} = {}) => {
  if (!corporateId) throw new ApiError(400, 'corporateId is required');
  if (!reference?.kind || !reference?.id) throw new ApiError(400, 'reference.kind and reference.id are required');

  const key = idempotencyKey || buildIdempotencyKey('corporate_charge', corporateId, reference.kind, reference.id);
  return recordTransfer(
    {
      from: { type: 'corporate', id: String(corporateId), wallet: 'credit' },
      to: { type: 'platform', id: 'platform' },
      amount,
      category: 'corporate_charge',
      service,
      description: description || `Corporate charge for ${reference.kind} ${reference.id}`,
      reference,
      idempotencyKey: key,
      source: 'corporate',
      metadata,
      createdBy,
    },
    { session },
  );
};

/// Reverses a corporate charge (cancelled trip, invoice correction).
export const creditCorporateAccount = async ({
  corporateId,
  amount,
  reference = {},
  description = '',
  service = 'corporate',
  metadata = {},
  createdBy = {},
  idempotencyKey = '',
  session = null,
} = {}) => {
  if (!corporateId) throw new ApiError(400, 'corporateId is required');
  if (!reference?.kind || !reference?.id) throw new ApiError(400, 'reference.kind and reference.id are required');

  const key = idempotencyKey || buildIdempotencyKey('corporate_credit', corporateId, reference.kind, reference.id);
  return recordTransfer(
    {
      from: { type: 'platform', id: 'platform' },
      to: { type: 'corporate', id: String(corporateId), wallet: 'credit' },
      amount,
      category: 'adjustment',
      service,
      description: description || `Corporate credit for ${reference.kind} ${reference.id}`,
      reference,
      idempotencyKey: key,
      source: 'corporate',
      metadata,
      createdBy,
    },
    { session },
  );
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/// Builds a Mongo filter from query-string style filters. Shared by the admin
/// ledger list and the user wallet history.
export const buildLedgerFilter = (filters = {}) => {
  const query = {};
  if (filters.accountType) query['account.type'] = String(filters.accountType);
  if (filters.accountId) query['account.id'] = String(filters.accountId);
  if (filters.wallet) query['account.wallet'] = String(filters.wallet);
  if (filters.category) {
    const categories = String(filters.category).split(',').map((item) => item.trim()).filter(Boolean);
    query.category = categories.length > 1 ? { $in: categories } : categories[0];
  }
  if (filters.direction) query.direction = String(filters.direction);
  if (filters.service) query.service = String(filters.service).toLowerCase();
  if (filters.referenceKind) query['reference.kind'] = String(filters.referenceKind);
  if (filters.referenceId) query['reference.id'] = String(filters.referenceId);
  if (filters.provider) query['gateway.provider'] = String(filters.provider);
  if (filters.paymentId) query['gateway.paymentId'] = String(filters.paymentId);
  if (filters.transferId) query.transferId = String(filters.transferId);
  if (filters.source) query.source = String(filters.source);

  const from = toDateOrNull(filters.from || filters.dateFrom);
  const to = toDateOrNull(filters.to || filters.dateTo);
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = from;
    if (to) query.createdAt.$lte = to;
  }

  if (filters.search) {
    const pattern = new RegExp(String(filters.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { description: pattern },
      { 'reference.id': pattern },
      { 'gateway.paymentId': pattern },
      { 'gateway.orderId': pattern },
      { 'account.id': pattern },
      { entryId: pattern },
    ];
  }

  return query;
};

export const serializeLedgerEntry = (entry = {}) => ({
  _id: entry._id ? String(entry._id) : undefined,
  entryId: entry.entryId,
  transferId: entry.transferId || '',
  account: entry.account,
  direction: entry.direction,
  amount: Number(entry.amount || 0),
  amountMinor: Number(entry.amountMinor || 0),
  currency: entry.currency || 'INR',
  balanceAfter: entry.balanceAfter ?? null,
  category: entry.category,
  service: entry.service || '',
  description: entry.description || '',
  reference: entry.reference || {},
  gateway: entry.gateway || {},
  source: entry.source || '',
  metadata: entry.metadata || {},
  createdBy: entry.createdBy || {},
  createdAt: entry.createdAt,
});

/// Paginated ledger listing.
export const listLedgerEntries = async (filters = {}) => {
  const { page, limit, skip } = clampPagination(filters, { defaultLimit: 50, maxLimit: 200 });
  const query = buildLedgerFilter(filters);

  const [items, total, totals] = await Promise.all([
    LedgerEntry.find(query).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    LedgerEntry.countDocuments(query),
    LedgerEntry.aggregate([
      { $match: query },
      { $group: { _id: '$direction', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
  ]);

  const totalsByDirection = Object.fromEntries(
    totals.map((row) => [row._id, { amount: Math.round(row.amountMinor) / 100, count: row.count }]),
  );

  return {
    results: items.map(serializeLedgerEntry),
    totals: {
      credit: totalsByDirection.credit || { amount: 0, count: 0 },
      debit: totalsByDirection.debit || { amount: 0, count: 0 },
    },
    paginator: {
      current_page: page,
      per_page: limit,
      total,
      last_page: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

/// Converts an id-ish value to string for account ids, accepting ObjectIds.
export const toAccountId = (value) => {
  if (!value) return '';
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};
