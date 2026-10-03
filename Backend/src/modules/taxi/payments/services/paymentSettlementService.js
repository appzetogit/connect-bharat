import { ApiError } from '../../../../utils/ApiError.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { Driver } from '../../driver/models/Driver.js';
import { WalletTransaction } from '../../driver/models/WalletTransaction.js';
import {
  applyDriverWalletAdjustment,
  serializeDriverWallet,
  topUpDriverWallet,
} from '../../driver/services/walletService.js';
import { BusBooking } from '../../user/models/BusBooking.js';
import { BusSeatHold } from '../../user/models/BusSeatHold.js';
import { Ride } from '../../user/models/Ride.js';
import { UserWallet } from '../../user/models/UserWallet.js';
import { PaymentOrder } from '../models/PaymentOrder.js';
import { roundMoney } from '../utils/paymentUtils.js';
import { corporateEmployeePaidUpdate } from '../../corporate/services/corporateCompletionService.js';

/// Settles a captured gateway payment into the app: wallet credit, ride
/// payment, bus seat confirmation.
///
/// These functions are shared by the client verify endpoints and the
/// webhooks, so a payment is settled the same way whichever arrives first,
/// and exactly once (see PaymentOrder for the claim). Everything here is
/// idempotent: calling it again for a settled payment returns
/// `{ status: 'existing' }`.

const DUPLICATE_KEY = 11000;

const emitLater = async (fn) => {
  try {
    const dispatch = await import('../../services/dispatchService.js');
    fn(dispatch);
  } catch (error) {
    console.error('[payments] socket emit failed:', error?.message || error);
  }
};

/// Remembers an order we created so a webhook can find whose it is.
/// Never throws: failing to remember must not fail the order creation.
export const rememberPaymentOrder = async ({
  provider,
  orderId,
  purpose,
  owner = {},
  amount = 0,
  currency = 'INR',
  metadata = {},
} = {}) => {
  try {
    if (!provider || !orderId) return null;
    return await PaymentOrder.findOneAndUpdate(
      { provider, orderId: String(orderId) },
      {
        $setOnInsert: {
          provider,
          orderId: String(orderId),
          status: 'created',
        },
        $set: {
          purpose: purpose || '',
          owner: { type: String(owner?.type || ''), id: String(owner?.id || '') },
          amount: roundMoney(amount),
          currency,
          metadata,
        },
      },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (error) {
    console.error('[payments] rememberPaymentOrder failed:', error?.message || error);
    return null;
  }
};

export const findPaymentOrder = (provider, orderId) =>
  PaymentOrder.findOne({ provider, orderId: String(orderId) }).lean();

/// Atomically claims the right to settle `orderId`. Exactly one concurrent
/// caller gets `claimed: true`; the rest get the current order with
/// `claimed: false`. A claim left in `settling` by a crashed process is
/// taken over after five minutes.
export const claimPaymentOrder = async ({
  provider,
  orderId,
  paymentId = '',
  purpose = '',
  owner = {},
  amount = 0,
  settledVia = '',
  metadata = {},
}) => {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const filter = {
    provider,
    orderId: String(orderId),
    $or: [
      { status: { $in: ['created', 'failed'] } },
      { status: 'settling', updatedAt: { $lt: staleBefore } },
    ],
  };
  const update = {
    $set: {
      status: 'settling',
      paymentId: String(paymentId || ''),
      settledVia,
      lastError: '',
    },
    $setOnInsert: {
      provider,
      orderId: String(orderId),
      purpose,
      owner: { type: String(owner?.type || ''), id: String(owner?.id || '') },
      amount: roundMoney(amount),
      metadata,
    },
  };

  try {
    const order = await PaymentOrder.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' }).lean();
    return { claimed: true, order };
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
    // The order exists and is settling or paid: someone else has it.
    return { claimed: false, order: await findPaymentOrder(provider, orderId) };
  }
};

export const completePaymentOrderClaim = ({ provider, orderId, result = {} }) =>
  PaymentOrder.updateOne(
    { provider, orderId: String(orderId) },
    { $set: { status: 'paid', settledAt: new Date(), 'metadata.result': result } },
  );

export const releasePaymentOrderClaim = ({ provider, orderId, error }) =>
  PaymentOrder.updateOne(
    { provider, orderId: String(orderId), status: 'settling' },
    { $set: { status: 'failed', lastError: String(error?.message || error || '').slice(0, 500) } },
  ).catch(() => null);

/// Runs `apply` under the settlement claim for (provider, orderId).
const withSettlementClaim = async (claimInput, apply) => {
  const { claimed, order } = await claimPaymentOrder(claimInput);
  if (!claimed) {
    return { status: 'existing', order };
  }

  try {
    const result = await apply();
    await completePaymentOrderClaim({ provider: claimInput.provider, orderId: claimInput.orderId, result: result?.summary || {} });
    return { status: 'settled', order, ...result };
  } catch (error) {
    await releasePaymentOrderClaim({ provider: claimInput.provider, orderId: claimInput.orderId, error });
    throw error;
  }
};

const ensureUserWallet = (userId) =>
  UserWallet.updateOne(
    { userId },
    { $setOnInsert: { userId, balance: 0, refundWallet: 0, transactions: [] } },
    { upsert: true },
  );

/// Credits a user wallet for a captured top-up. Same transaction shape the
/// verify handlers have always written, so the app's wallet screen is
/// unchanged.
///
/// @returns {Promise<{ status: 'settled'|'existing', amount: number }>}
export const creditUserWalletFromGateway = async ({
  userId,
  amount,
  provider,
  orderId,
  paymentId,
  settledVia = 'client_verify',
  title = 'Wallet Refilled',
}) => {
  const normalizedAmount = roundMoney(amount);
  if (!userId) throw new ApiError(400, 'User reference is missing from this payment');
  if (!(normalizedAmount > 0)) throw new ApiError(400, 'Invalid order amount');
  if (!orderId && !paymentId) throw new ApiError(400, 'Payment reference is required');

  await ensureUserWallet(userId);

  // Payments settled before the claim existed are only visible in the
  // embedded array; respect them so an old payment is never credited twice.
  const legacyMatch = [
    paymentId ? { 'transactions.providerPaymentId': String(paymentId) } : null,
    orderId ? { 'transactions.providerOrderId': String(orderId) } : null,
  ].filter(Boolean);
  const alreadyCredited = await UserWallet.findOne({ userId, $or: legacyMatch }).select('_id').lean();
  if (alreadyCredited) {
    return { status: 'existing', amount: normalizedAmount };
  }

  const settlementOrderId = orderId || `pay:${paymentId}`;
  const outcome = await withSettlementClaim(
    {
      provider,
      orderId: settlementOrderId,
      paymentId,
      purpose: 'user_wallet_topup',
      owner: { type: 'user', id: String(userId) },
      amount: normalizedAmount,
      settledVia,
    },
    async () => {
      const tx = {
        kind: 'credit',
        amount: normalizedAmount,
        title,
        provider,
        providerOrderId: String(orderId || ''),
        providerPaymentId: String(paymentId || ''),
      };

      await UserWallet.updateOne(
        { userId },
        {
          $inc: { balance: normalizedAmount },
          $push: { transactions: { $each: [tx], $slice: -50 } },
        },
      );

      return { summary: { userId: String(userId), amount: normalizedAmount } };
    },
  );

  if (outcome.status === 'settled' && settledVia !== 'client_verify') {
    const wallet = await UserWallet.findOne({ userId }).select('balance refundWallet').lean();
    void emitLater((dispatch) => {
      const io = dispatch.getSocketServer?.();
      io?.to(dispatch.getUserRoom(userId)).emit('user:wallet:updated', {
        balance: Number(wallet?.balance || 0),
        refundWallet: Number(wallet?.refundWallet || 0),
        credited: normalizedAmount,
        provider,
        paymentId: String(paymentId || ''),
        source: settledVia,
      });
    });
  }

  return { status: outcome.status, amount: normalizedAmount };
};

/// Credits a driver wallet for a captured top-up, through the same
/// `topUpDriverWallet` the verify endpoints use.
///
/// @returns {Promise<{ status, wallet, transaction }>}
export const creditDriverWalletFromGateway = async ({
  driverId,
  amount,
  provider,
  orderId,
  paymentId,
  paymentLinkId = '',
  settledVia = 'client_verify',
  emit = true,
}) => {
  const normalizedAmount = roundMoney(amount);
  if (!driverId) throw new ApiError(400, 'Driver reference is missing from this payment');
  if (!(normalizedAmount > 0)) throw new ApiError(400, 'Invalid order amount');
  if (!orderId && !paymentId) throw new ApiError(400, 'Payment reference is required');

  const legacyMatch = [
    paymentId ? { 'metadata.providerPaymentId': String(paymentId) } : null,
    orderId ? { 'metadata.providerOrderId': String(orderId) } : null,
  ].filter(Boolean);
  const alreadyCredited = await WalletTransaction.findOne({ driverId, $or: legacyMatch }).select('_id').lean();

  const existingResult = async () => {
    const driver = await Driver.findById(driverId);
    return {
      status: 'existing',
      wallet: driver ? await serializeDriverWallet(driver) : null,
      transaction: null,
    };
  };

  if (alreadyCredited) return existingResult();

  const outcome = await withSettlementClaim(
    {
      provider,
      orderId: orderId || `pay:${paymentId}`,
      paymentId,
      purpose: 'driver_wallet_topup',
      owner: { type: 'driver', id: String(driverId) },
      amount: normalizedAmount,
      settledVia,
    },
    async () => {
      const result = await topUpDriverWallet({
        driverId,
        amount: normalizedAmount,
        metadata: {
          source: provider,
          provider,
          providerOrderId: String(orderId || ''),
          providerPaymentId: String(paymentId || ''),
          ...(paymentLinkId ? { providerPaymentLinkId: paymentLinkId } : {}),
          settledVia,
        },
      });
      return { result, summary: { driverId: String(driverId), amount: normalizedAmount } };
    },
  );

  if (outcome.status !== 'settled') return existingResult();

  const payload = { wallet: outcome.result.wallet, transaction: outcome.result.transaction };
  if (emit) {
    void emitLater((dispatch) => dispatch.emitToDriver(driverId, 'driver:wallet:updated', payload));
  }
  return { status: 'settled', ...payload };
};

const isCollectionPaid = (ride = {}) =>
  Boolean(ride?.driverPaymentCollection?.paidAt) ||
  ['paid', 'captured', 'completed'].includes(String(ride?.driverPaymentCollection?.status || '').toLowerCase());

/// Settles a ride-completion (fare + optional tip) or ride-tip payment that
/// was captured but never verified by the app (app killed after paying).
///
/// Credits the driver exactly as `finalizeRideCompletion` would and marks the
/// ride's payment collection paid, but does NOT write rider feedback — the
/// rating belongs to the rider. When the app later calls the verify endpoint
/// with the same payment, it only records the feedback (see
/// `recordFeedbackForSettledRidePayment`).
export const settleRideGatewayPayment = async ({
  purpose,
  rideId,
  orderId,
  paymentId,
  amount,
  notes = {},
  provider = 'razorpay',
  settledVia = 'webhook',
}) => {
  const ride = await Ride.findById(rideId);
  if (!ride) throw new ApiError(404, 'Ride not found for captured payment');
  if (!ride.driverId) throw new ApiError(409, 'Ride has no assigned driver');

  if (
    String(ride.driverPaymentCollection?.providerPaymentId || '') === String(paymentId) ||
    String(ride.feedback?.tipPaymentId || '') === String(paymentId)
  ) {
    return { status: 'existing' };
  }

  const alreadyCredited = await WalletTransaction.findOne({
    driverId: ride.driverId,
    'metadata.providerPaymentId': String(paymentId),
  }).select('_id').lean();
  if (alreadyCredited) return { status: 'existing' };

  const totalCharge = roundMoney(amount);
  const tipAmount = purpose === 'ride_tip'
    ? totalCharge
    : roundMoney(Number(notes?.tipAmount || 0));
  const fareDueAtOrder = purpose === 'ride_tip' ? 0 : roundMoney(Number(notes?.fareDue || 0));

  if (Math.abs(roundMoney(fareDueAtOrder + tipAmount) - totalCharge) > 0.001) {
    throw new ApiError(409, 'Captured amount does not match the order breakdown; needs manual review');
  }

  // If the fare was collected some other way meanwhile (cash, QR), only the
  // tip is the driver's; the fare part of this payment is owed back to the
  // rider and is left for admin review rather than guessed at here.
  const fareDue = fareDueAtOrder > 0 && !isCollectionPaid(ride) ? fareDueAtOrder : 0;
  const unallocated = roundMoney(fareDueAtOrder - fareDue);
  const previousMethod = String(ride.paymentMethod || 'cash').trim().toLowerCase() === 'cash' ? 'cash' : 'online';
  const driverCreditAmount = roundMoney(tipAmount + (fareDue > 0 && previousMethod === 'cash' ? roundMoney(ride.fare || 0) : 0));

  const outcome = await withSettlementClaim(
    {
      provider,
      orderId: orderId || `pay:${paymentId}`,
      paymentId,
      purpose,
      owner: { type: 'ride', id: String(ride._id) },
      amount: totalCharge,
      settledVia,
      metadata: { tipAmount, fareDue, unallocated },
    },
    async () => {
      let walletResult = null;
      if (driverCreditAmount > 0) {
        walletResult = await applyDriverWalletAdjustment({
          driverId: ride.driverId,
          rideId: ride._id,
          amount: driverCreditAmount,
          type: 'adjustment',
          description: fareDue > 0 ? 'Ride completion payment credited from rider' : 'Ride tip credited from rider',
          metadata: {
            source: purpose === 'ride_tip' ? 'ride_tip_webhook' : 'ride_completion_webhook',
            rideId: String(ride._id),
            userId: String(ride.userId || ''),
            farePortion: fareDue > 0 ? roundMoney(ride.fare || 0) : 0,
            tipAmount,
            totalCharge,
            provider,
            providerOrderId: String(orderId || ''),
            providerPaymentId: String(paymentId),
          },
        });
      }

      const update = {};
      if (fareDue > 0) {
        // A corporate ride stays corporate; the employee's share is marked paid.
        const corporatePaid = corporateEmployeePaidUpdate(ride, 'online');
        if (corporatePaid) Object.assign(update, corporatePaid);
        else update.paymentMethod = 'online';
        update.driverPaymentCollection = {
          provider,
          providerId: String(paymentId),
          providerOrderId: String(orderId || ''),
          providerPaymentId: String(paymentId),
          providerMode: 'razorpay_order',
          source: 'ride_completion_razorpay',
          status: 'paid',
          amount: totalCharge,
          currency: 'INR',
          linkUrl: '',
          paidAt: new Date(),
          updatedAt: new Date(),
        };
      }
      if (Object.keys(update).length) {
        await Ride.updateOne({ _id: ride._id }, { $set: update });
      }

      return { walletResult, summary: { rideId: String(ride._id), driverCreditAmount, tipAmount, fareDue, unallocated } };
    },
  );

  if (outcome.status === 'settled' && outcome.walletResult?.transaction) {
    void emitLater((dispatch) =>
      dispatch.emitToDriver(ride.driverId, 'driver:wallet:updated', {
        wallet: outcome.walletResult.wallet,
        transaction: outcome.walletResult.transaction,
        notification: {
          id: `ride-payment-${paymentId}`,
          title: 'Payment received',
          body: `Rs ${totalCharge.toFixed(2)} received from rider for completed ride.`,
          sentAt: new Date().toISOString(),
        },
      }),
    );
  }

  return { status: outcome.status, unallocated, tipAmount, fareDue };
};

/// When the rider's app calls the verify endpoint for a payment the webhook
/// already settled, return the settled order so the controller records only
/// the feedback. Returns null when the payment was not settled here.
export const findWebhookSettledRidePayment = async ({ provider = 'razorpay', orderId, paymentId }) => {
  if (!orderId) return null;
  const order = await findPaymentOrder(provider, orderId);
  if (!order || order.status !== 'paid') return null;
  if (!['ride_completion', 'ride_tip'].includes(order.purpose)) return null;
  if (paymentId && order.paymentId && String(order.paymentId) !== String(paymentId)) return null;
  return order;
};

/// Records rider feedback (rating, comment, tip reference) for a ride whose
/// payment was already settled by the webhook. No money moves here.
export const recordFeedbackForSettledRidePayment = async ({ rideId, userId, rating, comment = '', settledOrder }) => {
  const ride = await Ride.findOne({ _id: rideId, userId });
  if (!ride) throw new ApiError(404, 'Completed ride not found');
  if (ride.feedback?.submittedAt) return { ride, alreadySubmitted: true };

  const numericRating = Number(rating);
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    throw new ApiError(400, 'rating must be an integer between 1 and 5');
  }

  const tipAmount = roundMoney(settledOrder?.metadata?.tipAmount || 0);
  ride.feedback = {
    rating: numericRating,
    comment: String(comment || '').trim(),
    tipAmount,
    tipPaymentId: settledOrder?.paymentId || '',
    tipOrderId: settledOrder?.orderId || '',
    tipPaidAt: tipAmount > 0 ? (settledOrder?.settledAt || new Date()) : null,
    submittedAt: new Date(),
  };

  const driver = ride.driverId ? await Driver.findById(ride.driverId) : null;
  if (driver) {
    driver.ratingCount = Number(driver.ratingCount || 0) + 1;
    driver.totalRatingScore = Number(driver.totalRatingScore || 0) + numericRating;
    driver.rating = Number((driver.totalRatingScore / driver.ratingCount).toFixed(1));
  }

  await Promise.all([ride.save(), driver ? driver.save() : Promise.resolve()]);
  return { ride, alreadySubmitted: false };
};

/// Confirms a bus booking whose payment was captured but never verified by
/// the app, with the same checks `verifyBusBookingPayment` makes. When the
/// seats can no longer be confirmed, returns `orphaned: true` so the caller
/// can raise a refund.
export const settleBusBookingPayment = async ({ orderId, paymentId }) => {
  const booking = await BusBooking.findOne({ 'payment.orderId': orderId });
  if (!booking) return { status: 'orphaned', reason: 'booking_not_found' };
  if (String(booking.status) === 'confirmed') {
    return String(booking.payment?.paymentId || '') === String(paymentId) || !booking.payment?.paymentId
      ? { status: 'existing', bookingId: String(booking._id) }
      : { status: 'orphaned', reason: 'booking_paid_by_other_payment', bookingId: String(booking._id) };
  }
  if (String(booking.status) !== 'pending') {
    return { status: 'orphaned', reason: `booking_${booking.status}`, bookingId: String(booking._id), userId: booking.userId };
  }

  const holds = await BusSeatHold.find({
    bookingId: booking._id,
    status: 'held',
    expiresAt: { $gt: new Date() },
  }).lean();
  if ((booking.expiresAt && booking.expiresAt <= new Date()) || holds.length !== booking.seatIds.length) {
    return { status: 'orphaned', reason: 'seat_hold_expired', bookingId: String(booking._id), userId: booking.userId };
  }

  const updated = await BusBooking.findOneAndUpdate(
    { _id: booking._id, status: 'pending' },
    {
      $set: {
        status: 'confirmed',
        'payment.paymentId': String(paymentId),
        'payment.status': 'paid',
        'payment.paidAt': new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) return { status: 'existing', bookingId: String(booking._id) };

  await BusSeatHold.updateMany(
    { bookingId: booking._id, status: 'held' },
    { $set: { status: 'booked', expiresAt: null } },
  );
  return { status: 'settled', bookingId: String(booking._id) };
};

/// A rental advance is verified by the app and then passed into the rental
/// booking request; there is nothing server-side to mark paid. If no booking
/// references the payment after the grace period, the money was taken
/// without a booking and is owed back.
export const checkRentalAdvancePayment = async ({ orderId, paymentId }) => {
  const or = [
    paymentId ? { 'payment.paymentId': String(paymentId) } : null,
    orderId ? { 'payment.orderId': String(orderId) } : null,
  ].filter(Boolean);
  const booking = or.length ? await RentalBookingRequest.findOne({ $or: or }).select('_id').lean() : null;
  return booking
    ? { status: 'existing', bookingId: String(booking._id) }
    : { status: 'orphaned', reason: 'no_rental_booking' };
};
