import { ApiError } from '../../../../utils/ApiError.js';
import { UserWallet } from '../../user/models/UserWallet.js';
import { roundMoney } from './rentalBilling.js';

/// Wallet moves for rental deposits and extensions.
///
/// Both are idempotent on `referenceKey`: a retried request (flaky network,
/// double tap) finds its own transaction and returns it rather than moving
/// the money twice. The guard lives in the update filter, so two concurrent
/// requests cannot both pass it.

const ensureWallet = async (userId) => {
  await UserWallet.updateOne(
    { userId },
    { $setOnInsert: { userId, balance: 0, refundWallet: 0, transactions: [] } },
    { upsert: true },
  );
};

const findTransaction = (wallet, referenceKey, kind) =>
  (Array.isArray(wallet?.transactions) ? wallet.transactions : []).find(
    (entry) => entry?.kind === kind && String(entry.referenceKey || '') === referenceKey,
  ) || null;

export const debitUserWallet = async ({ userId, amount, title, referenceKey, providerPaymentId = '' }) => {
  const value = roundMoney(amount);
  if (!userId || !(value > 0)) {
    throw new ApiError(400, 'A positive amount is required');
  }
  await ensureWallet(userId);

  const tx = {
    kind: 'debit',
    amount: value,
    title,
    provider: 'wallet',
    providerPaymentId: providerPaymentId || referenceKey,
    referenceKey,
  };

  const updated = await UserWallet.findOneAndUpdate(
    { userId, balance: { $gte: value }, 'transactions.referenceKey': { $ne: referenceKey } },
    { $inc: { balance: -value }, $push: { transactions: { $each: [tx], $slice: -50 } } },
    { new: true },
  ).lean();

  if (updated) {
    return { applied: true, balance: Number(updated.balance || 0), referenceKey };
  }

  const wallet = await UserWallet.findOne({ userId }).lean();
  if (findTransaction(wallet, referenceKey, 'debit')) {
    return { applied: false, balance: Number(wallet?.balance || 0), referenceKey };
  }
  throw new ApiError(400, 'Insufficient wallet balance');
};

export const creditUserWallet = async ({ userId, amount, title, referenceKey, providerPaymentId = '' }) => {
  const value = roundMoney(amount);
  if (!userId) {
    throw new ApiError(400, 'User is required for a wallet credit');
  }
  if (!(value > 0)) {
    return { applied: false, balance: null, referenceKey };
  }
  await ensureWallet(userId);

  const tx = {
    kind: 'credit',
    amount: value,
    title,
    provider: 'wallet',
    providerPaymentId: providerPaymentId || referenceKey,
    referenceKey,
  };

  const updated = await UserWallet.findOneAndUpdate(
    { userId, 'transactions.referenceKey': { $ne: referenceKey } },
    { $inc: { balance: value }, $push: { transactions: { $each: [tx], $slice: -50 } } },
    { new: true },
  ).lean();

  if (updated) {
    return { applied: true, balance: Number(updated.balance || 0), referenceKey };
  }

  const wallet = await UserWallet.findOne({ userId }).lean();
  return { applied: false, balance: Number(wallet?.balance || 0), referenceKey };
};
