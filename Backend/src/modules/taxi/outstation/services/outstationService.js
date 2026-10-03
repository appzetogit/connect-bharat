import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RIDE_LIVE_STATUS, RIDE_STATUS } from '../../constants/index.js';
import { User } from '../../user/models/User.js';
import { UserWallet } from '../../user/models/UserWallet.js';
import { Ride } from '../../user/models/Ride.js';
import { resolveConfiguredGatewayCredentials } from '../../services/paymentGatewayService.js';
import {
  getRideDetails,
  getRideRoom,
  serializeRideRealtime,
} from '../../services/rideService.js';
import {
  getSocketServer,
  getUserRoom,
  startDispatchFlow,
} from '../../services/dispatchService.js';
import { razorpayRequest } from '../../user/controllers/rideController.js';
import { advancePaidAmount, buildOutstationInvoiceLines, roundMoney } from './outstationFare.js';
import { getOutstationSettings } from './outstationHooks.js';

/// The outstation module's own endpoints: advance payment, odometer, trip
/// expenses, the fare summary and the admin list. The hooks the shared ride
/// flow calls are in outstationHooks.js.

const EXPENSE_TYPES = new Set(['toll', 'parking', 'permit', 'state_tax', 'other']);
const MAX_EXPENSES_PER_RIDE = 50;
const MAX_EXPENSE_AMOUNT = 100000;
const MAX_ODOMETER_READING = 10_000_000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH_SIZE = 200;

const assertObjectId = (value, label = 'Ride') => {
  if (!mongoose.Types.ObjectId.isValid(String(value || ''))) {
    throw new ApiError(404, `${label} not found`);
  }
};

const cleanUrl = (value) => {
  const url = String(value || '').trim();
  return url.length > 2048 ? '' : url;
};

const emitToRoomSafe = (room, event, payload) => {
  try {
    getSocketServer()?.to(room).emit(event, payload);
  } catch (error) {
    console.error('[outstation] socket emit failed', event, error?.message);
  }
};

/// Pushes the fresh ride state to everyone in the ride room, as the parcel
/// proof upload does, so a reading or receipt shows on the other app at once.
const broadcastRideState = async (rideId) => {
  try {
    const io = getSocketServer();
    if (!io) return;
    const populated = await getRideDetails(rideId);
    io.to(getRideRoom(populated._id)).emit('ride:state', serializeRideRealtime(populated));
  } catch (error) {
    console.error('[outstation] ride state broadcast failed', error?.message || error);
  }
};

const emitAdvanceUpdate = (ride) => {
  const payload = {
    rideId: String(ride._id),
    advance: {
      required: Boolean(ride.advance?.required),
      amount: Number(ride.advance?.amount) || 0,
      status: ride.advance?.status || 'none',
      provider: ride.advance?.provider || '',
      paidAt: ride.advance?.paidAt || null,
      expiresAt: ride.advance?.expiresAt || null,
    },
    status: ride.status,
    liveStatus: ride.liveStatus,
  };
  emitToRoomSafe(getUserRoom(ride.userId), 'ride:advance:updated', payload);
  emitToRoomSafe(getRideRoom(ride._id), 'ride:advance:updated', payload);
};

// ---------------------------------------------------------------------------
// Advance payment
// ---------------------------------------------------------------------------

const loadPendingAdvanceRide = async (rideId, userId) => {
  assertObjectId(rideId);
  const ride = await Ride.findOne({ _id: rideId, userId, serviceType: 'intercity' });
  if (!ride) throw new ApiError(404, 'Outstation ride not found');
  if (!ride.advance?.required) throw new ApiError(409, 'This ride has no advance to pay');
  return ride;
};

const assertAdvanceStillPayable = (ride) => {
  const status = ride.advance?.status;
  if (status === 'paid' || status === 'waived') throw new ApiError(409, 'The advance for this ride is already settled');
  if (status !== 'pending' || ride.status !== RIDE_STATUS.SEARCHING) {
    throw new ApiError(409, 'This ride is no longer waiting for an advance');
  }
};

/// Flips a pending advance to paid, exactly once, and starts dispatch.
/// Returns the updated ride, or null when it was no longer pending (paid by
/// another request, cancelled, or expired by the sweep).
const markAdvancePaid = async ({ rideId, userId, provider, orderId = '', paymentId }) => {
  const ride = await Ride.findOneAndUpdate(
    {
      _id: rideId,
      userId,
      'advance.required': true,
      'advance.status': 'pending',
      status: RIDE_STATUS.SEARCHING,
    },
    {
      $set: {
        'advance.status': 'paid',
        'advance.provider': provider,
        'advance.orderId': orderId,
        'advance.paymentId': paymentId,
        'advance.paidAt': new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (!ride) return null;

  emitAdvanceUpdate(ride);
  await startOutstationDispatch(ride._id);
  return ride;
};

export const startOutstationDispatch = async (rideId) => {
  try {
    const ride = await Ride.findById(rideId).populate('userId', 'name phone countryCode');
    if (!ride || ride.status !== RIDE_STATUS.SEARCHING || ride.liveStatus !== RIDE_LIVE_STATUS.SEARCHING) return;
    await startDispatchFlow(ride);
  } catch (error) {
    // The recovery sweep in dispatchService picks the ride up if this fails.
    console.error('[outstation] dispatch after advance failed', String(rideId), error?.message);
  }
};

const creditUserWallet = async ({ userId, amount, title, provider, providerPaymentId = '', referenceKey }) => {
  await UserWallet.updateOne(
    { userId },
    { $setOnInsert: { userId, refundWallet: 0 } },
    { upsert: true },
  );
  // Keyed by referenceKey so a retried refund cannot credit twice.
  const result = await UserWallet.updateOne(
    { userId, 'transactions.referenceKey': { $ne: referenceKey } },
    {
      $inc: { balance: roundMoney(amount) },
      $push: {
        transactions: {
          $each: [{ kind: 'credit', amount: roundMoney(amount), title, provider, providerPaymentId, referenceKey }],
          $slice: -50,
        },
      },
    },
  );
  return result.modifiedCount > 0;
};

export const createAdvanceRazorpayOrder = async ({ rideId, userId }) => {
  const ride = await loadPendingAdvanceRide(rideId, userId);
  assertAdvanceStillPayable(ride);

  const amount = roundMoney(ride.advance.amount);
  if (!(amount > 0)) throw new ApiError(409, 'This ride has no advance to pay');

  const { keyId, keySecret } = await resolveConfiguredGatewayCredentials('razor_pay');
  const compactRideId = String(rideId).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'ride';
  const compactUserId = String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'usr';
  const order = await razorpayRequest({
    method: 'POST',
    path: '/orders',
    body: {
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `oadv_${compactUserId}_${compactRideId}_${Date.now().toString(36)}`,
      notes: { rideId: String(rideId), userId: String(userId), source: 'outstation_advance' },
    },
    keyId,
    keySecret,
  });

  await Ride.updateOne(
    { _id: ride._id, 'advance.status': 'pending' },
    { $set: { 'advance.provider': 'razorpay', 'advance.orderId': order.id } },
  );

  return {
    keyId,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency || 'INR',
    advanceAmount: amount,
    rideId: String(ride._id),
    expiresAt: ride.advance.expiresAt || null,
  };
};

/// Verifies a Razorpay advance payment the way the ride completion payment is
/// verified in rideController: HMAC of order|payment with the key secret, then
/// the order is re-read from Razorpay so the amount and the ride it was raised
/// for come from Razorpay rather than the app.
export const verifyAdvanceRazorpayPayment = async ({ rideId, userId, body = {} }) => {
  const orderId = String(body.razorpay_order_id || '');
  const paymentId = String(body.razorpay_payment_id || '');
  const signature = String(body.razorpay_signature || '');
  if (!orderId || !paymentId || !signature) {
    throw new ApiError(400, 'Payment verification fields are required');
  }

  const ride = await loadPendingAdvanceRide(rideId, userId);
  if (ride.advance.status === 'paid' && ride.advance.paymentId === paymentId) {
    return getRideDetails(ride._id); // a retried verify
  }

  const { keyId, keySecret } = await resolveConfiguredGatewayCredentials('razor_pay');
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const signatureMatches = expected.length === signature.length
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!signatureMatches) throw new ApiError(400, 'Invalid payment signature');

  const order = await razorpayRequest({
    method: 'GET',
    path: `/orders/${encodeURIComponent(orderId)}`,
    keyId,
    keySecret,
  });
  if (String(order?.notes?.rideId || '') !== String(ride._id)) {
    throw new ApiError(400, 'This payment was not raised for this ride');
  }
  const paidAmount = roundMoney(Number(order?.amount || 0) / 100);
  if (Math.abs(paidAmount - roundMoney(ride.advance.amount)) > 0.001) {
    throw new ApiError(400, 'Verified payment amount does not match the advance');
  }

  const updated = await markAdvancePaid({ rideId: ride._id, userId, provider: 'razorpay', orderId, paymentId });
  if (!updated) {
    const latest = await Ride.findById(ride._id);
    if (latest?.advance?.status === 'paid' && latest.advance.paymentId === paymentId) {
      return getRideDetails(ride._id);
    }
    // Money was taken for a ride that has since expired or been cancelled:
    // hand it back to the wallet rather than leave it with us.
    await creditUserWallet({
      userId,
      amount: paidAmount,
      title: `Advance refund for ride ${String(ride._id).slice(-6)}`,
      provider: 'outstation_advance_refund',
      providerPaymentId: paymentId,
      referenceKey: `outstation_advance_late:${paymentId}`,
    });
    throw new ApiError(409, 'This ride is no longer waiting for an advance; the payment was credited to your wallet');
  }

  return getRideDetails(updated._id);
};

export const payAdvanceWithWallet = async ({ rideId, userId }) => {
  const ride = await loadPendingAdvanceRide(rideId, userId);
  assertAdvanceStillPayable(ride);
  const amount = roundMoney(ride.advance.amount);
  const transferId = crypto.randomUUID();

  // A conditional decrement, so two taps cannot both spend the balance. No
  // transaction: this deployment runs a standalone mongod (see
  // dispatchService.cancelRideByUser).
  const debit = await UserWallet.updateOne(
    { userId, balance: { $gte: amount } },
    {
      $inc: { balance: -amount },
      $push: {
        transactions: {
          $each: [{
            kind: 'debit',
            amount,
            title: `Outstation advance for ride ${String(ride._id).slice(-6)}`,
            provider: 'outstation_advance_wallet',
            providerPaymentId: transferId,
            referenceKey: `outstation_advance:${ride._id}`,
          }],
          $slice: -50,
        },
      },
    },
  );
  if (!debit.modifiedCount) throw new ApiError(400, 'Insufficient wallet balance');

  const updated = await markAdvancePaid({ rideId: ride._id, userId, provider: 'wallet', paymentId: transferId });
  if (!updated) {
    await creditUserWallet({
      userId,
      amount,
      title: `Advance refund for ride ${String(ride._id).slice(-6)}`,
      provider: 'outstation_advance_refund',
      providerPaymentId: transferId,
      referenceKey: `outstation_advance_undo:${transferId}`,
    });
    throw new ApiError(409, 'This ride is no longer waiting for an advance');
  }

  return getRideDetails(updated._id);
};

/// Admin: let a ride go out without its advance (a known customer, a phone
/// booking). Starts dispatch like a payment would.
export const waiveAdvance = async ({ rideId }) => {
  assertObjectId(rideId);
  const ride = await Ride.findOneAndUpdate(
    { _id: rideId, 'advance.required': true, 'advance.status': 'pending', status: RIDE_STATUS.SEARCHING },
    { $set: { 'advance.status': 'waived', 'advance.provider': 'admin' } },
    { returnDocument: 'after' },
  );
  if (!ride) throw new ApiError(409, 'No pending advance on this ride');
  emitAdvanceUpdate(ride);
  await startOutstationDispatch(ride._id);
  return ride;
};

/// One sweep of the advance timers:
/// 1. rides still waiting for their advance past `advance.expiresAt` are
///    cancelled (`advance.status: 'expired'`);
/// 2. with `outstation_advance_refund_to_wallet` on, a paid advance on a ride
///    that was then cancelled - by the rider, by dispatch finding nobody, or by
///    admin - goes back to the rider's wallet. Any cancellation fee is settled
///    separately by the cancel path, as for every other ride.
///
/// Every row is claimed with a conditional update before anything happens, so
/// several server instances running this loop never act twice.
export const sweepOutstationAdvances = async () => {
  const now = new Date();
  const settings = await getOutstationSettings();

  const expired = await Ride.find({
    serviceType: 'intercity',
    status: RIDE_STATUS.SEARCHING,
    'advance.required': true,
    'advance.status': 'pending',
    'advance.expiresAt': { $ne: null, $lte: now },
  })
    .select('_id userId')
    .limit(SWEEP_BATCH_SIZE)
    .lean();

  for (const row of expired) {
    const ride = await Ride.findOneAndUpdate(
      { _id: row._id, status: RIDE_STATUS.SEARCHING, 'advance.status': 'pending' },
      {
        $set: {
          status: RIDE_STATUS.CANCELLED,
          liveStatus: RIDE_LIVE_STATUS.CANCELLED,
          'advance.status': 'expired',
        },
      },
      { returnDocument: 'after' },
    );
    if (!ride) continue;

    await User.updateOne({ _id: ride.userId, currentRideId: ride._id }, { $set: { currentRideId: null } }).catch(() => null);
    const payload = {
      rideId: String(ride._id),
      room: getRideRoom(ride._id),
      reason: 'The advance was not paid in time',
      code: 'outstation_advance_expired',
    };
    emitToRoomSafe(getUserRoom(ride.userId), 'rideCancelled', payload);
    emitToRoomSafe(getRideRoom(ride._id), 'rideCancelled', payload);
    emitAdvanceUpdate(ride);
  }

  if (!settings.refundAdvanceToWallet) return;

  const refundable = await Ride.find({
    serviceType: 'intercity',
    status: RIDE_STATUS.CANCELLED,
    'advance.status': 'paid',
  })
    .select('_id userId advance')
    .limit(SWEEP_BATCH_SIZE)
    .lean();

  for (const row of refundable) {
    const amount = roundMoney(row.advance?.amount || 0);
    const claim = await Ride.updateOne(
      { _id: row._id, status: RIDE_STATUS.CANCELLED, 'advance.status': 'paid' },
      { $set: { 'advance.status': 'refunded', 'advance.refundedAt': new Date(), 'advance.refundAmount': amount } },
    );
    if (!claim.modifiedCount || amount <= 0) continue;

    try {
      await creditUserWallet({
        userId: row.userId,
        amount,
        title: `Advance refund for cancelled ride ${String(row._id).slice(-6)}`,
        provider: 'outstation_advance_refund',
        providerPaymentId: row.advance?.paymentId || '',
        referenceKey: `outstation_advance_refund:${row._id}`,
      });
      emitToRoomSafe(getUserRoom(row.userId), 'ride:advance:updated', {
        rideId: String(row._id),
        advance: { required: true, amount, status: 'refunded' },
        status: RIDE_STATUS.CANCELLED,
        liveStatus: RIDE_LIVE_STATUS.CANCELLED,
      });
    } catch (error) {
      // Put the claim back so the next sweep retries the credit.
      await Ride.updateOne(
        { _id: row._id, 'advance.status': 'refunded' },
        { $set: { 'advance.status': 'paid', 'advance.refundedAt': null, 'advance.refundAmount': 0 } },
      ).catch(() => null);
      console.error('[outstation] advance refund failed', String(row._id), error?.message);
    }
  }
};

let sweepTimer = null;

/// Registered once at server start, next to the driver subscription expiry
/// loop, and on the same pattern.
export const startOutstationAdvanceLoop = () => {
  if (sweepTimer) return;
  const run = () => sweepOutstationAdvances().catch((error) => {
    console.error('Outstation advance sweep failed', error);
  });
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  run();
};

// ---------------------------------------------------------------------------
// Odometer and trip expenses (driver)
// ---------------------------------------------------------------------------

export const recordOdometerReading = async ({ rideId, driverId, stage, reading, photoUrl }) => {
  assertObjectId(rideId);
  const normalizedStage = String(stage || '').trim().toLowerCase();
  if (!['start', 'end'].includes(normalizedStage)) {
    throw new ApiError(400, 'stage must be start or end');
  }
  const value = Number(reading);
  if (!Number.isFinite(value) || value < 0 || value > MAX_ODOMETER_READING) {
    throw new ApiError(400, 'reading must be a valid odometer reading');
  }
  const photo = cleanUrl(photoUrl);
  if (!photo) throw new ApiError(400, 'A photo of the odometer is required');

  const ride = await Ride.findOne({ _id: rideId, driverId, serviceType: 'intercity' });
  if (!ride) throw new ApiError(404, 'Outstation ride not found for this driver');

  const live = ride.liveStatus;
  if (normalizedStage === 'start') {
    // Editable until the trip is under way; after that it is evidence.
    if (![RIDE_LIVE_STATUS.ACCEPTED, RIDE_LIVE_STATUS.ARRIVING].includes(live)) {
      throw new ApiError(409, 'The start reading can only be recorded before the trip starts');
    }
    ride.set({ 'odometer.startReading': value, 'odometer.startPhoto': photo, 'odometer.startAt': new Date() });
  } else {
    if (![RIDE_LIVE_STATUS.STARTED, RIDE_LIVE_STATUS.ARRIVED].includes(live)) {
      throw new ApiError(409, 'The end reading can only be recorded during the trip');
    }
    const start = ride.odometer?.startReading;
    if (start === null || start === undefined) {
      throw new ApiError(400, 'Record the start reading first');
    }
    if (value < Number(start)) {
      throw new ApiError(400, 'The end reading cannot be lower than the start reading');
    }
    ride.set({ 'odometer.endReading': value, 'odometer.endPhoto': photo, 'odometer.endAt': new Date() });
  }

  await ride.save();
  await broadcastRideState(ride._id);
  return ride;
};

export const addTripExpense = async ({ rideId, driverId, type, label, amount, receiptUrl }) => {
  assertObjectId(rideId);
  const expenseType = String(type || 'toll').trim().toLowerCase();
  if (!EXPENSE_TYPES.has(expenseType)) {
    throw new ApiError(400, 'type must be toll, parking, permit, state_tax or other');
  }
  const value = roundMoney(Number(amount));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_EXPENSE_AMOUNT) {
    throw new ApiError(400, `amount must be between 0 and ${MAX_EXPENSE_AMOUNT}`);
  }
  const receipt = cleanUrl(receiptUrl);
  if (!receipt) throw new ApiError(400, 'A receipt photo is required');

  const update = {
    $push: {
      'intercity.tollsAndPermits': {
        type: expenseType,
        label: String(label || '').trim().slice(0, 120),
        amount: value,
        receiptUrl: receipt,
        addedAt: new Date(),
      },
    },
  };
  if (expenseType === 'state_tax') update.$inc = { 'intercity.stateTaxes': value };

  const ride = await Ride.findOneAndUpdate(
    {
      _id: rideId,
      driverId,
      serviceType: 'intercity',
      liveStatus: { $in: [RIDE_LIVE_STATUS.ACCEPTED, RIDE_LIVE_STATUS.ARRIVING, RIDE_LIVE_STATUS.STARTED, RIDE_LIVE_STATUS.ARRIVED] },
      [`intercity.tollsAndPermits.${MAX_EXPENSES_PER_RIDE - 1}`]: { $exists: false },
    },
    update,
    { returnDocument: 'after' },
  );
  if (!ride) {
    throw new ApiError(409, 'Expenses can only be added to your outstation trip before it completes');
  }

  await broadcastRideState(ride._id);
  return ride;
};

// ---------------------------------------------------------------------------
// Fare summary and admin list
// ---------------------------------------------------------------------------

export const buildFareSummary = (rideDoc) => {
  const ride = typeof rideDoc?.toObject === 'function' ? rideDoc.toObject() : rideDoc;
  const advancePaid = advancePaidAmount(ride);
  const fare = roundMoney(ride.fare || 0);
  const adjustment = ride.fareAdjustment?.computedAt ? ride.fareAdjustment : null;
  const booked = adjustment?.bookedBreakdown || ride.pricingSnapshot?.fare_breakdown || null;
  const expenses = (ride.intercity?.tollsAndPermits || []).map((item) => ({
    id: item._id ? String(item._id) : null,
    type: item.type,
    label: item.label,
    amount: item.amount,
    receiptUrl: item.receiptUrl,
    addedAt: item.addedAt,
  }));

  return {
    rideId: String(ride._id),
    serviceType: ride.serviceType,
    status: ride.status,
    liveStatus: ride.liveStatus,
    tripType: ride.intercity?.tripType || '',
    tripTypeLabel: ride.intercity?.tripTypeLabel || '',
    days: ride.intercity?.days || 1,
    startAt: ride.intercity?.startAt || null,
    returnAt: ride.intercity?.returnAt || null,
    fare,
    fareSource: ride.pricingSnapshot?.fare_source || '',
    bookedFare: adjustment ? adjustment.bookedFare : fare,
    bookedBreakdown: booked,
    advance: {
      required: Boolean(ride.advance?.required),
      amount: Number(ride.advance?.amount) || 0,
      status: ride.advance?.status || 'none',
      provider: ride.advance?.provider || '',
      paidAt: ride.advance?.paidAt || null,
      expiresAt: ride.advance?.expiresAt || null,
      refundAmount: Number(ride.advance?.refundAmount) || 0,
    },
    odometer: ride.odometer || null,
    expenses,
    expensesTotal: roundMoney(expenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)),
    fareAdjustment: adjustment
      ? (({ bookedBreakdown, ...rest }) => rest)(adjustment)
      : null,
    amountDue: Math.max(0, roundMoney(fare - advancePaid)),
    refundDue: Math.max(0, roundMoney(advancePaid - fare)),
    invoiceLines: buildOutstationInvoiceLines(ride),
  };
};

export const getFareSummary = async ({ rideId, role, entityId }) => {
  assertObjectId(rideId);
  const ride = await Ride.findById(rideId);
  if (!ride) throw new ApiError(404, 'Ride not found');
  if (role !== 'admin') {
    const actorId = String(entityId);
    const allowed = (role === 'user' && String(ride.userId) === actorId)
      || (role === 'driver' && ride.driverId && String(ride.driverId) === actorId);
    if (!allowed) throw new ApiError(403, 'You are not allowed to view this ride');
  }
  return buildFareSummary(ride);
};

const ADMIN_ADJUSTMENT_FILTERS = {
  applied: { 'fareAdjustment.computedAt': { $ne: null }, 'fareAdjustment.applied': true },
  dry_run: { 'fareAdjustment.computedAt': { $ne: null }, 'fareAdjustment.applied': false },
  none: { 'fareAdjustment.computedAt': null },
};

export const listAdminOutstationRides = async (query = {}) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
  const filter = { serviceType: 'intercity' };

  if (query.status) filter.status = String(query.status);
  if (query.advanceStatus) filter['advance.status'] = String(query.advanceStatus);
  if (query.tripType) filter['intercity.tripType'] = String(query.tripType);
  if (query.adjustment && ADMIN_ADJUSTMENT_FILTERS[query.adjustment]) {
    Object.assign(filter, ADMIN_ADJUSTMENT_FILTERS[query.adjustment]);
  }
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if ((from && Number.isFinite(from.getTime())) || (to && Number.isFinite(to.getTime()))) {
    filter.createdAt = {};
    if (from && Number.isFinite(from.getTime())) filter.createdAt.$gte = from;
    if (to && Number.isFinite(to.getTime())) filter.createdAt.$lte = to;
  }

  const [items, total] = await Promise.all([
    Ride.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('userId driverId status liveStatus fare paymentMethod pickupAddress dropAddress intercity advance odometer fareAdjustment pricingSnapshot.fare_source createdAt startedAt completedAt')
      .populate('userId', 'name phone')
      .populate('driverId', 'name phone vehicleNumber')
      .lean(),
    Ride.countDocuments(filter),
  ]);

  return {
    results: items.map((ride) => ({
      rideId: String(ride._id),
      bookingId: ride.intercity?.bookingId || '',
      user: ride.userId ? { id: String(ride.userId._id), name: ride.userId.name || '', phone: ride.userId.phone || '' } : null,
      driver: ride.driverId ? { id: String(ride.driverId._id), name: ride.driverId.name || '', phone: ride.driverId.phone || '', vehicleNumber: ride.driverId.vehicleNumber || '' } : null,
      status: ride.status,
      liveStatus: ride.liveStatus,
      fromCity: ride.intercity?.fromCity || '',
      toCity: ride.intercity?.toCity || '',
      pickupAddress: ride.pickupAddress || '',
      dropAddress: ride.dropAddress || '',
      tripType: ride.intercity?.tripType || '',
      days: ride.intercity?.days || 1,
      startAt: ride.intercity?.startAt || null,
      returnAt: ride.intercity?.returnAt || null,
      fare: ride.fare,
      fareSource: ride.pricingSnapshot?.fare_source || '',
      paymentMethod: ride.paymentMethod,
      advance: {
        required: Boolean(ride.advance?.required),
        amount: Number(ride.advance?.amount) || 0,
        status: ride.advance?.status || 'none',
        provider: ride.advance?.provider || '',
        paidAt: ride.advance?.paidAt || null,
      },
      odometer: ride.odometer || null,
      expensesTotal: roundMoney((ride.intercity?.tollsAndPermits || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0)),
      fareAdjustment: ride.fareAdjustment?.computedAt
        ? {
            applied: Boolean(ride.fareAdjustment.applied),
            bookedFare: ride.fareAdjustment.bookedFare,
            finalFare: ride.fareAdjustment.finalFare,
            difference: roundMoney((ride.fareAdjustment.finalFare || 0) - (ride.fareAdjustment.bookedFare || 0)),
            distanceSource: ride.fareAdjustment.distanceSource,
            actualKm: ride.fareAdjustment.actualKm,
            reason: ride.fareAdjustment.reason,
          }
        : null,
      createdAt: ride.createdAt,
      startedAt: ride.startedAt,
      completedAt: ride.completedAt,
    })),
    paginator: {
      current_page: page,
      per_page: limit,
      total,
      last_page: Math.max(1, Math.ceil(total / limit)),
    },
  };
};
