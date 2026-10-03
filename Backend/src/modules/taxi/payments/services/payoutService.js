import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Owner } from '../../admin/models/Owner.js';
import { OwnerWalletTransaction } from '../../admin/models/OwnerWalletTransaction.js';
import { WithdrawalRequest } from '../../admin/models/WithdrawalRequest.js';
import { Driver } from '../../driver/models/Driver.js';
import { applyDriverWalletAdjustment } from '../../driver/services/walletService.js';
import { Payout } from '../models/Payout.js';
import {
  buildGatewayIdempotencyHeader,
  buildIdempotencyKey,
  clampPagination,
  roundMoney,
  toMinorUnits,
} from '../utils/paymentUtils.js';
import { razorpayApi, resolveRazorpayXAccountNumber } from './gatewayClients.js';
import { recordTransferSafe } from './ledgerService.js';
import { getPaymentSettings, getPayoutMode } from './paymentSettingsService.js';

/// Withdrawal payouts.
///
/// `payments.payout_mode` = 'manual' (default) keeps today's behaviour: an
/// approved withdrawal debits the wallet and is marked `completed`; the admin
/// pays outside the app. With 'razorpayx', approval debits the wallet, marks
/// the withdrawal `processing` and sends a RazorpayX payout
/// (contact -> fund account -> payout). The payout webhook then marks it
/// `completed`, or `failed` with the amount returned to the wallet.

const IN_FLIGHT = new Set(['created', 'queued', 'pending', 'processing']);
const FAILED = new Set(['reversed', 'cancelled', 'rejected', 'failed']);

/// Status to store on a withdrawal at approval time.
export const resolveApprovedWithdrawalStatus = async () =>
  ((await getPayoutMode()) === 'razorpayx' ? 'processing' : 'completed');

const cleanDigits = (value) => String(value || '').replace(/\D/g, '');

const resolvePayee = async ({ request, account }) => {
  const snapshot = request.bank_details_snapshot || {};

  if (account.type === 'driver') {
    const driver = await Driver.findById(account.id).select('name phone email bankDetails').lean();
    if (!driver) throw new ApiError(404, 'Driver not found for payout');
    const bank = {
      accountHolderName: snapshot.accountHolderName || driver.bankDetails?.accountHolderName || driver.name || '',
      accountNumber: snapshot.accountNumber || driver.bankDetails?.accountNumber || '',
      ifsc: snapshot.ifsc || driver.bankDetails?.ifsc || '',
      upiId: snapshot.upiId || driver.bankDetails?.upiId || '',
    };
    return { name: driver.name || bank.accountHolderName || 'Driver', phone: cleanDigits(driver.phone).slice(-10), email: driver.email || '', bank, contactType: 'employee' };
  }

  const owner = await Owner.findById(account.id).select('company_name owner_name name mobile phone email bank_name ifsc account_no').lean();
  if (!owner) throw new ApiError(404, 'Owner not found for payout');
  const holder = owner.owner_name || owner.name || owner.company_name || 'Owner';
  const bank = {
    accountHolderName: snapshot.accountHolderName || holder,
    accountNumber: snapshot.accountNumber || owner.account_no || '',
    ifsc: snapshot.ifsc || owner.ifsc || '',
    upiId: snapshot.upiId || '',
  };
  return { name: holder, phone: cleanDigits(owner.mobile || owner.phone).slice(-10), email: owner.email || '', bank, contactType: 'vendor' };
};

const recordPayoutLedger = (payout, { reversal = false } = {}) => {
  const account = { type: payout.account.type, id: String(payout.account.id), wallet: 'bank' };
  const gateway = { type: 'gateway', id: payout.provider || 'razorpayx' };
  void recordTransferSafe(
    {
      from: reversal ? gateway : account,
      to: reversal ? account : gateway,
      amount: payout.amount,
      category: reversal ? 'payout_reversal' : 'payout',
      description: reversal ? 'Payout failed or reversed' : 'Payout sent to bank',
      reference: { kind: 'withdrawal_request', id: String(payout.withdrawalRequestId || '') },
      gateway: { provider: payout.provider || 'razorpayx', payoutId: payout.payoutId || '' },
      idempotencyKey: `${reversal ? 'payout_reversal' : 'payout'}:${payout.idempotencyKey}`,
      source: 'payout_service',
      metadata: { utr: payout.utr || '', mode: payout.mode },
    },
    { label: 'payout' },
  );
};

/// Returns the withdrawn amount to the wallet after a failed payout. Runs
/// once per payout (the `walletReversed` flag is claimed atomically).
const reverseWithdrawalToWallet = async (payout, reason) => {
  const claimed = await Payout.findOneAndUpdate(
    { _id: payout._id, walletReversed: false },
    { $set: { walletReversed: true } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) return;

  try {
    if (payout.account.type === 'driver') {
      const result = await applyDriverWalletAdjustment({
        driverId: payout.account.id,
        amount: payout.amount,
        type: 'withdrawal',
        description: 'Withdrawal payout failed - amount returned to wallet',
        metadata: {
          withdrawalRequestId: String(payout.withdrawalRequestId || ''),
          payoutId: payout.payoutId || '',
          reversal: true,
          reason,
        },
      });
      const dispatch = await import('../../services/dispatchService.js');
      dispatch.emitToDriver(payout.account.id, 'driver:wallet:updated', {
        wallet: result.wallet,
        transaction: result.transaction,
      });
    } else {
      const owner = await Owner.findByIdAndUpdate(
        payout.account.id,
        { $inc: { 'wallet.balance': payout.amount } },
        { returnDocument: 'after' },
      );
      await OwnerWalletTransaction.create({
        ownerId: payout.account.id,
        amount: payout.amount,
        kind: 'credit',
        title: 'Withdrawal payout failed - amount returned',
        balance: Number(owner?.wallet?.balance || 0),
      });
    }
  } catch (error) {
    // Leave walletReversed=true would lose the money silently; undo the flag
    // so an admin retry (or the next webhook) tries again.
    await Payout.updateOne({ _id: payout._id }, { $set: { walletReversed: false } }).catch(() => null);
    throw error;
  }
};

const syncWithdrawalFromPayout = async (payout) => {
  if (!payout.withdrawalRequestId) return;
  if (payout.status === 'processed') {
    await WithdrawalRequest.updateOne(
      { _id: payout.withdrawalRequestId },
      { $set: { status: 'completed', 'payout.status': 'processed', 'payout.utr': payout.utr || '', 'payout.processedAt': payout.processedAt || new Date() } },
    );
  } else if (FAILED.has(payout.status)) {
    await WithdrawalRequest.updateOne(
      { _id: payout.withdrawalRequestId },
      { $set: { status: 'failed', 'payout.status': payout.status, 'payout.failureReason': payout.failureReason || '' } },
    );
  } else {
    await WithdrawalRequest.updateOne(
      { _id: payout.withdrawalRequestId },
      { $set: { 'payout.status': payout.status, 'payout.payoutId': payout.payoutId || '' } },
    );
  }
};

const applyPayoutStatus = async (payoutId, { status, payoutEntity = null, failureReason = '' }) => {
  const update = {
    status,
    ...(payoutEntity ? { response: payoutEntity, payoutId: payoutEntity.id || undefined, utr: payoutEntity.utr || '' } : {}),
    ...(status === 'processed' ? { processedAt: new Date() } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
  Object.keys(update).forEach((key) => update[key] === undefined && delete update[key]);

  const payout = await Payout.findByIdAndUpdate(payoutId, { $set: update }, { returnDocument: 'after' }).lean();
  if (!payout) return null;

  if (status === 'processed') recordPayoutLedger(payout);
  if (FAILED.has(status)) {
    await reverseWithdrawalToWallet(payout, failureReason || status);
    // Only a processed-then-reversed payout had money leave; the wallet
    // debit and its return are mirrored by the wallet hooks already.
    if (status === 'reversed') recordPayoutLedger(payout, { reversal: true });
  }
  await syncWithdrawalFromPayout(payout);
  return payout;
};

/// Sends the RazorpayX payout for an approved withdrawal. Idempotent per
/// withdrawal: calling it again returns the existing payout.
///
/// @param {{ request: object, account: { type: 'driver'|'owner', id: string } }} input
export const startWithdrawalPayout = async ({ request, account }) => {
  if ((await getPayoutMode()) !== 'razorpayx') return null;
  if (!request?._id || String(request.status) !== 'processing') return null;

  const idempotencyKey = buildIdempotencyKey('payout', 'withdrawal', String(request._id));
  const settings = await getPaymentSettings();
  const amount = roundMoney(request.amount);

  let payout;
  try {
    payout = await Payout.create({
      provider: 'razorpayx',
      status: 'created',
      withdrawalRequestId: request._id,
      account: { type: account.type, id: String(account.id) },
      amount,
      mode: String(settings.payout_transfer_mode || 'IMPS').toUpperCase(),
      idempotencyKey,
    });
  } catch (error) {
    if (error?.code === 11000) return Payout.findOne({ idempotencyKey }).lean();
    throw error;
  }

  try {
    const accountNumber = await resolveRazorpayXAccountNumber();
    const payee = await resolvePayee({ request, account });
    const useUpi = !payee.bank.accountNumber && payee.bank.upiId;
    if (!useUpi && (!payee.bank.accountNumber || !payee.bank.ifsc)) {
      throw new ApiError(400, 'Payee has no bank account/IFSC or UPI id on file');
    }

    const contact = await razorpayApi({
      method: 'POST',
      path: '/contacts',
      body: {
        name: payee.name.slice(0, 50),
        ...(payee.email ? { email: payee.email } : {}),
        ...(payee.phone.length === 10 ? { contact: payee.phone } : {}),
        type: payee.contactType,
        reference_id: `${account.type}_${account.id}`.slice(0, 40),
      },
    });

    const fundAccount = await razorpayApi({
      method: 'POST',
      path: '/fund_accounts',
      body: useUpi
        ? { contact_id: contact.id, account_type: 'vpa', vpa: { address: payee.bank.upiId } }
        : {
          contact_id: contact.id,
          account_type: 'bank_account',
          bank_account: {
            name: payee.bank.accountHolderName.slice(0, 120) || payee.name,
            ifsc: payee.bank.ifsc,
            account_number: payee.bank.accountNumber,
          },
        },
    });

    const mode = useUpi ? 'UPI' : (payout.mode === 'UPI' ? 'IMPS' : payout.mode);
    const payoutEntity = await razorpayApi({
      method: 'POST',
      path: '/payouts',
      idempotencyKey: buildGatewayIdempotencyHeader(idempotencyKey),
      body: {
        account_number: accountNumber,
        fund_account_id: fundAccount.id,
        amount: toMinorUnits(amount),
        currency: 'INR',
        mode,
        purpose: 'payout',
        queue_if_low_balance: true,
        reference_id: String(request._id).slice(0, 40),
        narration: 'Wallet withdrawal'.slice(0, 30),
        notes: { withdrawalRequestId: String(request._id), accountType: account.type, accountId: String(account.id) },
      },
    });

    await Payout.updateOne(
      { _id: payout._id },
      { $set: { contactId: contact.id, fundAccountId: fundAccount.id, payoutId: payoutEntity.id, mode } },
    );
    await WithdrawalRequest.updateOne(
      { _id: request._id },
      { $set: { payout: { provider: 'razorpayx', payoutId: payoutEntity.id, status: payoutEntity.status || 'processing', failureReason: '', utr: payoutEntity.utr || '', processedAt: null } } },
    );

    const status = String(payoutEntity.status || 'processing').toLowerCase();
    return applyPayoutStatus(payout._id, {
      status: IN_FLIGHT.has(status) || status === 'processed' || FAILED.has(status) ? status : 'processing',
      payoutEntity,
      failureReason: payoutEntity.status_details?.description || payoutEntity.failure_reason || '',
    });
  } catch (error) {
    console.error('[payout] RazorpayX payout failed:', String(request._id), error?.message || error);
    return applyPayoutStatus(payout._id, { status: 'failed', failureReason: String(error?.message || 'Payout failed').slice(0, 500) });
  }
};

/// Same as startWithdrawalPayout but never throws, for the approve flow.
export const startWithdrawalPayoutSafely = async (input) => {
  try {
    return await startWithdrawalPayout(input);
  } catch (error) {
    console.error('[payout] could not start payout:', error?.message || error);
    return null;
  }
};

/// RazorpayX payout webhook (payout.processed / payout.failed / payout.reversed ...).
export const applyRazorpayPayoutWebhook = async ({ payoutEntity, event }) => {
  if (!payoutEntity?.id) return { status: 'ignored', reason: 'no_payout_entity' };
  const payout = await Payout.findOne({
    $or: [
      { payoutId: payoutEntity.id },
      ...(payoutEntity.reference_id && mongoose.isValidObjectId(payoutEntity.reference_id)
        ? [{ withdrawalRequestId: payoutEntity.reference_id }]
        : []),
    ],
  }).lean();
  if (!payout) return { status: 'ignored', reason: 'payout_not_created_here' };
  if (payout.status === 'processed' || (FAILED.has(payout.status) && payout.walletReversed)) {
    return { status: 'existing', payoutId: payoutEntity.id, payoutStatus: payout.status };
  }

  const eventStatus = String(event || '').split('.')[1] || '';
  const status = String(payoutEntity.status || eventStatus || '').toLowerCase();
  const updated = await applyPayoutStatus(payout._id, {
    status: IN_FLIGHT.has(status) || status === 'processed' || FAILED.has(status) ? status : 'processing',
    payoutEntity,
    failureReason: payoutEntity.status_details?.description || payoutEntity.failure_reason || '',
  });
  return { status: 'processed', payoutId: payoutEntity.id, payoutStatus: updated?.status };
};

// ---- Owner withdrawals (gap 2.15: owners had a list but no approve) ----

const serializeWithdrawal = (request = {}) => ({
  _id: request._id,
  transactionId: request.transactionId || '',
  owner_id: request.owner_id || null,
  driver_id: request.driver_id || null,
  amount: Number(request.amount || 0),
  requested_currency: 'INR',
  payment_method: request.payment_method || '',
  status: request.status || 'pending',
  payout: request.payout || null,
  bank_details_snapshot: request.bank_details_snapshot || {},
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

export const listOwnerWithdrawals = async ({ ownerId, page = 1, limit = 50 }) => {
  if (!mongoose.isValidObjectId(ownerId)) throw new ApiError(400, 'Valid owner id is required');
  const owner = await Owner.findById(ownerId).lean();
  if (!owner) throw new ApiError(404, 'Owner not found');
  const pagination = clampPagination({ page, limit }, { defaultLimit: 50, maxLimit: 200 });

  const [items, total, withdrawn, earned] = await Promise.all([
    WithdrawalRequest.find({ owner_id: owner._id }).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    WithdrawalRequest.countDocuments({ owner_id: owner._id }),
    WithdrawalRequest.aggregate([
      { $match: { owner_id: owner._id, status: { $in: ['completed', 'processing'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    OwnerWalletTransaction.aggregate([
      { $match: { ownerId: owner._id, kind: 'credit' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  return {
    owner: {
      _id: owner._id,
      name: owner.owner_name || owner.name || owner.company_name || '',
      company_name: owner.company_name || '',
      mobile: owner.mobile || owner.phone || '',
      email: owner.email || '',
      wallet_balance: roundMoney(owner.wallet?.balance || 0).toFixed(2),
      total_earned: roundMoney(earned[0]?.total || 0),
      total_withdrawn: roundMoney(withdrawn[0]?.total || 0),
      bankDetails: { bank_name: owner.bank_name || '', ifsc: owner.ifsc || '', account_no: owner.account_no || '' },
    },
    results: items.map(serializeWithdrawal),
    paginator: {
      current_page: pagination.page,
      per_page: pagination.limit,
      total,
      last_page: Math.max(1, Math.ceil(total / pagination.limit)),
    },
  };
};

export const approveOwnerWithdrawalRequest = async (requestId, adminId = '') => {
  if (!mongoose.isValidObjectId(requestId)) throw new ApiError(400, 'Valid withdrawal request id is required');
  const nextStatus = await resolveApprovedWithdrawalStatus();

  // Claim the request first so a double click cannot debit twice.
  const request = await WithdrawalRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending', owner_id: { $ne: null } },
    { $set: { status: nextStatus } },
    { returnDocument: 'after' },
  );
  if (!request) {
    const existing = await WithdrawalRequest.findById(requestId).lean();
    if (!existing || !existing.owner_id) throw new ApiError(404, 'Owner withdrawal request not found');
    throw new ApiError(400, 'Only pending withdrawal requests can be approved');
  }

  const amount = roundMoney(request.amount);
  const owner = amount > 0
    ? await Owner.findOneAndUpdate(
      { _id: request.owner_id, 'wallet.balance': { $gte: amount } },
      { $inc: { 'wallet.balance': -amount } },
      { returnDocument: 'after' },
    )
    : null;

  if (!owner) {
    await WithdrawalRequest.updateOne({ _id: request._id }, { $set: { status: 'pending' } });
    throw new ApiError(400, amount > 0 ? 'Owner wallet balance is not enough for this withdrawal' : 'Withdrawal request amount is invalid');
  }

  await OwnerWalletTransaction.create({
    ownerId: owner._id,
    amount,
    kind: 'debit',
    title: 'Owner withdrawal approved by admin',
    balance: Number(owner.wallet?.balance || 0),
  });

  const payout = await startWithdrawalPayoutSafely({ request: request.toObject(), account: { type: 'owner', id: String(owner._id) } });
  const fresh = await WithdrawalRequest.findById(request._id).lean();

  return {
    request: serializeWithdrawal(fresh),
    wallet: { balance: roundMoney(owner.wallet?.balance || 0) },
    payout: payout ? { status: payout.status, payoutId: payout.payoutId || '', failureReason: payout.failureReason || '' } : null,
    approvedBy: String(adminId || ''),
  };
};

export const rejectOwnerWithdrawalRequest = async (requestId) => {
  if (!mongoose.isValidObjectId(requestId)) throw new ApiError(400, 'Valid withdrawal request id is required');
  const request = await WithdrawalRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending', owner_id: { $ne: null } },
    { $set: { status: 'cancelled' } },
    { returnDocument: 'after' },
  ).lean();
  if (!request) throw new ApiError(400, 'Only pending owner withdrawal requests can be rejected');
  return { request: serializeWithdrawal(request) };
};

/// Payout history for the admin panel. A failed payout has already returned
/// the money to the wallet, so there is no "retry": the driver/owner raises a
/// new withdrawal.
export const listPayouts = async (query = {}) => {
  const { page, limit, skip } = clampPagination(query, { defaultLimit: 20, maxLimit: 100 });
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.accountType) filter['account.type'] = String(query.accountType);
  if (query.accountId) filter['account.id'] = String(query.accountId);
  const [items, total] = await Promise.all([
    Payout.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Payout.countDocuments(filter),
  ]);
  return {
    results: items.map((item) => ({ ...item, response: undefined })),
    paginator: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
  };
};
