import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { PoolingBooking } from '../../admin/models/PoolingBooking.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { BusBooking } from '../../user/models/BusBooking.js';
import { Ride } from '../../user/models/Ride.js';
import { UserWallet } from '../../user/models/UserWallet.js';
import { Refund } from '../models/Refund.js';
import {
  buildIdempotencyKey,
  clampPagination,
  normalizePositiveAmount,
  roundMoney,
  toMinorUnits,
} from '../utils/paymentUtils.js';
import { createPhonePeRefund, razorpayApi } from './gatewayClients.js';
import { recordTransferSafe } from './ledgerService.js';
import { isAutoRefundEnabled } from './paymentSettingsService.js';

/// Refunds: one service for every cancel path (ride, pooling, bus, rental,
/// manual admin refunds), with a record per refund and a state machine
///   requested -> processing -> processed | failed      (failed -> processing on retry)
///   requested -> rejected
///
/// Automatic refunds are behind `payments.auto_refund_enabled` (default
/// '0'). With it off, cancel paths only create the Refund in `requested` and
/// an admin approves it from the panel — nothing leaves the platform without
/// a human until the setting is switched on.

const DUPLICATE_KEY = 11000;
const PROVIDERS = ['razorpay', 'phonepe', 'wallet'];
const ACTIVE_STATUSES = ['requested', 'processing', 'processed'];

const newRefundNumber = () =>
  `RFD${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const normalizeProvider = (provider) => {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'razor_pay') return 'razorpay';
  if (value === 'phone_pay') return 'phonepe';
  return value;
};

const toObjectIdOrNull = (value) => {
  if (!value) return null;
  const id = typeof value === 'object' && value._id ? value._id : value;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
};

export const serializeRefund = (refund = {}) => ({
  _id: refund._id ? String(refund._id) : undefined,
  refundNumber: refund.refundNumber,
  status: refund.status,
  provider: refund.provider,
  destination: refund.destination,
  amount: Number(refund.amount || 0),
  currency: refund.currency || 'INR',
  reason: refund.reason || '',
  userId: refund.userId ? String(refund.userId?._id || refund.userId) : null,
  user: refund.userId && typeof refund.userId === 'object' && refund.userId.name !== undefined
    ? { _id: String(refund.userId._id), name: refund.userId.name || '', phone: refund.userId.phone || '' }
    : undefined,
  reference: refund.reference || {},
  service: refund.service || '',
  gateway: {
    paymentId: refund.gateway?.paymentId || '',
    orderId: refund.gateway?.orderId || '',
    refundId: refund.gateway?.refundId || '',
    status: refund.gateway?.status || '',
  },
  initiatedBy: refund.initiatedBy || {},
  approvedBy: refund.approvedBy || '',
  approvedAt: refund.approvedAt || null,
  processedAt: refund.processedAt || null,
  failureReason: refund.failureReason || '',
  attempts: Number(refund.attempts || 0),
  metadata: refund.metadata || {},
  createdAt: refund.createdAt,
  updatedAt: refund.updatedAt,
});

/// Total already refunded or in flight for a payment, so two refunds can
/// never exceed what was captured.
export const getRefundedTotalForPayment = async (paymentId) => {
  if (!paymentId) return 0;
  const [row] = await Refund.aggregate([
    { $match: { 'gateway.paymentId': String(paymentId), status: { $in: ACTIVE_STATUSES } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return roundMoney(row?.total || 0);
};

const recordRefundLedger = (refund) => {
  const userAccount = refund.userId
    ? { type: 'user', id: String(refund.userId), wallet: refund.destination === 'source' ? 'source' : refund.destination === 'refund_wallet' ? 'refundWallet' : 'balance' }
    : { type: 'gateway', id: refund.provider };

  // Wallet refunds are mirrored by the UserWallet hook already (the wallet
  // credit carries `referenceKey: refund:<number>`); recording them here too
  // would double the line. Gateway refunds have no wallet row, so they are
  // recorded here.
  if (refund.provider === 'wallet') return;

  void recordTransferSafe(
    {
      from: { type: 'platform', id: 'platform' },
      to: userAccount,
      amount: refund.amount,
      category: 'refund',
      service: refund.service || '',
      description: refund.reason || `Refund ${refund.refundNumber}`,
      reference: { kind: 'refund', id: refund.refundNumber },
      gateway: {
        provider: refund.provider,
        orderId: refund.gateway?.orderId || '',
        paymentId: refund.gateway?.paymentId || '',
        refundId: refund.gateway?.refundId || '',
      },
      idempotencyKey: `refund:${refund.refundNumber}`,
      source: 'refund_service',
      metadata: { refundReference: refund.reference || {} },
    },
    { label: 'refund' },
  );
};

/// Side effects on the booking once a refund settles (or is queued).
const applyRefundSideEffects = async (refund) => {
  try {
    const kind = refund.reference?.kind;
    const id = refund.reference?.id;
    if (!kind || !mongoose.isValidObjectId(id)) return;

    if (kind === 'pooling_booking' && refund.status === 'processed') {
      await PoolingBooking.updateOne(
        { _id: id },
        { $set: { paymentStatus: 'refunded', 'payment.status': 'refunded' } },
      );
    }

    if (kind === 'bus_booking') {
      const seatIds = Array.isArray(refund.metadata?.seatIds) ? refund.metadata.seatIds : [];
      if (!seatIds.length) return;
      const perSeat = roundMoney(refund.amount / seatIds.length);
      const refundStatus = refund.status === 'processed'
        ? 'processed'
        : refund.status === 'requested'
          ? 'refund_requested'
          : refund.status;
      await BusBooking.updateOne(
        { _id: id },
        {
          $set: {
            'cancelledSeats.$[seat].refundStatus': refundStatus,
            'cancelledSeats.$[seat].refundAmount': perSeat,
            'cancelledSeats.$[seat].refundId': refund.gateway?.refundId || refund.refundNumber,
            ...(refund.status === 'processed' ? { 'cancelledSeats.$[seat].refundProcessedAt': refund.processedAt || new Date() } : {}),
          },
        },
        { arrayFilters: [{ 'seat.seatId': { $in: seatIds } }] },
      );
      if (refund.status === 'processed') {
        const booking = await BusBooking.findById(id).select('status').lean();
        await BusBooking.updateOne(
          { _id: id },
          { $set: { 'payment.status': booking?.status === 'cancelled' ? 'refunded' : 'partially_refunded' } },
        );
      }
    }
  } catch (error) {
    console.error('[refund] side effect failed:', refund.refundNumber, error?.message || error);
  }
};

const creditWalletForRefund = async (refund) => {
  if (!refund.userId) throw new ApiError(400, 'Wallet refund needs a userId');
  const walletField = refund.destination === 'refund_wallet' ? 'refundWallet' : 'balance';
  const referenceKey = `refund:${refund.refundNumber}`;

  await UserWallet.updateOne(
    { userId: refund.userId },
    { $setOnInsert: { userId: refund.userId, balance: 0, refundWallet: 0, transactions: [] } },
    { upsert: true },
  );

  // The Refund state machine already guarantees one credit per refund (only
  // the caller that moved it to `processing` gets here); the referenceKey
  // check guards the narrow crash-and-retry case.
  const existing = await UserWallet.findOne({ userId: refund.userId, 'transactions.referenceKey': referenceKey }).select('_id').lean();
  if (existing) return;

  await UserWallet.updateOne(
    { userId: refund.userId },
    {
      $inc: { [walletField]: refund.amount },
      $push: {
        transactions: {
          $each: [{
            kind: 'credit',
            amount: refund.amount,
            title: refund.reason ? `Refund: ${refund.reason}`.slice(0, 120) : 'Refund',
            provider: 'refund',
            referenceKey,
          }],
          $slice: -50,
        },
      },
    },
  );
};

const notifyUserOfRefund = async (refund) => {
  if (!refund.userId) return;
  try {
    const dispatch = await import('../../services/dispatchService.js');
    dispatch.getSocketServer?.()?.to(dispatch.getUserRoom(String(refund.userId))).emit('payment:refund:updated', {
      refundNumber: refund.refundNumber,
      status: refund.status,
      amount: refund.amount,
      provider: refund.provider,
      destination: refund.destination,
      reference: refund.reference,
    });
  } catch (error) {
    console.error('[refund] notify failed:', error?.message || error);
  }
};

const finishRefund = async (refundId, update) => {
  const refund = await Refund.findByIdAndUpdate(refundId, { $set: update }, { returnDocument: 'after' }).lean();
  if (refund) {
    if (refund.status === 'processed') recordRefundLedger(refund);
    await applyRefundSideEffects(refund);
    void notifyUserOfRefund(refund);
  }
  return refund;
};

/// Sends a refund to the gateway or wallet. Only the caller that moves the
/// refund from requested/failed to processing does the work, so approving
/// twice or racing an automatic refund cannot pay twice.
export const executeRefund = async (refundId, { approvedBy = '' } = {}) => {
  const claimed = await Refund.findOneAndUpdate(
    { _id: refundId, status: { $in: ['requested', 'failed'] } },
    {
      $set: {
        status: 'processing',
        failureReason: '',
        ...(approvedBy ? { approvedBy: String(approvedBy), approvedAt: new Date() } : {}),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  ).lean();

  if (!claimed) {
    const current = await Refund.findById(refundId).lean();
    if (!current) throw new ApiError(404, 'Refund not found');
    return current;
  }

  try {
    if (claimed.provider === 'wallet') {
      await creditWalletForRefund(claimed);
      return await finishRefund(claimed._id, { status: 'processed', processedAt: new Date(), 'gateway.status': 'processed' });
    }

    if (claimed.provider === 'razorpay') {
      if (!claimed.gateway?.paymentId) throw new ApiError(400, 'Razorpay refund needs a paymentId');
      const response = await razorpayApi({
        method: 'POST',
        path: `/payments/${encodeURIComponent(claimed.gateway.paymentId)}/refund`,
        body: {
          amount: toMinorUnits(claimed.amount),
          receipt: claimed.refundNumber,
          notes: {
            refundNumber: claimed.refundNumber,
            referenceKind: claimed.reference?.kind || '',
            referenceId: claimed.reference?.id || '',
          },
        },
      });
      const gatewayStatus = String(response?.status || '').toLowerCase();
      return await finishRefund(claimed._id, {
        status: gatewayStatus === 'processed' ? 'processed' : gatewayStatus === 'failed' ? 'failed' : 'processing',
        processedAt: gatewayStatus === 'processed' ? new Date() : null,
        'gateway.refundId': String(response?.id || ''),
        'gateway.status': gatewayStatus,
        'gateway.response': response,
      });
    }

    if (claimed.provider === 'phonepe') {
      if (!claimed.gateway?.orderId) throw new ApiError(400, 'PhonePe refund needs the original merchant order id');
      const response = await createPhonePeRefund({
        merchantRefundId: claimed.refundNumber,
        originalMerchantOrderId: claimed.gateway.orderId,
        amountPaise: toMinorUnits(claimed.amount),
      });
      const state = String(response?.state || '').toUpperCase();
      return await finishRefund(claimed._id, {
        status: state === 'COMPLETED' ? 'processed' : state === 'FAILED' ? 'failed' : 'processing',
        processedAt: state === 'COMPLETED' ? new Date() : null,
        'gateway.refundId': String(response?.refundId || ''),
        'gateway.status': state.toLowerCase(),
        'gateway.response': JSON.parse(JSON.stringify(response || {})),
      });
    }

    throw new ApiError(400, `Unsupported refund provider ${claimed.provider}`);
  } catch (error) {
    console.error('[refund] execution failed:', claimed.refundNumber, error?.message || error);
    return finishRefund(claimed._id, {
      status: 'failed',
      failureReason: String(error?.message || 'Refund failed').slice(0, 500),
    });
  }
};

/// Creates a refund (and sends it, when allowed).
///
/// @param {object} input
/// @param {'razorpay'|'phonepe'|'wallet'} input.provider  where the money came from
/// @param {string} [input.paymentId]   gateway payment id (Razorpay pay_xxx / PhonePe transaction id)
/// @param {string} [input.orderId]     gateway order id (required for PhonePe refunds)
/// @param {number} input.amount        rupees
/// @param {string} [input.reason]
/// @param {{kind: string, id: string}} input.reference  what is being refunded
/// @param {boolean|'refund_wallet'} [input.toWallet]  credit the user wallet (true) or refundWallet instead of the source
/// @param {string} [input.userId]      required for wallet refunds; recorded for every refund
/// @param {string} [input.service]     ride | parcel | intercity | rental | bus | pooling ...
/// @param {object} [input.initiatedBy] { type: 'admin'|'user'|'system', id }
/// @param {boolean} [input.autoProcess] true: send now; false: queue; undefined: follow the setting
/// @param {string} [input.idempotencyKey]  defaults to reference + payment + amount
/// @returns {Promise<{ refund: object, duplicate: boolean }>}
export const refundPayment = async ({
  provider,
  paymentId = '',
  orderId = '',
  amount,
  reason = '',
  reference = {},
  toWallet = false,
  userId = null,
  service = '',
  initiatedBy = { type: 'system', id: '' },
  autoProcess,
  idempotencyKey = '',
  metadata = {},
} = {}) => {
  const normalizedAmount = normalizePositiveAmount(amount);
  if (!normalizedAmount) throw new ApiError(400, 'Refund amount must be greater than zero');
  if (!reference?.kind || !reference?.id) throw new ApiError(400, 'Refund reference.kind and reference.id are required');

  let normalizedProvider = normalizeProvider(provider);
  const destination = toWallet === 'refund_wallet' ? 'refund_wallet' : toWallet ? 'wallet' : 'source';
  if (destination !== 'source') normalizedProvider = 'wallet';
  if (!PROVIDERS.includes(normalizedProvider)) {
    throw new ApiError(400, `Refund provider must be one of ${PROVIDERS.join(', ')}`);
  }
  if (normalizedProvider === 'wallet' && !userId) throw new ApiError(400, 'userId is required for a wallet refund');

  const key = idempotencyKey || buildIdempotencyKey(
    'refund',
    reference.kind,
    reference.id,
    paymentId || orderId || 'wallet',
    toMinorUnits(normalizedAmount),
  );

  const existing = await Refund.findOne({ idempotencyKey: key }).lean();
  if (existing) return { refund: existing, duplicate: true };

  if (paymentId) {
    const capturedAmount = Number(metadata?.capturedAmount || 0);
    if (capturedAmount > 0) {
      const alreadyRefunded = await getRefundedTotalForPayment(paymentId);
      if (roundMoney(alreadyRefunded + normalizedAmount) - capturedAmount > 0.001) {
        throw new ApiError(409, `Refund would exceed the captured amount (captured ${capturedAmount}, already refunded ${alreadyRefunded})`);
      }
    }
  }

  let refund;
  try {
    refund = await Refund.create({
      refundNumber: newRefundNumber(),
      status: 'requested',
      provider: normalizedProvider,
      destination,
      amount: normalizedAmount,
      reason: String(reason || '').trim(),
      userId: toObjectIdOrNull(userId),
      reference: { kind: String(reference.kind), id: String(reference.id) },
      service: String(service || '').trim().toLowerCase(),
      gateway: { paymentId: String(paymentId || ''), orderId: String(orderId || '') },
      idempotencyKey: key,
      initiatedBy: { type: String(initiatedBy?.type || 'system'), id: String(initiatedBy?.id || '') },
      metadata,
    });
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
    return { refund: await Refund.findOne({ idempotencyKey: key }).lean(), duplicate: true };
  }

  const shouldProcess = autoProcess === undefined ? await isAutoRefundEnabled() : Boolean(autoProcess);
  if (!shouldProcess) {
    const queued = refund.toObject();
    await applyRefundSideEffects(queued);
    return { refund: queued, duplicate: false };
  }

  return {
    refund: await executeRefund(refund._id, { approvedBy: initiatedBy?.type === 'admin' ? initiatedBy.id : '' }),
    duplicate: false,
  };
};

/// Never-throwing wrapper for cancel paths: a refund problem must not fail
/// the cancel itself. Returns the refund or null.
export const refundPaymentSafely = async (input, label = 'refund') => {
  try {
    const { refund } = await refundPayment(input);
    return refund;
  } catch (error) {
    console.error(`[refund] ${label} could not be created:`, error?.message || error);
    return null;
  }
};

export const approveRefund = async (refundId, adminId = '') => {
  if (!mongoose.isValidObjectId(refundId)) throw new ApiError(400, 'Valid refund id is required');
  const refund = await Refund.findById(refundId).lean();
  if (!refund) throw new ApiError(404, 'Refund not found');
  if (!['requested', 'failed'].includes(refund.status)) {
    throw new ApiError(409, `Only requested or failed refunds can be approved (this one is ${refund.status})`);
  }
  return executeRefund(refundId, { approvedBy: adminId });
};

export const rejectRefund = async (refundId, adminId = '', reason = '') => {
  if (!mongoose.isValidObjectId(refundId)) throw new ApiError(400, 'Valid refund id is required');
  const refund = await Refund.findOneAndUpdate(
    { _id: refundId, status: { $in: ['requested', 'failed'] } },
    {
      $set: {
        status: 'rejected',
        approvedBy: String(adminId || ''),
        approvedAt: new Date(),
        failureReason: String(reason || 'Rejected by admin').slice(0, 500),
      },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!refund) throw new ApiError(409, 'Only requested or failed refunds can be rejected');
  await applyRefundSideEffects(refund);
  return refund;
};

export const listRefunds = async (query = {}) => {
  const { page, limit, skip } = clampPagination(query, { defaultLimit: 20, maxLimit: 100 });
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(',').map((item) => item.trim()).filter(Boolean) };
  if (query.provider) filter.provider = String(query.provider);
  if (query.service) filter.service = String(query.service).toLowerCase();
  if (query.referenceKind) filter['reference.kind'] = String(query.referenceKind);
  if (query.referenceId) filter['reference.id'] = String(query.referenceId);
  if (query.userId && mongoose.isValidObjectId(query.userId)) filter.userId = query.userId;
  if (query.search) {
    const pattern = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { refundNumber: pattern },
      { 'reference.id': pattern },
      { 'gateway.paymentId': pattern },
      { 'gateway.refundId': pattern },
      { reason: pattern },
    ];
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  const [items, total, statusCounts] = await Promise.all([
    Refund.find(filter).populate('userId', 'name phone').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Refund.countDocuments(filter),
    Refund.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
  ]);

  return {
    results: items.map(serializeRefund),
    counts: Object.fromEntries(statusCounts.map((row) => [row._id, { count: row.count, amount: roundMoney(row.amount) }])),
    paginator: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
  };
};

/// Resolves what was paid for a booking, so an admin can refund "ride X"
/// without knowing gateway ids.
export const resolveRefundablePayment = async ({ kind, id }) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Valid reference id is required');

  if (kind === 'ride') {
    const ride = await Ride.findById(id).select('userId fare serviceType paymentMethod driverPaymentCollection').lean();
    if (!ride) throw new ApiError(404, 'Ride not found');
    const collection = ride.driverPaymentCollection || {};
    const paid = Boolean(collection.paidAt) || ['paid', 'captured', 'completed'].includes(String(collection.status || ''));
    return {
      userId: ride.userId,
      provider: paid ? normalizeProvider(collection.provider || '') : '',
      paymentId: paid ? collection.providerPaymentId || collection.providerId || '' : '',
      orderId: paid ? collection.providerOrderId || '' : '',
      capturedAmount: paid ? Number(collection.amount || ride.fare || 0) : 0,
      service: ride.serviceType === 'parcel' ? 'parcel' : ride.serviceType === 'intercity' ? 'intercity' : 'ride',
    };
  }

  if (kind === 'bus_booking') {
    const booking = await BusBooking.findById(id).select('userId amount payment').lean();
    if (!booking) throw new ApiError(404, 'Bus booking not found');
    return {
      userId: booking.userId,
      provider: normalizeProvider(booking.payment?.provider || 'razorpay'),
      paymentId: booking.payment?.paymentId || '',
      orderId: booking.payment?.orderId || '',
      capturedAmount: Number(booking.amount || 0),
      service: 'bus',
    };
  }

  if (kind === 'pooling_booking') {
    const booking = await PoolingBooking.findById(id).select('user fare payment paymentStatus').lean();
    if (!booking) throw new ApiError(404, 'Pooling booking not found');
    return {
      userId: booking.user,
      provider: normalizeProvider(booking.payment?.provider || 'razorpay'),
      paymentId: booking.payment?.paymentId || '',
      orderId: booking.payment?.orderId || '',
      capturedAmount: Number(booking.fare || 0),
      service: 'pooling',
    };
  }

  if (kind === 'rental_booking') {
    const booking = await RentalBookingRequest.findById(id).select('userId payment').lean();
    if (!booking) throw new ApiError(404, 'Rental booking not found');
    return {
      userId: booking.userId,
      provider: normalizeProvider(booking.payment?.provider || ''),
      paymentId: booking.payment?.paymentId || '',
      orderId: booking.payment?.orderId || '',
      capturedAmount: Number(booking.payment?.amount || 0),
      service: 'rental',
    };
  }

  throw new ApiError(400, 'reference kind must be ride, bus_booking, pooling_booking or rental_booking');
};

/// Admin-initiated refund for any ride/booking. Sent immediately (an admin
/// asked for it) unless `queue` is true.
export const createManualRefund = async (payload = {}, adminId = '') => {
  const kind = String(payload.referenceKind || payload.reference?.kind || '').trim();
  const id = String(payload.referenceId || payload.reference?.id || '').trim();
  const destination = String(payload.destination || 'source').trim().toLowerCase();
  const reason = String(payload.reason || 'Manual refund by admin').trim();

  let resolved = {};
  if (['ride', 'bus_booking', 'pooling_booking', 'rental_booking'].includes(kind)) {
    resolved = await resolveRefundablePayment({ kind, id });
  } else if (!kind || !id) {
    throw new ApiError(400, 'referenceKind and referenceId are required');
  }

  const provider = normalizeProvider(payload.provider || resolved.provider || '');
  const paymentId = String(payload.paymentId || resolved.paymentId || '');
  const userId = payload.userId || resolved.userId || null;
  const amount = normalizePositiveAmount(payload.amount ?? resolved.capturedAmount);
  const toWallet = destination === 'wallet' ? true : destination === 'refund_wallet' ? 'refund_wallet' : false;

  if (!toWallet && !['razorpay', 'phonepe'].includes(provider)) {
    throw new ApiError(409, 'No online payment found for this booking; refund to wallet instead (destination: "wallet")');
  }
  if (!toWallet && !paymentId && provider === 'razorpay') {
    throw new ApiError(409, 'The booking has no gateway payment id to refund');
  }

  return refundPayment({
    provider: toWallet ? 'wallet' : provider,
    paymentId,
    orderId: String(payload.orderId || resolved.orderId || ''),
    amount,
    reason,
    reference: { kind, id },
    toWallet,
    userId,
    service: payload.service || resolved.service || '',
    initiatedBy: { type: 'admin', id: String(adminId || '') },
    autoProcess: payload.queue === true || payload.queue === 'true' ? false : true,
    // A manual refund is a deliberate new action, so it gets its own key and
    // is never collapsed into an earlier automatic refund for the same
    // booking. The captured-amount check below still stops over-refunds.
    idempotencyKey: payload.idempotencyKey
      ? buildIdempotencyKey('refund', 'manual', String(payload.idempotencyKey))
      : buildIdempotencyKey('refund', 'manual', kind, id, crypto.randomUUID()),
    metadata: { capturedAmount: Number(resolved.capturedAmount || payload.capturedAmount || 0), note: payload.note || '' },
  });
};

// ---- Cancel-path hooks (one call each from the existing cancel code) ----

/// Admin cancelled a ride: refund any captured online payment.
export const refundRideOnCancel = async ({ ride, reason = 'Ride cancelled by admin', initiatedBy = { type: 'admin', id: '' } } = {}) => {
  try {
    if (!ride?._id) return null;
    const collection = ride.driverPaymentCollection || {};
    const paid = Boolean(collection.paidAt) || ['paid', 'captured', 'completed'].includes(String(collection.status || '').toLowerCase());
    if (!paid) return null;

    const provider = normalizeProvider(collection.provider || '');
    const paymentId = collection.providerPaymentId || collection.providerId || '';
    const amount = normalizePositiveAmount(collection.amount || ride.fare);
    if (!amount) return null;

    const isWallet = provider === 'wallet';
    if (!isWallet && !['razorpay', 'phonepe'].includes(provider)) return null;

    return refundPaymentSafely({
      provider: isWallet ? 'wallet' : provider,
      paymentId,
      orderId: collection.providerOrderId || '',
      amount,
      reason,
      reference: { kind: 'ride', id: String(ride._id) },
      toWallet: isWallet,
      userId: ride.userId,
      service: ride.serviceType === 'parcel' ? 'parcel' : ride.serviceType === 'intercity' ? 'intercity' : 'ride',
      initiatedBy,
      idempotencyKey: buildIdempotencyKey('refund', 'ride_cancel', String(ride._id)),
      metadata: { capturedAmount: amount, rideStatusAtCancel: ride.status },
    }, 'ride cancel');
  } catch (error) {
    console.error('[refund] ride cancel hook failed:', error?.message || error);
    return null;
  }
};

/// Pooling booking cancelled (admin status change): refund per paymentStatus.
export const refundPoolingBookingOnCancel = async ({ booking, reason = 'Pooling booking cancelled', initiatedBy = { type: 'admin', id: '' } } = {}) => {
  try {
    if (!booking?._id) return null;
    if (String(booking.paymentStatus || '') !== 'paid') return null;
    const paymentId = booking.payment?.paymentId || '';
    const amount = normalizePositiveAmount(booking.fare);
    if (!paymentId || !amount) return null;

    return refundPaymentSafely({
      provider: normalizeProvider(booking.payment?.provider || 'razorpay'),
      paymentId,
      orderId: booking.payment?.orderId || '',
      amount,
      reason,
      reference: { kind: 'pooling_booking', id: String(booking._id) },
      userId: booking.user,
      service: 'pooling',
      initiatedBy,
      idempotencyKey: buildIdempotencyKey('refund', 'pooling_cancel', String(booking._id)),
      metadata: { capturedAmount: amount },
    }, 'pooling cancel');
  } catch (error) {
    console.error('[refund] pooling cancel hook failed:', error?.message || error);
    return null;
  }
};

/// Admin released bus seats: refund the seats' share of the payment.
export const refundBusSeatsOnAdminCancel = async ({ booking, seatIds = [], reason = 'Bus seats cancelled by admin', initiatedBy = { type: 'admin', id: '' } } = {}) => {
  try {
    if (!booking?._id || !seatIds.length) return null;
    const paymentStatus = String(booking.payment?.status || '').toLowerCase();
    if (!['paid', 'partially_refunded', 'cancelled', 'refunded'].includes(paymentStatus) && !booking.payment?.paidAt) return null;
    const paymentId = booking.payment?.paymentId || '';
    const totalSeats = Array.isArray(booking.seatIds) ? booking.seatIds.length : 0;
    if (!paymentId || !totalSeats) return null;

    const amount = normalizePositiveAmount((Number(booking.amount || 0) / totalSeats) * seatIds.length);
    if (!amount) return null;

    const sortedSeats = [...seatIds].map(String).sort();
    return refundPaymentSafely({
      provider: normalizeProvider(booking.payment?.provider || 'razorpay'),
      paymentId,
      orderId: booking.payment?.orderId || '',
      amount,
      reason,
      reference: { kind: 'bus_booking', id: String(booking._id) },
      userId: booking.userId,
      service: 'bus',
      initiatedBy,
      idempotencyKey: buildIdempotencyKey('refund', 'bus_admin_cancel', String(booking._id), sortedSeats.join('-')),
      metadata: { capturedAmount: Number(booking.amount || 0), seatIds: sortedSeats },
    }, 'bus admin cancel');
  } catch (error) {
    console.error('[refund] bus admin cancel hook failed:', error?.message || error);
    return null;
  }
};

// ---- Gateway webhooks ----

export const applyRazorpayRefundWebhook = async ({ refundEntity, event }) => {
  if (!refundEntity?.id) return { status: 'ignored', reason: 'no_refund_entity' };
  const refundNumber = refundEntity?.notes?.refundNumber || refundEntity?.receipt || '';
  const refund = await Refund.findOne({
    $or: [
      { 'gateway.refundId': refundEntity.id },
      ...(refundNumber ? [{ refundNumber }] : []),
    ],
  }).lean();
  if (!refund) return { status: 'ignored', reason: 'refund_not_created_here' };
  if (['processed', 'rejected'].includes(refund.status)) return { status: 'existing', refundNumber: refund.refundNumber };

  const processed = event === 'refund.processed';
  const updated = await finishRefund(refund._id, {
    status: processed ? 'processed' : 'failed',
    processedAt: processed ? new Date() : null,
    'gateway.refundId': refundEntity.id,
    'gateway.status': String(refundEntity.status || (processed ? 'processed' : 'failed')),
    ...(processed ? {} : { failureReason: 'Gateway reported refund failure' }),
  });
  return { status: 'processed', refundNumber: updated?.refundNumber, refundStatus: updated?.status };
};

export const applyPhonePeRefundWebhook = async ({ payload, completed }) => {
  const merchantRefundId = String(payload?.merchantRefundId || '').trim();
  const refundId = String(payload?.refundId || '').trim();
  const refund = await Refund.findOne({
    $or: [
      ...(merchantRefundId ? [{ refundNumber: merchantRefundId }] : []),
      ...(refundId ? [{ 'gateway.refundId': refundId }] : []),
    ],
  }).lean();
  if (!refund) return { status: 'ignored', reason: 'refund_not_created_here' };
  if (['processed', 'rejected'].includes(refund.status)) return { status: 'existing', refundNumber: refund.refundNumber };

  const updated = await finishRefund(refund._id, {
    status: completed ? 'processed' : 'failed',
    processedAt: completed ? new Date() : null,
    ...(refundId ? { 'gateway.refundId': refundId } : {}),
    'gateway.status': String(payload?.state || '').toLowerCase(),
    ...(completed ? {} : { failureReason: payload?.errorCode || 'Gateway reported refund failure' }),
  });
  return { status: 'processed', refundNumber: updated?.refundNumber, refundStatus: updated?.status };
};
