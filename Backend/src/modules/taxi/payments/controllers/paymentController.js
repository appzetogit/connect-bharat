import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { hasAdminPermission } from '../../admin/services/adminAccessService.js';
import { UserWallet } from '../../user/models/UserWallet.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { Refund } from '../models/Refund.js';
import { clampPagination } from '../utils/paymentUtils.js';
import { listLedgerEntries, serializeLedgerEntry } from '../services/ledgerService.js';
import { getPaymentSummaryReport } from '../services/paymentReportService.js';
import { getPaymentSettings, updatePaymentSettings } from '../services/paymentSettingsService.js';
import {
  approveOwnerWithdrawalRequest,
  listOwnerWithdrawals,
  listPayouts,
  rejectOwnerWithdrawalRequest,
} from '../services/payoutService.js';
import {
  approveRefund,
  createManualRefund,
  listRefunds,
  rejectRefund,
  serializeRefund,
} from '../services/refundService.js';
import {
  handlePhonePeWebhook,
  handleRazorpayWebhook,
  listPaymentEvents,
  processDuePaymentEvents,
} from '../services/webhookService.js';

const ok = (res, data, message) => res.json({ success: true, data, ...(message ? { message } : {}) });

/// Admin RBAC for the payments routes: money views need `wallet.view`,
/// changing payment settings needs `settings.view`. Super admins pass.
export const requireAdminPermission = (permission) => (req, _res, next) => {
  if (!hasAdminPermission(req.auth?.admin, permission)) {
    next(new ApiError(403, `You do not have permission (${permission}) for this resource`));
    return;
  }
  next();
};

// ---------- Webhooks ----------

export const razorpayWebhook = async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    throw new ApiError(415, 'Webhook body must be sent as application/json');
  }
  const result = await handleRazorpayWebhook({
    rawBody: req.body,
    signature: req.get('x-razorpay-signature') || '',
    eventIdHeader: req.get('x-razorpay-event-id') || '',
  });
  res.json({ success: true, data: result });
};

export const phonePeWebhook = async (req, res) => {
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      throw new ApiError(400, 'Webhook body is not valid JSON');
    }
  }
  const result = await handlePhonePeWebhook({
    authorization: req.get('authorization') || '',
    body: body || {},
  });
  res.json({ success: true, data: result });
};

// ---------- User ----------

const mapLedgerToWalletRow = (entry) => ({
  id: entry.entryId,
  kind: entry.direction,
  amount: Number(entry.amount || 0),
  title: entry.description || '',
  category: entry.category,
  wallet: entry.account?.wallet || 'balance',
  balanceAfter: entry.balanceAfter ?? null,
  reference: entry.reference || {},
  provider: entry.gateway?.provider || '',
  providerPaymentId: entry.gateway?.paymentId || '',
  createdAt: entry.createdAt,
});

/// Full, paginated wallet history from the ledger. The embedded
/// `UserWallet.transactions` array (last 50) is untouched for older app
/// builds; this is the audit-grade history. Users whose history predates the
/// ledger see their embedded rows until the ledger has entries.
export const getMyWalletTransactions = async (req, res) => {
  const userId = String(req.auth?.sub || '');
  const { page, limit, skip } = clampPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const filter = { 'account.type': 'user', 'account.id': userId };
  if (req.query.wallet) filter['account.wallet'] = String(req.query.wallet);
  if (req.query.kind) filter.direction = String(req.query.kind) === 'debit' ? 'debit' : 'credit';

  const [items, total] = await Promise.all([
    LedgerEntry.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    LedgerEntry.countDocuments(filter),
  ]);

  if (total === 0 && page === 1) {
    const wallet = await UserWallet.findOne({ userId }).select('balance refundWallet transactions').lean();
    const legacy = (wallet?.transactions || []).slice().reverse();
    return ok(res, {
      source: 'wallet_embedded',
      balance: Number(wallet?.balance || 0),
      refundWallet: Number(wallet?.refundWallet || 0),
      results: legacy.slice(0, limit).map((tx) => ({
        id: String(tx._id),
        kind: tx.kind,
        amount: Number(tx.amount || 0),
        title: tx.title || '',
        category: '',
        wallet: 'balance',
        balanceAfter: null,
        reference: {},
        provider: tx.provider || '',
        providerPaymentId: tx.providerPaymentId || '',
        createdAt: tx.createdAt || null,
      })),
      paginator: { current_page: 1, per_page: limit, total: legacy.length, last_page: Math.max(1, Math.ceil(legacy.length / limit)) },
    });
  }

  const wallet = await UserWallet.findOne({ userId }).select('balance refundWallet').lean();
  return ok(res, {
    source: 'ledger',
    balance: Number(wallet?.balance || 0),
    refundWallet: Number(wallet?.refundWallet || 0),
    results: items.map(serializeLedgerEntry).map(mapLedgerToWalletRow),
    paginator: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
  });
};

/// The user's own refunds (status tracking for the app).
export const getMyRefunds = async (req, res) => {
  const result = await listRefunds({ ...req.query, userId: req.auth?.sub });
  return ok(res, { results: result.results.map(({ user, ...rest }) => rest), paginator: result.paginator });
};

// ---------- Admin ----------

export const adminListRefunds = async (req, res) => ok(res, await listRefunds(req.query));

export const adminGetRefund = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Valid refund id is required');
  const refund = await Refund.findById(req.params.id).populate('userId', 'name phone').lean();
  if (!refund) throw new ApiError(404, 'Refund not found');
  return ok(res, { refund: { ...serializeRefund(refund), gatewayResponse: refund.gateway?.response || null } });
};

export const adminCreateRefund = async (req, res) => {
  const { refund, duplicate } = await createManualRefund(req.body || {}, req.auth?.sub);
  res.status(duplicate ? 200 : 201).json({
    success: true,
    data: { refund: serializeRefund(refund), duplicate },
    message: refund.status === 'processed'
      ? 'Refund processed'
      : refund.status === 'failed'
        ? `Refund failed: ${refund.failureReason || 'see gateway response'}`
        : `Refund ${refund.status}`,
  });
};

export const adminApproveRefund = async (req, res) => {
  const refund = await approveRefund(req.params.id, req.auth?.sub);
  return ok(res, { refund: serializeRefund(refund) }, refund.status === 'failed' ? `Refund failed: ${refund.failureReason}` : `Refund ${refund.status}`);
};

export const adminRejectRefund = async (req, res) => {
  const refund = await rejectRefund(req.params.id, req.auth?.sub, req.body?.reason);
  return ok(res, { refund: serializeRefund(refund) }, 'Refund rejected');
};

export const adminListLedger = async (req, res) => ok(res, await listLedgerEntries(req.query));

export const adminPaymentSummary = async (req, res) => ok(res, await getPaymentSummaryReport(req.query));

export const adminGetPaymentSettings = async (_req, res) => ok(res, { settings: await getPaymentSettings({ fresh: true }) });

export const adminUpdatePaymentSettings = async (req, res) =>
  ok(res, { settings: await updatePaymentSettings(req.body || {}) }, 'Payment settings updated');

export const adminListPaymentEvents = async (req, res) => ok(res, await listPaymentEvents(req.query));

export const adminProcessDueEvents = async (_req, res) => ok(res, { processed: await processDuePaymentEvents({ limit: 50 }) });

export const adminListPayouts = async (req, res) => ok(res, await listPayouts(req.query));

export const adminListOwnerWithdrawals = async (req, res) =>
  ok(res, await listOwnerWithdrawals({ ownerId: req.params.id, page: req.query.page, limit: req.query.limit }));

export const adminApproveOwnerWithdrawal = async (req, res) =>
  ok(res, await approveOwnerWithdrawalRequest(req.params.requestId, req.auth?.sub), 'Owner withdrawal approved');

export const adminRejectOwnerWithdrawal = async (req, res) =>
  ok(res, await rejectOwnerWithdrawalRequest(req.params.requestId), 'Owner withdrawal rejected');
