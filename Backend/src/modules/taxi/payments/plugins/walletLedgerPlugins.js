import crypto from 'node:crypto';
import {
  classifyDriverWalletTransaction,
  classifyUserWalletTransaction,
  normalizePositiveAmount,
} from '../utils/paymentUtils.js';

/// Mongoose plugins that mirror every wallet movement into the unified ledger.
///
/// Why plugins rather than a call at each money path: the user wallet alone
/// is written from a dozen places across userController, rideController,
/// dispatchService, rideService, subscriptionService and adminService, and new
/// ones keep appearing. Hooking the model catches all of them — including
/// future ones — with no edits to those hot files, and with zero change in
/// behaviour: the hooks only read what was written and never throw.
///
/// The ledger service is imported lazily so these model files do not pull the
/// payments module (and its imports) in at load time, and so there is no
/// import cycle between models and services.

let ledgerModulePromise = null;
const loadLedger = () => {
  ledgerModulePromise = ledgerModulePromise || import('../services/ledgerService.js');
  return ledgerModulePromise;
};

const logLedgerHookError = (label, error) => {
  console.error(`[ledger] ${label} hook failed:`, error?.message || error);
};

const toId = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/// Extracts pushed transactions from an update document, whichever way the
/// caller wrote it: `$push: { transactions: tx }` or
/// `$push: { transactions: { $each: [tx], $slice: -50 } }`.
export const extractPushedWalletTransactions = (update = {}) => {
  const push = update?.$push?.transactions;
  if (!push) return [];
  if (Array.isArray(push?.$each)) return push.$each.filter(isPlainObject);
  if (isPlainObject(push) && !('$each' in push)) return [push];
  return [];
};

const toPlain = (value) => (value && typeof value.toObject === 'function' ? value.toObject() : value);

const resolveUserWalletField = (update = {}) => {
  const inc = update?.$inc || {};
  if (Object.prototype.hasOwnProperty.call(inc, 'refundWallet') && !Object.prototype.hasOwnProperty.call(inc, 'balance')) {
    return 'refundWallet';
  }
  return 'balance';
};

export const buildUserWalletTransfer = ({ userId, tx, walletField, balanceAfter = null }) => {
  const plain = toPlain(tx) || {};
  const amount = normalizePositiveAmount(plain.amount);
  if (!userId || !amount) return null;

  const kind = plain.kind === 'debit' ? 'debit' : 'credit';
  const category = classifyUserWalletTransaction(plain);
  const provider = String(plain.provider || '').trim().toLowerCase();
  const counterparty = category === 'wallet_topup'
    ? { type: 'gateway', id: provider || 'gateway' }
    : { type: 'platform', id: 'platform' };
  const userAccount = { type: 'user', id: String(userId), wallet: walletField };

  // Prefer stable business keys so the same movement recorded by the
  // settlement service and by this hook collapses to one ledger transfer.
  const txId = toId(plain._id);
  const referenceKey = String(plain.referenceKey || '').trim();
  const paymentId = String(plain.providerPaymentId || '').trim();
  let idempotencyKey;
  if (referenceKey) idempotencyKey = `user_wallet:${userId}:ref:${referenceKey}:${kind}`;
  else if (paymentId && category === 'wallet_topup') idempotencyKey = `user_wallet:${userId}:pay:${provider}:${paymentId}:${kind}`;
  else if (txId) idempotencyKey = `user_wallet:${userId}:tx:${txId}`;
  else idempotencyKey = `user_wallet:${userId}:rnd:${crypto.randomUUID()}`;

  return {
    from: kind === 'credit' ? counterparty : userAccount,
    to: kind === 'credit' ? userAccount : counterparty,
    amount,
    category,
    service: category === 'wallet_topup' ? 'wallet' : '',
    description: String(plain.title || '').trim(),
    reference: referenceKey
      ? { kind: 'wallet_reference', id: referenceKey }
      : { kind: 'user_wallet_tx', id: txId },
    gateway: {
      provider: ['razorpay', 'phonepe'].includes(provider) ? provider : '',
      orderId: String(plain.providerOrderId || ''),
      paymentId,
    },
    idempotencyKey,
    source: 'hook:user_wallet',
    metadata: {
      walletTransactionId: txId,
      provider: plain.provider || '',
      counterpartyPhone: plain.counterpartyPhone || '',
    },
    ...(kind === 'credit' ? { toBalanceAfter: balanceAfter } : { fromBalanceAfter: balanceAfter }),
  };
};

const mirrorUserWalletTransactions = ({ userId, transactions, walletField, balanceAfter, session, label }) => {
  if (!userId || !transactions.length) return;
  loadLedger()
    .then(({ recordTransferSafe }) => {
      for (const tx of transactions) {
        const transfer = buildUserWalletTransfer({
          userId,
          tx,
          walletField,
          // Only meaningful when exactly one row moved the balance.
          balanceAfter: transactions.length === 1 ? balanceAfter : null,
        });
        if (transfer) void recordTransferSafe(transfer, { session, label });
      }
    })
    .catch((error) => logLedgerHookError(label, error));
};

/// UserWallet (embedded transactions array, capped at 50 by its writers).
export const userWalletLedgerPlugin = (schema) => {
  const onQueryUpdate = function onQueryUpdate(result) {
    try {
      const update = this.getUpdate() || {};
      const transactions = extractPushedWalletTransactions(update);
      if (!transactions.length) return;

      // updateOne returns an UpdateResult; findOneAndUpdate returns the doc
      // (or null). Skip only when we know nothing was written.
      if (result && typeof result.modifiedCount === 'number' && result.modifiedCount === 0) return;
      if (result === null) return;

      const filter = this.getFilter() || {};
      const userId = toId(filter.userId || result?.userId);
      const walletField = resolveUserWalletField(update);
      const balanceAfter = result && typeof result === 'object' && !('modifiedCount' in result)
        ? Number(result[walletField])
        : null;

      mirrorUserWalletTransactions({
        userId,
        transactions,
        walletField,
        balanceAfter: Number.isFinite(balanceAfter) ? balanceAfter : null,
        session: this.getOptions?.().session || this.options?.session || null,
        label: 'user_wallet:update',
      });
    } catch (error) {
      logLedgerHookError('user_wallet:update', error);
    }
  };

  schema.post('updateOne', onQueryUpdate);
  schema.post('findOneAndUpdate', onQueryUpdate);

  // Document saves: remember which embedded rows existed when the wallet was
  // loaded, and mirror the ones that are new at save time.
  schema.post('init', function rememberLoadedTransactions() {
    try {
      this.$locals.ledgerKnownTxIds = new Set((this.transactions || []).map((tx) => toId(tx?._id)));
    } catch (error) {
      logLedgerHookError('user_wallet:init', error);
    }
  });

  schema.pre('save', function collectNewTransactions() {
    try {
      const known = this.$locals?.ledgerKnownTxIds;
      const transactions = (this.transactions || []).filter((tx) => {
        const id = toId(tx?._id);
        return this.isNew ? true : known ? !known.has(id) : Boolean(tx?.isNew);
      });
      this.$locals.ledgerPendingTxs = transactions.map((tx) => toPlain(tx));
    } catch (error) {
      logLedgerHookError('user_wallet:pre_save', error);
    }
  });

  schema.post('save', function mirrorSavedTransactions(doc) {
    try {
      const pending = doc.$locals?.ledgerPendingTxs || [];
      doc.$locals.ledgerPendingTxs = [];
      doc.$locals.ledgerKnownTxIds = new Set((doc.transactions || []).map((tx) => toId(tx?._id)));
      if (!pending.length) return;

      // A document save can move balance and refundWallet at once; the
      // embedded rows do not say which, so attribute to `balance` unless the
      // title says refund wallet.
      for (const tx of pending) {
        const walletField = /refund wallet/i.test(String(tx?.title || '')) ? 'refundWallet' : 'balance';
        mirrorUserWalletTransactions({
          userId: toId(doc.userId),
          transactions: [tx],
          walletField,
          balanceAfter: pending.length === 1 ? Number(doc[walletField]) : null,
          session: typeof doc.$session === 'function' ? doc.$session() : null,
          label: 'user_wallet:save',
        });
      }
    } catch (error) {
      logLedgerHookError('user_wallet:post_save', error);
    }
  });
};

/// Driver WalletTransaction rows. Every driver money movement goes through
/// `applyDriverWalletAdjustment` or a direct `WalletTransaction.create`, and
/// both trigger `save`.
export const driverWalletTransactionLedgerPlugin = (schema) => {
  schema.pre('save', function markNew() {
    this.$locals.ledgerWasNew = this.isNew;
  });

  schema.post('save', function mirrorDriverWalletTransaction(doc) {
    try {
      if (!doc.$locals?.ledgerWasNew) return;
      doc.$locals.ledgerWasNew = false;

      const signedAmount = Number(doc.amount || 0);
      const amount = normalizePositiveAmount(Math.abs(signedAmount));
      if (!amount) return;

      const metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
      const category = classifyDriverWalletTransaction({ type: doc.type, amount: signedAmount, metadata });
      const provider = String(metadata.provider || '').trim().toLowerCase();
      const driverAccount = { type: 'driver', id: toId(doc.driverId), wallet: 'wallet' };
      const counterparty = category === 'wallet_topup' && provider
        ? { type: 'gateway', id: provider }
        : { type: 'platform', id: 'platform' };
      const isCredit = signedAmount > 0;
      const reference = doc.rideId
        ? { kind: 'ride', id: toId(doc.rideId) }
        : metadata.withdrawalRequestId
          ? { kind: 'withdrawal_request', id: String(metadata.withdrawalRequestId) }
          : metadata.subscriptionId
            ? { kind: 'driver_subscription', id: String(metadata.subscriptionId) }
            : { kind: 'driver_wallet_tx', id: toId(doc._id) };

      const transfer = {
        from: isCredit ? counterparty : driverAccount,
        to: isCredit ? driverAccount : counterparty,
        amount,
        category,
        service: category === 'wallet_topup' ? 'wallet' : '',
        description: String(doc.description || '').trim(),
        reference,
        gateway: {
          provider: ['razorpay', 'phonepe'].includes(provider) ? provider : '',
          orderId: String(metadata.providerOrderId || ''),
          paymentId: String(metadata.providerPaymentId || ''),
        },
        idempotencyKey: `driver_wallet_tx:${toId(doc._id)}`,
        source: 'hook:driver_wallet',
        metadata: {
          walletTransactionId: toId(doc._id),
          walletTransactionType: doc.type,
          commissionAmount: metadata.commissionAmount ?? undefined,
          fare: metadata.fare ?? undefined,
        },
        ...(isCredit ? { toBalanceAfter: doc.balanceAfter } : { fromBalanceAfter: doc.balanceAfter }),
      };

      const session = typeof doc.$session === 'function' ? doc.$session() : null;
      loadLedger()
        .then(({ recordTransferSafe }) => recordTransferSafe(transfer, { session, label: 'driver_wallet:save' }))
        .catch((error) => logLedgerHookError('driver_wallet:save', error));

      // Commission on an online ride is netted out of the driver credit, so
      // it never appears as its own wallet row. Record it separately so the
      // commission report sees online rides as well as cash ones.
      const commissionAmount = normalizePositiveAmount(metadata.commissionAmount);
      if (doc.type === 'ride_earning' && commissionAmount && doc.rideId) {
        const commissionTransfer = {
          from: { type: 'driver', id: toId(doc.driverId), wallet: 'earnings' },
          to: { type: 'platform', id: 'platform' },
          amount: commissionAmount,
          category: 'commission',
          description: 'Commission retained on online ride',
          reference: { kind: 'ride', id: toId(doc.rideId) },
          idempotencyKey: `ride_commission:${toId(doc.rideId)}`,
          source: 'hook:driver_wallet',
          metadata: { walletTransactionId: toId(doc._id), netted: true },
        };
        loadLedger()
          .then(({ recordTransferSafe }) => recordTransferSafe(commissionTransfer, { session, label: 'driver_commission' }))
          .catch((error) => logLedgerHookError('driver_commission', error));
      }
    } catch (error) {
      logLedgerHookError('driver_wallet:post_save', error);
    }
  });
};

/// Owner (fleet) wallet rows.
export const ownerWalletTransactionLedgerPlugin = (schema) => {
  schema.pre('save', function markNew() {
    this.$locals.ledgerWasNew = this.isNew;
  });

  schema.post('save', function mirrorOwnerWalletTransaction(doc) {
    try {
      if (!doc.$locals?.ledgerWasNew) return;
      doc.$locals.ledgerWasNew = false;

      const amount = normalizePositiveAmount(Math.abs(Number(doc.amount || 0)));
      if (!amount) return;

      const ownerAccount = { type: 'owner', id: toId(doc.ownerId), wallet: 'wallet' };
      const platform = { type: 'platform', id: 'platform' };
      const isCredit = doc.kind === 'credit';
      const title = String(doc.title || '');
      const category = /withdraw/i.test(title)
        ? (isCredit ? 'withdrawal_reversal' : 'withdrawal')
        : 'adjustment';

      const transfer = {
        from: isCredit ? platform : ownerAccount,
        to: isCredit ? ownerAccount : platform,
        amount,
        category,
        description: title,
        reference: { kind: 'owner_wallet_tx', id: toId(doc._id) },
        idempotencyKey: `owner_wallet_tx:${toId(doc._id)}`,
        source: 'hook:owner_wallet',
        ...(isCredit ? { toBalanceAfter: doc.balance } : { fromBalanceAfter: doc.balance }),
      };

      const session = typeof doc.$session === 'function' ? doc.$session() : null;
      loadLedger()
        .then(({ recordTransferSafe }) => recordTransferSafe(transfer, { session, label: 'owner_wallet:save' }))
        .catch((error) => logLedgerHookError('owner_wallet:save', error));
    } catch (error) {
      logLedgerHookError('owner_wallet:post_save', error);
    }
  });
};
