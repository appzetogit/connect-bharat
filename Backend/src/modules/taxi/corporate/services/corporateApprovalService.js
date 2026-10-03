import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RIDE_LIVE_STATUS, RIDE_STATUS } from '../../constants/index.js';
import { Ride } from '../../user/models/Ride.js';
import { User } from '../../user/models/User.js';
import { Delivery } from '../../user/models/Delivery.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { CorporateTripRequest } from '../models/CorporateTripRequest.js';
import { notifyApproversOfTrip, notifyRider } from './corporateNotifyService.js';

/// Trip approval (SOW 8.3).
///
/// A ride that needs approval is created normally but its dispatch is held by
/// `isRideAwaitingCorporateApproval` (corporateDispatchGate.js). Approving
/// flips the ride to `approved` and starts dispatch; rejecting or letting it
/// expire cancels the ride the same way an admin cancel does, so the rider app
/// sees an ordinary `rideCancelled`.
///
/// Socket events emitted to the rider (`user:<id>` room):
///   corporate:trip:pending   { rideId, tripRequestId, expiresAt, reasons }
///   corporate:trip:approved  { rideId, tripRequestId }
///   corporate:trip:rejected  { rideId, tripRequestId, status, note }
/// plus the existing `rideCancelled` / `ride:status:updated` on rejection.

const dispatchModule = () => import('../../services/dispatchService.js');

/// Socket emits go through the io instance dispatchService holds; there is no
/// io when this runs outside the server (scripts), and then nothing is sent.
const emitToRoom = async (room, event, payload) => {
  const { getSocketServer } = await dispatchModule();
  getSocketServer()?.to(room).emit(event, payload);
};

const emitToUser = async (userId, event, payload) => {
  try {
    const { getUserRoom } = await dispatchModule();
    await emitToRoom(getUserRoom(userId), event, payload);
  } catch (error) {
    console.warn('[corporate-approval] socket emit failed', error.message);
  }
};

export const openTripRequestForRide = async ({ ride, booking }) => {
  const now = Date.now();
  const expiryMs = booking.approvalExpiryMinutes * 60 * 1000;
  // A scheduled trip can wait for its approver up to its pickup time.
  const scheduledMs = ride.scheduledAt ? new Date(ride.scheduledAt).getTime() : 0;
  const expiresAt = new Date(Math.max(now + expiryMs, scheduledMs > now ? scheduledMs : 0));

  const tripRequest = await CorporateTripRequest.create({
    corporateId: booking.corporateId,
    employeeId: booking.employeeId,
    userId: ride.userId,
    departmentId: booking.departmentId,
    rideId: ride._id,
    serviceType: booking.serviceType,
    estimatedFare: booking.grossFare,
    billableAmount: booking.billableAmount,
    pickupAddress: ride.pickupAddress || '',
    dropAddress: ride.dropAddress || '',
    scheduledAt: ride.scheduledAt || null,
    reasons: booking.approvalReasons,
    expiresAt,
  });

  ride.corporate.tripRequestId = tripRequest._id;
  await Ride.updateOne({ _id: ride._id }, { $set: { 'corporate.tripRequestId': tripRequest._id } });

  emitToUser(ride.userId, 'corporate:trip:pending', {
    rideId: String(ride._id),
    tripRequestId: String(tripRequest._id),
    expiresAt,
    reasons: booking.approvalReasons,
  });

  // Not awaited: an approver email must not hold up the booking response.
  Promise.all([
    Corporate.findById(booking.corporateId).lean(),
    CorporateEmployee.findById(booking.employeeId).lean(),
  ])
    .then(([corporate, employee]) => corporate && notifyApproversOfTrip({ tripRequest, corporate, employee }))
    .catch((error) => console.warn('[corporate-approval] approver notification failed', error.message));

  return tripRequest;
};

/// Approvers scoped to departments may only act inside them; owners and admins
/// act on everything in their company.
const assertCanDecide = (admin, tripRequest) => {
  if (String(admin.corporateId) !== String(tripRequest.corporateId)) {
    throw new ApiError(404, 'Trip request not found');
  }
  if (['owner', 'admin'].includes(admin.role)) return;
  if (admin.role !== 'approver') throw new ApiError(403, 'Only approvers can decide trips');
  const scoped = (admin.departmentIds || []).map(String);
  if (scoped.length && !scoped.includes(String(tripRequest.departmentId))) {
    throw new ApiError(403, 'This trip belongs to a department you do not approve for');
  }
};

const cancelHeldRide = async ({ rideId, approvalStatus, reason }) => {
  const ride = await Ride.findOneAndUpdate(
    { _id: rideId, status: RIDE_STATUS.SEARCHING },
    {
      $set: {
        status: RIDE_STATUS.CANCELLED,
        liveStatus: RIDE_LIVE_STATUS.CANCELLED,
        'corporate.approvalStatus': approvalStatus,
      },
    },
    { returnDocument: 'after' },
  );
  if (!ride) {
    await Ride.updateOne({ _id: rideId }, { $set: { 'corporate.approvalStatus': approvalStatus } });
    return null;
  }

  await Promise.all([
    User.updateOne({ _id: ride.userId, currentRideId: ride._id }, { $set: { currentRideId: null } }),
    ride.deliveryId
      ? Delivery.updateOne({ _id: ride.deliveryId }, { $set: { status: ride.status, liveStatus: ride.liveStatus } })
      : null,
  ]);

  try {
    const { getUserRoom } = await dispatchModule();
    const { getRideRoom } = await import('../../services/rideService.js');
    await emitToRoom(getUserRoom(ride.userId), 'rideCancelled', {
      rideId: String(ride._id),
      room: getRideRoom(ride._id),
      reason,
    });
    await emitToRoom(getRideRoom(ride._id), 'ride:status:updated', {
      rideId: String(ride._id),
      status: ride.status,
      liveStatus: ride.liveStatus,
    });
  } catch (error) {
    console.warn('[corporate-approval] cancel emit failed', error.message);
  }

  return ride;
};

export const approveTripRequest = async ({ admin, tripRequestId, note = '' }) => {
  if (!mongoose.Types.ObjectId.isValid(String(tripRequestId))) throw new ApiError(400, 'Invalid trip request id');
  const existing = await CorporateTripRequest.findById(tripRequestId).lean();
  if (!existing) throw new ApiError(404, 'Trip request not found');
  assertCanDecide(admin, existing);

  const tripRequest = await CorporateTripRequest.findOneAndUpdate(
    { _id: tripRequestId, status: 'pending' },
    { $set: { status: 'approved', approverId: admin._id, decisionAt: new Date(), note: String(note || '').trim() } },
    { returnDocument: 'after' },
  );
  if (!tripRequest) throw new ApiError(409, `Trip request is already ${existing.status}`);

  if (!tripRequest.rideId) return tripRequest;

  const ride = await Ride.findOneAndUpdate(
    { _id: tripRequest.rideId, status: RIDE_STATUS.SEARCHING },
    { $set: { 'corporate.approvalStatus': 'approved' } },
    { returnDocument: 'after' },
  ).populate('userId', 'name phone countryCode');

  if (!ride) {
    // The rider cancelled while waiting.
    tripRequest.status = 'cancelled';
    await tripRequest.save();
    return tripRequest;
  }

  const { startDispatchFlow } = await dispatchModule();
  await startDispatchFlow(ride);
  tripRequest.status = 'booked';
  await tripRequest.save();

  const riderId = ride.userId?._id || ride.userId;
  emitToUser(riderId, 'corporate:trip:approved', { rideId: String(ride._id), tripRequestId: String(tripRequest._id) });
  notifyRider({
    userId: riderId,
    title: 'Trip approved',
    body: 'Your company approved the trip. Finding you a driver now.',
    data: { type: 'corporate_trip_approved', rideId: String(ride._id) },
  });

  return tripRequest;
};

export const rejectTripRequest = async ({ admin, tripRequestId, note = '' }) => {
  if (!mongoose.Types.ObjectId.isValid(String(tripRequestId))) throw new ApiError(400, 'Invalid trip request id');
  const existing = await CorporateTripRequest.findById(tripRequestId).lean();
  if (!existing) throw new ApiError(404, 'Trip request not found');
  assertCanDecide(admin, existing);

  const tripRequest = await CorporateTripRequest.findOneAndUpdate(
    { _id: tripRequestId, status: 'pending' },
    { $set: { status: 'rejected', approverId: admin._id, decisionAt: new Date(), note: String(note || '').trim() } },
    { returnDocument: 'after' },
  );
  if (!tripRequest) throw new ApiError(409, `Trip request is already ${existing.status}`);

  await closeTripRequestRide(tripRequest, 'rejected', note ? `Rejected by your company: ${note}` : 'Rejected by your company');
  return tripRequest;
};

const closeTripRequestRide = async (tripRequest, status, reason) => {
  if (!tripRequest.rideId) return;
  await cancelHeldRide({ rideId: tripRequest.rideId, approvalStatus: status, reason });
  emitToUser(tripRequest.userId, 'corporate:trip:rejected', {
    rideId: String(tripRequest.rideId),
    tripRequestId: String(tripRequest._id),
    status,
    note: tripRequest.note || '',
  });
  notifyRider({
    userId: tripRequest.userId,
    title: status === 'expired' ? 'Trip approval expired' : 'Trip not approved',
    body: status === 'expired'
      ? 'Nobody approved your corporate trip in time, so it was cancelled.'
      : reason,
    data: { type: `corporate_trip_${status}`, rideId: String(tripRequest.rideId) },
  });
};

/// Run by the corporate job loop. Each request is claimed with a conditional
/// update, so several server instances sweeping at once act on it once.
export const expirePendingTripRequests = async ({ now = new Date(), limit = 200 } = {}) => {
  const due = await CorporateTripRequest.find({ status: 'pending', expiresAt: { $lte: now } })
    .select('_id')
    .limit(limit)
    .lean();

  let expired = 0;
  for (const { _id } of due) {
    const tripRequest = await CorporateTripRequest.findOneAndUpdate(
      { _id, status: 'pending' },
      { $set: { status: 'expired', decisionAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!tripRequest) continue;
    expired += 1;
    await closeTripRequestRide(tripRequest, 'expired', 'Corporate approval expired').catch((error) =>
      console.warn('[corporate-approval] expiry cancel failed', error.message),
    );
  }

  // Requests whose ride the rider cancelled while waiting.
  const pending = await CorporateTripRequest.find({ status: 'pending', rideId: { $ne: null } })
    .select('_id rideId')
    .limit(limit)
    .lean();
  if (pending.length) {
    const cancelled = await Ride.find({ _id: { $in: pending.map((item) => item.rideId) }, status: RIDE_STATUS.CANCELLED })
      .select('_id')
      .lean();
    const cancelledIds = new Set(cancelled.map((item) => String(item._id)));
    const toCancel = pending.filter((item) => cancelledIds.has(String(item.rideId))).map((item) => item._id);
    if (toCancel.length) {
      await CorporateTripRequest.updateMany({ _id: { $in: toCancel }, status: 'pending' }, { $set: { status: 'cancelled' } });
    }
  }

  return { expired };
};

export const listTripRequests = async ({ admin, corporateId, status = '', page = 1, limit = 25 }) => {
  const filter = { corporateId };
  if (status) filter.status = status;
  if (admin?.role === 'approver' && (admin.departmentIds || []).length) {
    filter.departmentId = { $in: admin.departmentIds };
  }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);

  const [items, total] = await Promise.all([
    CorporateTripRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('employeeId', 'name phone employeeCode')
      .populate('departmentId', 'name code')
      .populate('approverId', 'name email')
      .lean(),
    CorporateTripRequest.countDocuments(filter),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
};
