import { ApiError } from '../../../../utils/ApiError.js';
import { resolveGatewayWebhookCredentials } from '../../services/paymentGatewayService.js';
import { PaymentEvent } from '../models/PaymentEvent.js';
import { PaymentOrder } from '../models/PaymentOrder.js';
import {
  buildIdempotencyKey,
  classifyPhonePeMerchantOrder,
  classifyRazorpayOrder,
  fromMinorUnits,
  parseRazorpayWebhookEvent,
  verifyPhonePeCallbackAuthorization,
  verifyRazorpayWebhookSignature,
} from '../utils/paymentUtils.js';
import {
  fetchPhonePeOrderStatus,
  fetchRazorpayOrder,
  summarizePhonePeOrderStatus,
} from './gatewayClients.js';
import { recordTransferSafe } from './ledgerService.js';
import {
  checkRentalAdvancePayment,
  creditDriverWalletFromGateway,
  creditUserWalletFromGateway,
  findPaymentOrder,
  settleBusBookingPayment,
  settleRideGatewayPayment,
} from './paymentSettlementService.js';
import { applyPhonePeRefundWebhook, applyRazorpayRefundWebhook, refundPaymentSafely } from './refundService.js';
import { applyRazorpayPayoutWebhook } from './payoutService.js';

/// Gateway webhooks: verify, record once, settle.
///
/// Every delivery is inserted into PaymentEvent first; the unique
/// (provider, eventId) index makes redeliveries no-ops. A delivery whose
/// processing threw is stored `failed` and retried by the gateway's next
/// delivery of the same event.
///
/// Some captures are not settled immediately but `deferred`: ride payments
/// and bus bookings are normally settled by the app's verify call a second
/// later, and those verify paths have their own duplicate checks rather than
/// the settlement claim. Waiting a couple of minutes lets the app win when it
/// is alive; the webhook only settles what the app never did (app killed).

const DEFER_SECONDS = {
  ride_completion: 120,
  ride_tip: 120,
  bus_booking: 90,
  // The rental booking is created by the app after the advance is verified,
  // possibly minutes later; only call it orphaned after a generous wait.
  rental_advance: 30 * 60,
};

const DUPLICATE_KEY = 11000;

const toPlain = (value) => {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
};

/// Inserts the event or reports it as a duplicate. A previously failed
/// event is re-claimed for another attempt.
const claimEvent = async ({ provider, eventId, event, entityId = '', payload }) => {
  try {
    const created = await PaymentEvent.create({
      provider,
      eventId,
      event,
      entityId,
      status: 'processing',
      attempts: 1,
      payload: toPlain(payload),
    });
    return { claimed: true, event: created.toObject() };
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
    const retried = await PaymentEvent.findOneAndUpdate(
      {
        provider,
        eventId,
        $or: [
          { status: 'failed' },
          // An instance that died mid-processing leaves the event stuck.
          { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
        ],
      },
      { $set: { status: 'processing', error: '' }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (retried) return { claimed: true, event: retried };
    return { claimed: false, event: await PaymentEvent.findOne({ provider, eventId }).lean() };
  }
};

const finishEvent = (id, { status, result = {}, error = '', extra = {} }) =>
  PaymentEvent.updateOne(
    { _id: id },
    {
      $set: {
        status,
        result: toPlain(result),
        error: String(error || '').slice(0, 500),
        processedAt: status === 'processed' || status === 'ignored' ? new Date() : null,
        ...extra,
      },
    },
  );

const recordGatewayCollection = ({ provider, paymentId, orderId, amount, purpose, payer }) => {
  if (!paymentId || !(amount > 0)) return;
  void recordTransferSafe(
    {
      from: payer?.id ? { type: payer.type, id: String(payer.id), wallet: 'source' } : { type: 'platform', id: 'unattributed' },
      to: { type: 'gateway', id: provider },
      amount,
      category: 'gateway_collection',
      service: purpose === 'bus_booking' ? 'bus' : purpose === 'rental_advance' ? 'rental' : purpose.startsWith('ride') ? 'ride' : 'wallet',
      description: `Captured by ${provider} (${purpose})`,
      reference: { kind: 'gateway_payment', id: paymentId },
      gateway: { provider, orderId: orderId || '', paymentId },
      idempotencyKey: buildIdempotencyKey('capture', provider, paymentId),
      source: 'webhook',
      metadata: { purpose },
    },
    { label: 'gateway_collection' },
  );
};

// ---------------- Razorpay ----------------

const settleRazorpayCapture = async ({ purpose, payment, order, notes }) => {
  const paymentId = String(payment.id);
  const orderId = String(payment.order_id || order?.id || '');
  const amount = fromMinorUnits(payment.amount);

  // A wallet order without its owner id cannot be settled; failing would
  // only make the gateway retry for a day. Leave it visible as ignored.
  if (purpose === 'user_wallet_topup' && !notes.userId) return { status: 'ignored', reason: 'order has no userId' };
  if (purpose === 'driver_wallet_topup' && !notes.driverId) return { status: 'ignored', reason: 'order has no driverId' };
  if ((purpose === 'ride_completion' || purpose === 'ride_tip') && !notes.rideId) return { status: 'ignored', reason: 'order has no rideId' };

  if (purpose === 'user_wallet_topup') {
    return creditUserWalletFromGateway({
      userId: String(notes.userId || ''),
      amount,
      provider: 'razorpay',
      orderId,
      paymentId,
      settledVia: 'webhook',
    });
  }

  if (purpose === 'driver_wallet_topup') {
    return creditDriverWalletFromGateway({
      driverId: String(notes.driverId || ''),
      amount,
      provider: 'razorpay',
      orderId,
      paymentId,
      settledVia: 'webhook',
    });
  }

  if (purpose === 'ride_completion' || purpose === 'ride_tip') {
    return settleRideGatewayPayment({
      purpose,
      rideId: String(notes.rideId || ''),
      orderId,
      paymentId,
      amount,
      notes,
      provider: 'razorpay',
      settledVia: 'webhook',
    });
  }

  if (purpose === 'bus_booking') {
    const result = await settleBusBookingPayment({ orderId, paymentId });
    if (result.status === 'orphaned') {
      const refund = await refundPaymentSafely({
        provider: 'razorpay',
        paymentId,
        orderId,
        amount,
        reason: `Bus payment captured but booking not confirmed (${result.reason})`,
        reference: { kind: result.bookingId ? 'bus_booking' : 'gateway_payment', id: result.bookingId || paymentId },
        userId: result.userId || notes.userId || null,
        service: 'bus',
        idempotencyKey: buildIdempotencyKey('refund', 'orphan_capture', 'razorpay', paymentId),
        metadata: { capturedAmount: amount, orphanReason: result.reason },
      }, 'orphan bus capture');
      return { ...result, refundNumber: refund?.refundNumber || '' };
    }
    return result;
  }

  if (purpose === 'rental_advance') {
    const result = await checkRentalAdvancePayment({ orderId, paymentId });
    if (result.status === 'orphaned') {
      const refund = await refundPaymentSafely({
        provider: 'razorpay',
        paymentId,
        orderId,
        amount,
        reason: 'Rental advance captured but no rental booking was created',
        reference: { kind: 'gateway_payment', id: paymentId },
        userId: notes.userId || null,
        service: 'rental',
        idempotencyKey: buildIdempotencyKey('refund', 'orphan_capture', 'razorpay', paymentId),
        metadata: { capturedAmount: amount, orphanReason: result.reason },
      }, 'orphan rental capture');
      return { ...result, refundNumber: refund?.refundNumber || '' };
    }
    return result;
  }

  return { status: 'ignored', reason: `no settlement for ${purpose}` };
};

const handleRazorpayPaymentCaptured = async ({ eventDoc, parsed }) => {
  const payment = parsed.payment;
  if (!payment?.id) return { status: 'ignored', result: { reason: 'no_payment_entity' } };

  // Order notes carry the user/driver/ride id the create-order handler wrote.
  // Payment notes win for payment links, whose order has none.
  let order = null;
  if (payment.order_id) {
    order = await fetchRazorpayOrder(payment.order_id).catch((error) => {
      console.error('[webhook] razorpay order fetch failed:', payment.order_id, error?.message || error);
      return null;
    });
  }
  const notes = { ...(order?.notes || {}), ...(payment.notes || {}) };
  const purpose = classifyRazorpayOrder({ notes, receipt: order?.receipt || '' });
  const amount = fromMinorUnits(payment.amount);
  const payer = notes.userId
    ? { type: 'user', id: notes.userId }
    : notes.driverId && purpose === 'driver_wallet_topup'
      ? { type: 'driver', id: notes.driverId }
      : null;

  recordGatewayCollection({ provider: 'razorpay', paymentId: payment.id, orderId: payment.order_id, amount, purpose, payer });

  const meta = {
    purpose,
    paymentId: String(payment.id),
    orderId: String(payment.order_id || ''),
    amount,
  };

  if (DEFER_SECONDS[purpose]) {
    return {
      status: 'deferred',
      extra: { ...meta, processAfter: new Date(Date.now() + DEFER_SECONDS[purpose] * 1000) },
      result: { deferredSeconds: DEFER_SECONDS[purpose], notes, receipt: order?.receipt || '' },
    };
  }

  if (purpose === 'unknown' || purpose === 'driver_collection' || purpose === 'ride_other') {
    // Driver QR collections are settled by the driver app's status poll
    // (getDriverPaymentQrStatus), which re-reads the QR/payment link.
    return { status: 'ignored', extra: meta, result: { reason: `not settled by webhook: ${purpose}` } };
  }

  const result = await settleRazorpayCapture({ purpose, payment, order, notes });
  return { status: 'processed', extra: meta, result };
};

const handleRazorpayPaymentFailed = async ({ parsed }) => {
  const payment = parsed.payment;
  if (payment?.order_id) {
    await PaymentOrder.updateOne(
      { provider: 'razorpay', orderId: payment.order_id, status: 'created' },
      { $set: { status: 'failed', lastError: String(payment.error_description || payment.error_reason || 'payment failed') } },
    );
  }
  return {
    status: 'processed',
    extra: { paymentId: String(payment?.id || ''), orderId: String(payment?.order_id || ''), amount: fromMinorUnits(payment?.amount || 0) },
    result: { reason: payment?.error_description || '' },
  };
};

const dispatchRazorpayEvent = async ({ eventDoc, parsed }) => {
  switch (parsed.event) {
    case 'payment.captured':
      return handleRazorpayPaymentCaptured({ eventDoc, parsed });
    case 'payment.failed':
      return handleRazorpayPaymentFailed({ eventDoc, parsed });
    case 'refund.processed':
    case 'refund.failed':
      return { status: 'processed', result: await applyRazorpayRefundWebhook({ refundEntity: parsed.refund, event: parsed.event }) };
    case 'payout.processed':
    case 'payout.failed':
    case 'payout.reversed':
    case 'payout.rejected':
    case 'payout.updated':
      return { status: 'processed', result: await applyRazorpayPayoutWebhook({ payoutEntity: parsed.payout, event: parsed.event }) };
    default:
      return { status: 'ignored', result: { reason: `unhandled event ${parsed.event}` } };
  }
};

/// Verifies and processes one Razorpay webhook delivery.
///
/// @param {{ rawBody: Buffer|string, signature: string, eventIdHeader?: string }} input
/// @returns {Promise<{ status: string, duplicate?: boolean, eventId: string }>}
export const handleRazorpayWebhook = async ({ rawBody, signature, eventIdHeader = '' }) => {
  const { webhookSecret } = await resolveGatewayWebhookCredentials('razor_pay');
  if (!webhookSecret) {
    throw new ApiError(503, 'Razorpay webhook secret is not configured');
  }
  if (!verifyRazorpayWebhookSignature({ rawBody, signature, secret: webhookSecret })) {
    throw new ApiError(401, 'Invalid Razorpay webhook signature');
  }

  let body;
  try {
    body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    throw new ApiError(400, 'Webhook body is not valid JSON');
  }

  const parsed = parseRazorpayWebhookEvent(body);
  const eventId = String(eventIdHeader || '').trim() || `${parsed.event}:${parsed.entityId}:${parsed.createdAt || ''}`;
  const { claimed, event: eventDoc } = await claimEvent({
    provider: 'razorpay',
    eventId,
    event: parsed.event,
    entityId: parsed.entityId,
    payload: body,
  });

  if (!claimed) {
    return { status: eventDoc?.status || 'duplicate', duplicate: true, eventId };
  }

  try {
    const outcome = await dispatchRazorpayEvent({ eventDoc, parsed });
    await finishEvent(eventDoc._id, outcome);
    if (outcome.status === 'deferred') ensureSweeperRunning();
    return { status: outcome.status, eventId };
  } catch (error) {
    console.error('[webhook] razorpay processing failed:', eventId, error?.message || error);
    await finishEvent(eventDoc._id, { status: 'failed', error: error?.message || 'processing failed' });
    // 500 makes Razorpay retry the delivery, which re-runs the failed event.
    throw new ApiError(500, 'Webhook processing failed; will be retried');
  }
};

// ---------------- PhonePe ----------------

const normalizePhonePeEvent = (body = {}) => {
  const raw = body?.event ?? body?.type ?? '';
  return String(raw).trim().toLowerCase().replace(/_/g, '.');
};

/// Same status check the `/wallet/phonepe/status/:id` endpoints make, then the
/// same credit. Used by the webhook and the (previously log-only) callback.
export const settlePhonePeOrder = async ({ merchantOrderId, settledVia = 'webhook' }) => {
  const purpose = classifyPhonePeMerchantOrder(merchantOrderId);
  const statusPayload = await fetchPhonePeOrderStatus(merchantOrderId);
  const { state, paymentId, amount } = summarizePhonePeOrderStatus(merchantOrderId, statusPayload);

  if (state !== 'COMPLETED') {
    if (state === 'FAILED') {
      await PaymentOrder.updateOne(
        { provider: 'phonepe', orderId: merchantOrderId, status: 'created' },
        { $set: { status: 'failed', lastError: 'PhonePe reported FAILED' } },
      );
    }
    return { status: state === 'PENDING' ? 'pending' : 'not_completed', state, purpose };
  }

  const remembered = await findPaymentOrder('phonepe', merchantOrderId);
  const ownerId = remembered?.owner?.id || '';
  recordGatewayCollection({
    provider: 'phonepe',
    paymentId,
    orderId: merchantOrderId,
    amount,
    purpose,
    payer: remembered?.owner?.type === 'user' ? { type: 'user', id: ownerId } : remembered?.owner?.type === 'driver' ? { type: 'driver', id: ownerId } : null,
  });

  if (purpose === 'user_wallet_topup' || purpose === 'driver_wallet_topup') {
    if (!ownerId) {
      // Order created before orders were remembered: the app's status poll
      // will still settle it when the user reopens the wallet screen.
      return { status: 'unattributed', purpose, paymentId, amount };
    }
    const result = purpose === 'user_wallet_topup'
      ? await creditUserWalletFromGateway({ userId: ownerId, amount, provider: 'phonepe', orderId: merchantOrderId, paymentId, settledVia })
      : await creditDriverWalletFromGateway({ driverId: ownerId, amount, provider: 'phonepe', orderId: merchantOrderId, paymentId, settledVia });
    return { status: result.status, purpose, paymentId, amount };
  }

  return { status: 'ignored', purpose, paymentId, amount };
};

/// Verifies and processes one PhonePe webhook/callback.
///
/// @param {{ authorization: string, body: object }} input
export const handlePhonePeWebhook = async ({ authorization, body }) => {
  const { username, password } = await resolveGatewayWebhookCredentials('phone_pay');
  if (!username || !password) {
    throw new ApiError(503, 'PhonePe webhook credentials are not configured');
  }
  if (!verifyPhonePeCallbackAuthorization({ authorization, username, password })) {
    throw new ApiError(401, 'Invalid PhonePe callback authorization');
  }

  const event = normalizePhonePeEvent(body);
  const payload = body?.payload || {};
  const merchantOrderId = String(payload.merchantOrderId || payload.originalMerchantOrderId || '').trim();
  const eventId = buildIdempotencyKey(
    'phonepe',
    event || 'unknown',
    payload.orderId || merchantOrderId || 'none',
    payload.refundId || payload.merchantRefundId || '',
    payload.state || '',
  );

  const { claimed, event: eventDoc } = await claimEvent({
    provider: 'phonepe',
    eventId,
    event,
    entityId: String(payload.refundId || payload.orderId || ''),
    payload: body,
  });
  if (!claimed) return { status: eventDoc?.status || 'duplicate', duplicate: true, eventId };

  try {
    let outcome;
    if (event === 'checkout.order.completed' || event === 'pg.order.completed') {
      const purpose = classifyPhonePeMerchantOrder(merchantOrderId);
      if (DEFER_SECONDS[purpose]) {
        outcome = {
          status: 'deferred',
          extra: { purpose, orderId: merchantOrderId, processAfter: new Date(Date.now() + DEFER_SECONDS[purpose] * 1000) },
          result: {},
        };
      } else {
        const result = await settlePhonePeOrder({ merchantOrderId, settledVia: 'webhook' });
        outcome = {
          status: result.status === 'ignored' ? 'ignored' : 'processed',
          extra: { purpose: result.purpose, orderId: merchantOrderId, paymentId: result.paymentId || '', amount: result.amount || 0 },
          result,
        };
      }
    } else if (event === 'checkout.order.failed' || event === 'pg.order.failed') {
      await PaymentOrder.updateOne(
        { provider: 'phonepe', orderId: merchantOrderId, status: 'created' },
        { $set: { status: 'failed', lastError: String(payload.errorCode || 'PhonePe order failed') } },
      );
      outcome = { status: 'processed', extra: { orderId: merchantOrderId }, result: { state: payload.state || '' } };
    } else if (event === 'pg.refund.completed' || event === 'pg.refund.failed') {
      outcome = { status: 'processed', result: await applyPhonePeRefundWebhook({ payload, completed: event === 'pg.refund.completed' }) };
    } else {
      outcome = { status: 'ignored', result: { reason: `unhandled event ${event}` } };
    }

    await finishEvent(eventDoc._id, outcome);
    if (outcome.status === 'deferred') ensureSweeperRunning();
    return { status: outcome.status, eventId };
  } catch (error) {
    console.error('[webhook] phonepe processing failed:', eventId, error?.message || error);
    await finishEvent(eventDoc._id, { status: 'failed', error: error?.message || 'processing failed' });
    throw new ApiError(500, 'Webhook processing failed; will be retried');
  }
};

// ---------------- Deferred settlement ----------------

const processDeferredEvent = async (eventDoc) => {
  if (eventDoc.provider === 'razorpay') {
    const parsed = parseRazorpayWebhookEvent(eventDoc.payload || {});
    const payment = parsed.payment;
    const notes = { ...(eventDoc.result?.notes || {}), ...(payment?.notes || {}) };
    return settleRazorpayCapture({
      purpose: eventDoc.purpose,
      payment,
      order: { id: payment?.order_id, receipt: eventDoc.result?.receipt || '' },
      notes,
    });
  }

  if (eventDoc.provider === 'phonepe') {
    if (eventDoc.purpose === 'rental_advance') {
      const payload = eventDoc.payload?.payload || {};
      const merchantOrderId = String(payload.merchantOrderId || eventDoc.orderId || '');
      const statusPayload = await fetchPhonePeOrderStatus(merchantOrderId);
      const { state, paymentId, amount } = summarizePhonePeOrderStatus(merchantOrderId, statusPayload);
      if (state !== 'COMPLETED') return { status: 'not_completed', state };
      // The app passes the PhonePe merchant order id as the booking's
      // payment reference.
      const result = await checkRentalAdvancePayment({ orderId: merchantOrderId, paymentId });
      if (result.status !== 'orphaned') return result;
      const remembered = await findPaymentOrder('phonepe', merchantOrderId);
      const refund = await refundPaymentSafely({
        provider: 'phonepe',
        paymentId,
        orderId: merchantOrderId,
        amount,
        reason: 'Rental advance captured but no rental booking was created',
        reference: { kind: 'gateway_payment', id: merchantOrderId },
        userId: remembered?.owner?.type === 'user' ? remembered.owner.id : null,
        service: 'rental',
        idempotencyKey: buildIdempotencyKey('refund', 'orphan_capture', 'phonepe', merchantOrderId),
        metadata: { capturedAmount: amount, orphanReason: result.reason },
      }, 'orphan phonepe rental capture');
      return { ...result, refundNumber: refund?.refundNumber || '' };
    }
    return settlePhonePeOrder({ merchantOrderId: eventDoc.orderId, settledVia: 'webhook_deferred' });
  }

  return { status: 'ignored', reason: 'unknown provider' };
};

/// Settles deferred webhook events that are due. Safe to run on every
/// instance at once: each event is claimed with a conditional update.
export const processDuePaymentEvents = async ({ limit = 20 } = {}) => {
  const processed = [];
  for (let index = 0; index < limit; index += 1) {
    // Also picks up an event left `processing` by an instance that died
    // mid-settlement (settlement itself is idempotent, so re-running is safe).
    const eventDoc = await PaymentEvent.findOneAndUpdate(
      {
        $or: [
          { status: 'deferred', processAfter: { $lte: new Date() } },
          { status: 'processing', processAfter: { $ne: null }, updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
        ],
      },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { sort: { processAfter: 1 }, returnDocument: 'after' },
    ).lean();
    if (!eventDoc) break;

    try {
      const result = await processDeferredEvent(eventDoc);
      await finishEvent(eventDoc._id, { status: result?.status === 'ignored' ? 'ignored' : 'processed', result });
      processed.push({ eventId: eventDoc.eventId, status: result?.status });
    } catch (error) {
      console.error('[webhook] deferred settlement failed:', eventDoc.eventId, error?.message || error);
      // Back off and try again later rather than giving up: the money is
      // captured and still needs a home. After 10 attempts, leave it failed
      // for an admin to look at.
      const giveUp = Number(eventDoc.attempts || 0) >= 10;
      await finishEvent(eventDoc._id, {
        status: giveUp ? 'failed' : 'deferred',
        error: error?.message || 'deferred settlement failed',
        extra: giveUp ? {} : { processAfter: new Date(Date.now() + 5 * 60 * 1000) },
      });
    }
  }
  return processed;
};

let sweeperTimer = null;

/// Starts the loop that settles deferred webhook events (every 60 seconds).
/// Called from server.js at boot and lazily on the first deferred webhook.
export const startPaymentEventSweeper = ({ intervalMs = 60_000 } = {}) => {
  if (sweeperTimer) return sweeperTimer;
  sweeperTimer = setInterval(() => {
    processDuePaymentEvents().catch((error) => console.error('[webhook] sweeper failed:', error?.message || error));
  }, intervalMs);
  sweeperTimer.unref?.();
  return sweeperTimer;
};

const ensureSweeperRunning = () => {
  try {
    startPaymentEventSweeper();
  } catch (error) {
    console.error('[webhook] could not start sweeper:', error?.message || error);
  }
};

export const listPaymentEvents = async (query = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  const filter = {};
  if (query.provider) filter.provider = String(query.provider);
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.event) filter.event = String(query.event);
  if (query.paymentId) filter.paymentId = String(query.paymentId);
  const [items, total] = await Promise.all([
    PaymentEvent.find(filter).select('-payload').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PaymentEvent.countDocuments(filter),
  ]);
  return { results: items, paginator: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) } };
};
