import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RIDE_LIVE_STATUS, RIDE_STATUS } from '../../constants/index.js';
import { Driver } from '../../driver/models/Driver.js';
import { ensureDriverWalletCanAcceptRide } from '../../driver/services/walletService.js';
import { Delivery } from '../../user/models/Delivery.js';
import { Ride } from '../../user/models/Ride.js';
import { FleetVehicle } from '../models/FleetVehicle.js';
import {
  emitToDriver,
  getDriverRoom,
  getSocketServer,
  notifyRideAccepted,
  sendRideOfferClosedPush,
  stopDispatchFlow,
} from '../../services/dispatchService.js';
import {
  findDriverConflictingScheduledRide,
  getDriverIdsBlockedByUpcomingScheduledRides,
  getRideDetails,
  getRideRoom,
  isRideScheduledForFuture,
  serializeRideRealtime,
} from '../../services/rideService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { SOCKET_EVENTS } from '../../socket/events.js';
import { publishRideLifecycle, serializeRideForAdminFeed } from './adminFeedService.js';
import { assertObjectId, assertServiceLocationScope } from './operationsAccess.js';
import { getOperationsGates } from './operationsSettings.js';
import { isDriverVehicleApproved } from './vehicleApprovalService.js';
import { haversineMeters } from './locationHistoryService.js';

/// Manual driver assignment (SOW 2.10): an admin puts a chosen driver on a ride
/// that is still searching, or swaps the driver on one that was accepted but
/// not yet started.
///
/// It goes through the same two conditional claims as a driver's own accept
/// (acceptRideAssignment in rideService) - driver first, then ride - so an
/// admin assignment racing a driver's accept still produces exactly one
/// winner. Afterwards it calls notifyRideAccepted, the function the accept path
/// uses, so the rider app, the driver app and the push notifications behave as
/// they would for a normal accept.

/// Rough city ETA for the candidate list. Straight-line distance times a road
/// factor at a conservative average speed; labelled an estimate in the API.
const CANDIDATE_ROAD_FACTOR = 1.3;
const CANDIDATE_AVERAGE_SPEED_KMPH = 22;

export const ASSIGNMENT_REFUSAL_REASONS = Object.freeze({
  deleted: 'Driver account is deleted',
  not_approved: 'Driver is not approved',
  blocked: 'Driver account is blocked',
  offline: 'Driver is offline',
  on_ride: 'Driver is already on a ride',
  wallet_blocked: 'Driver wallet is blocked',
  vehicle_mismatch: 'Driver vehicle type does not match this ride',
  vehicle_not_approved: 'Driver vehicle is not approved',
  scheduled_soon: 'Driver has a scheduled trip within 30 minutes',
  scheduled_conflict: 'Driver has another scheduled trip at this time',
});

/// Reasons `force` may override: the driver is reachable and free, the admin
/// is vouching for the rest (e.g. a driver who is about to come online, or a
/// sedan sent for a hatchback booking). Never overridable: a driver who is
/// deleted, unapproved, blocked, already busy, or double-booked.
const FORCE_OVERRIDABLE = new Set(['offline', 'wallet_blocked', 'vehicle_mismatch', 'vehicle_not_approved']);

const normalizeKey = (value = '') => String(value || '').trim().toLowerCase();

/// Same rule as buildDriverVehicleAcceptFilter in rideService: match on the
/// vehicle-type ids when the ride has any (primary or any enrolled category),
/// otherwise fall back to the vehicle-type/icon names.
export const driverMatchesRideVehicle = (driver = {}, ride = {}) => {
  const wanted = [...new Set(
    [...(Array.isArray(ride?.dispatchVehicleTypeIds) ? ride.dispatchVehicleTypeIds : []), ride?.vehicleTypeId]
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  )];

  if (wanted.length) {
    const mine = [driver?.vehicleTypeId, ...(Array.isArray(driver?.vehicleTypeIds) ? driver.vehicleTypeIds : [])]
      .filter(Boolean)
      .map(String);
    return mine.some((id) => wanted.includes(id));
  }

  const keys = [...new Set([
    ride?.vehicleIconType,
    ride?.vehicleType,
    String(ride?.vehicleIconType || '').replace(/\s+/g, '_'),
    String(ride?.vehicleType || '').replace(/\s+/g, '_'),
  ].map(normalizeKey).filter(Boolean))];

  if (!keys.length) return true;
  return keys.includes(normalizeKey(driver?.vehicleType)) || keys.includes(normalizeKey(driver?.vehicleIconType));
};

/// Can this driver be put on this ride? Pure, so it is unit-tested; the I/O
/// (fleet vehicle, schedule checks) is done by the caller and passed in.
export const evaluateDriverEligibility = ({
  driver = {},
  ride = {},
  fleetVehicle = null,
  requireVehicleApproval = false,
  scheduledSoon = false,
  scheduledConflict = false,
  rideIsFutureScheduled = false,
  force = false,
} = {}) => {
  const reasons = [];
  if (driver?.deletedAt) reasons.push('deleted');
  if (driver?.approve === false) reasons.push('not_approved');
  if (String(driver?.status || '').toLowerCase() === 'blocked') reasons.push('blocked');
  // A trip booked for later does not need the driver online or free now -
  // the same rule acceptRideAssignment applies when it decides whether to
  // occupy the driver.
  if (!rideIsFutureScheduled && !driver?.isOnline) reasons.push('offline');
  if (!rideIsFutureScheduled && driver?.isOnRide) reasons.push('on_ride');
  if (driver?.wallet?.isBlocked && !driver?.owner_id) reasons.push('wallet_blocked');
  if (!driverMatchesRideVehicle(driver, ride)) reasons.push('vehicle_mismatch');
  if (requireVehicleApproval && !isDriverVehicleApproved(driver, fleetVehicle)) reasons.push('vehicle_not_approved');
  if (scheduledSoon && !rideIsFutureScheduled) reasons.push('scheduled_soon');
  if (scheduledConflict) reasons.push('scheduled_conflict');

  const blocking = force ? reasons.filter((reason) => !FORCE_OVERRIDABLE.has(reason)) : reasons;
  return {
    eligible: blocking.length === 0,
    reasons,
    blockingReasons: blocking,
    overridden: force ? reasons.filter((reason) => FORCE_OVERRIDABLE.has(reason)) : [],
  };
};

export const estimateEtaMinutes = (distanceMeters) => {
  if (!Number.isFinite(distanceMeters)) return null;
  const roadKm = (distanceMeters * CANDIDATE_ROAD_FACTOR) / 1000;
  return Math.max(1, Math.round((roadKm / CANDIDATE_AVERAGE_SPEED_KMPH) * 60));
};

const DRIVER_ASSIGNMENT_SELECT =
  'name phone approve status deletedAt isOnline isOnRide owner_id wallet.isBlocked vehicleType vehicleTypeId vehicleTypeIds vehicleIconType vehicleNumber vehicleMake vehicleModel vehicleColor rating ratingCount location service_location_id assignedFleetVehicleId vehicleApproval';

const loadFleetVehicleStatuses = async (drivers = []) => {
  const ids = [...new Set(drivers.map((driver) => String(driver.assignedFleetVehicleId || '')).filter(Boolean))];
  if (!ids.length) return new Map();
  const vehicles = await FleetVehicle.find({ _id: { $in: ids } }).select('status').lean();
  return new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
};

const assertAssignableRideState = (ride, { force }) => {
  if (![RIDE_STATUS.SEARCHING, RIDE_STATUS.ACCEPTED].includes(ride.status)) {
    throw new ApiError(409, `A ${ride.status} ride cannot be assigned`);
  }
  if (ride.status === RIDE_STATUS.ACCEPTED && ![RIDE_LIVE_STATUS.ACCEPTED, RIDE_LIVE_STATUS.ARRIVING].includes(ride.liveStatus)) {
    throw new ApiError(409, 'The trip has already started and cannot be reassigned');
  }
  if (ride.status === RIDE_STATUS.SEARCHING && ride.bookingMode === 'bidding' && !force) {
    throw new ApiError(409, 'This ride is in bidding; pass force:true to assign a driver directly');
  }
};

export const listCandidateDrivers = async ({ rideId, query = {}, admin = null }) => {
  assertObjectId(rideId, 'rideId');
  const ride = await Ride.findById(rideId).lean();
  if (!ride) throw new ApiError(404, 'Ride not found');
  assertServiceLocationScope(admin, ride.service_location_id);

  const pickup = ride.pickupLocation?.coordinates;
  if (!Array.isArray(pickup) || pickup.length !== 2) {
    throw new ApiError(409, 'Ride has no pickup coordinates');
  }

  const radiusKm = Math.min(50, Math.max(1, Number(query.radius_km) || 10));
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
  const includeOffline = String(query.include_offline || '') === '1' || query.include_offline === 'true';
  const gates = await getOperationsGates();
  const rideIsFutureScheduled = isRideScheduledForFuture(ride);

  const drivers = await Driver.find({
    deletedAt: null,
    ...(includeOffline ? {} : { isOnline: true }),
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: pickup },
        $maxDistance: Math.round(radiusKm * 1000),
      },
    },
  })
    .limit(limit)
    .select(DRIVER_ASSIGNMENT_SELECT)
    .lean();

  const [fleetVehicles, scheduledSoonIds] = await Promise.all([
    loadFleetVehicleStatuses(drivers),
    getDriverIdsBlockedByUpcomingScheduledRides(drivers.map((driver) => String(driver._id))),
  ]);

  const candidates = drivers.map((driver) => {
    const coordinates = driver.location?.coordinates;
    const distanceMeters = Array.isArray(coordinates) && coordinates.length === 2
      ? Math.round(haversineMeters(pickup, coordinates))
      : null;
    const eligibility = evaluateDriverEligibility({
      driver,
      ride,
      fleetVehicle: fleetVehicles.get(String(driver.assignedFleetVehicleId || '')) || null,
      requireVehicleApproval: gates.requireVehicleApproval,
      scheduledSoon: scheduledSoonIds.has(String(driver._id)),
      rideIsFutureScheduled,
    });

    return {
      driverId: String(driver._id),
      name: driver.name || '',
      phone: driver.phone || '',
      vehicleType: driver.vehicleType || '',
      vehicleTypeId: driver.vehicleTypeId ? String(driver.vehicleTypeId) : null,
      vehicleNumber: driver.vehicleNumber || '',
      vehicleMake: driver.vehicleMake || '',
      vehicleModel: driver.vehicleModel || '',
      vehicleColor: driver.vehicleColor || '',
      rating: Number(driver.ratingCount || 0) > 0 ? Number(driver.rating || 0) : 0,
      isOnline: Boolean(driver.isOnline),
      isOnRide: Boolean(driver.isOnRide),
      lat: Array.isArray(coordinates) ? coordinates[1] : null,
      lng: Array.isArray(coordinates) ? coordinates[0] : null,
      distanceMeters,
      etaMinutes: estimateEtaMinutes(distanceMeters),
      isCurrentDriver: ride.driverId ? String(ride.driverId) === String(driver._id) : false,
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      reasonMessages: eligibility.reasons.map((reason) => ASSIGNMENT_REFUSAL_REASONS[reason] || reason),
      forceable: !eligibility.eligible && eligibility.reasons.every((reason) => FORCE_OVERRIDABLE.has(reason)),
    };
  });

  candidates.sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    return (left.distanceMeters ?? Infinity) - (right.distanceMeters ?? Infinity);
  });

  return {
    ride: serializeRideForAdminFeed(ride),
    radiusKm,
    etaIsEstimate: true,
    requireVehicleApproval: gates.requireVehicleApproval,
    candidates,
  };
};

const releaseDriverClaim = (driverId) =>
  Driver.updateOne({ _id: driverId, isOnRide: true }, { $set: { isOnRide: false } }).catch(() => null);

const moveDriverSocketsBetweenRooms = ({ joinDriverId = null, leaveDriverId = null, rideId }) => {
  const io = getSocketServer();
  if (!io) return;
  const room = getRideRoom(rideId);
  // socketsJoin/socketsLeave go through the adapter, so with Redis they reach
  // the driver's socket on whichever instance it is connected to.
  try {
    if (joinDriverId) io.in(getDriverRoom(String(joinDriverId))).socketsJoin(room);
    if (leaveDriverId) io.in(getDriverRoom(String(leaveDriverId))).socketsLeave(room);
  } catch (error) {
    console.error('[manual-assign] could not move driver sockets', error?.message || error);
  }
};

export const assignDriverToRide = async ({ rideId, driverId, force = false, admin = null, adminId = null }) => {
  assertObjectId(rideId, 'rideId');
  assertObjectId(driverId, 'driverId');
  const forceAssign = force === true || force === 'true' || force === 1 || force === '1';

  const ride = await Ride.findById(rideId);
  if (!ride) throw new ApiError(404, 'Ride not found');
  assertServiceLocationScope(admin, ride.service_location_id);
  assertAssignableRideState(ride, { force: forceAssign });

  const previousDriverId = ride.driverId ? String(ride.driverId) : null;
  const isReassign = ride.status === RIDE_STATUS.ACCEPTED;
  if (previousDriverId && previousDriverId === String(driverId)) {
    throw new ApiError(409, 'This driver is already assigned to the ride');
  }

  const driver = await Driver.findById(driverId).select(DRIVER_ASSIGNMENT_SELECT).lean();
  if (!driver) throw new ApiError(404, 'Driver not found');

  const rideIsFutureScheduled = isRideScheduledForFuture(ride);
  const [gates, fleetVehicles, scheduledSoonIds, conflictingRide] = await Promise.all([
    getOperationsGates(),
    loadFleetVehicleStatuses([driver]),
    getDriverIdsBlockedByUpcomingScheduledRides([String(driverId)]),
    findDriverConflictingScheduledRide({ driverId, ride, excludeRideId: ride._id }),
  ]);

  const eligibility = evaluateDriverEligibility({
    driver,
    ride,
    fleetVehicle: fleetVehicles.get(String(driver.assignedFleetVehicleId || '')) || null,
    requireVehicleApproval: gates.requireVehicleApproval,
    scheduledSoon: scheduledSoonIds.has(String(driverId)),
    scheduledConflict: Boolean(conflictingRide),
    rideIsFutureScheduled,
    force: forceAssign,
  });

  if (!eligibility.eligible) {
    throw new ApiError(
      409,
      eligibility.blockingReasons.map((reason) => ASSIGNMENT_REFUSAL_REASONS[reason] || reason).join('; '),
      { reasons: eligibility.reasons, blockingReasons: eligibility.blockingReasons, forceable: eligibility.blockingReasons.every((reason) => FORCE_OVERRIDABLE.has(reason)) },
    );
  }

  if (!forceAssign) {
    // Same wallet rule as a driver's own accept (throws 403 with the reason).
    await ensureDriverWalletCanAcceptRide(String(driverId));
  }

  const occupyDriver = !rideIsFutureScheduled;
  if (occupyDriver) {
    const claimed = await Driver.findOneAndUpdate(
      { _id: driverId, deletedAt: null, isOnRide: false, ...(forceAssign ? {} : { isOnline: true }) },
      { $set: { isOnRide: true } },
      { returnDocument: 'after' },
    ).select('_id');
    if (!claimed) {
      throw new ApiError(409, 'Driver was taken by another ride a moment ago');
    }
  }

  const now = new Date();
  const rideFilter = isReassign
    ? {
        _id: ride._id,
        status: RIDE_STATUS.ACCEPTED,
        driverId: previousDriverId,
        liveStatus: { $in: [RIDE_LIVE_STATUS.ACCEPTED, RIDE_LIVE_STATUS.ARRIVING] },
      }
    : { _id: ride._id, status: RIDE_STATUS.SEARCHING, driverId: null };

  const assignedRide = await Ride.findOneAndUpdate(
    rideFilter,
    {
      $set: {
        driverId: new mongoose.Types.ObjectId(String(driverId)),
        status: RIDE_STATUS.ACCEPTED,
        liveStatus: RIDE_LIVE_STATUS.ACCEPTED,
        acceptedAt: now,
        arrivedAt: null,
        assignedBy: {
          adminId: adminId || null,
          at: now,
          mode: 'manual',
          previousDriverId: previousDriverId || null,
        },
        ...(ride.bookingMode === 'bidding' ? { biddingStatus: 'accepted' } : {}),
      },
    },
    { returnDocument: 'after' },
  );

  if (!assignedRide) {
    if (occupyDriver) await releaseDriverClaim(driverId);
    throw new ApiError(409, 'The ride changed while assigning (accepted, started or cancelled). Refresh and try again');
  }

  // Local dispatch timers stop here; a dispatch loop on another instance stops
  // on its next tick because the ride is no longer searching.
  stopDispatchFlow(assignedRide._id);

  if (assignedRide.deliveryId) {
    await Delivery.findByIdAndUpdate(assignedRide.deliveryId, {
      driverId: assignedRide.driverId,
      status: assignedRide.status,
      liveStatus: assignedRide.liveStatus,
      acceptedAt: assignedRide.acceptedAt,
    }).catch((error) => console.error('[manual-assign] delivery sync failed', error?.message || error));
  }

  if (isReassign && previousDriverId) {
    await Driver.updateOne({ _id: previousDriverId }, { $set: { isOnRide: false } }).catch(() => null);
    moveDriverSocketsBetweenRooms({ leaveDriverId: previousDriverId, rideId: assignedRide._id });
    const releasePayload = { rideId: String(assignedRide._id), reason: 'reassigned-by-admin' };
    emitToDriver(previousDriverId, 'rideRequestClosed', releasePayload);
    emitToDriver(previousDriverId, 'ride:reassigned', releasePayload);
    sendPushNotificationToEntities({
      driverIds: [previousDriverId],
      title: 'Trip reassigned',
      body: 'This trip was moved to another driver by support.',
      data: { type: 'ride_reassigned', rideId: String(assignedRide._id) },
    }).catch((error) => console.error('[manual-assign] previous-driver push failed', error?.message || error));
  }

  moveDriverSocketsBetweenRooms({ joinDriverId: driverId, rideId: assignedRide._id });

  // Offers that went out from another instance are only known from the
  // persisted tracking, which notifyRideAccepted resets - so read it first.
  const offeredDriverIds = (ride.dispatchTracking?.notifiedDriverIds || [])
    .map(String)
    .filter((id) => id && id !== String(driverId) && id !== previousDriverId);

  try {
    await notifyRideAccepted(assignedRide);
  } catch (error) {
    // The assignment is saved; a notification failure must not report it as failed.
    console.error('[manual-assign] notifyRideAccepted failed', error?.message || error);
  }

  for (const offeredId of offeredDriverIds) {
    emitToDriver(offeredId, 'rideRequestClosed', {
      rideId: String(assignedRide._id),
      acceptedDriverId: String(driverId),
      reason: 'assigned-by-admin',
    });
  }
  sendRideOfferClosedPush(offeredDriverIds, assignedRide._id);

  let realtimeRide = null;
  try {
    const fullRide = await getRideDetails(assignedRide._id);
    realtimeRide = serializeRideRealtime(fullRide);
    // The newly assigned driver never sent an accept, so their app gets the
    // whole ride in one message as well as the usual rideAccepted.
    emitToDriver(String(driverId), 'ride:assigned', { ...realtimeRide, assignedByAdmin: true });
    getSocketServer()?.to(getRideRoom(assignedRide._id)).emit(SOCKET_EVENTS.RIDE_STATE, realtimeRide);
  } catch (error) {
    console.error('[manual-assign] realtime state emit failed', error?.message || error);
  }

  sendPushNotificationToEntities({
    driverIds: [String(driverId)],
    title: 'New trip assigned',
    body: assignedRide.pickupAddress
      ? `Pickup: ${assignedRide.pickupAddress}`
      : 'Support assigned you a trip. Open the app for details.',
    data: {
      type: 'ride_assigned',
      rideId: String(assignedRide._id),
      serviceType: assignedRide.serviceType || 'ride',
    },
  }).catch((error) => console.error('[manual-assign] driver push failed', error?.message || error));

  if (!getSocketServer()) {
    // No socket server (e.g. a worker process): still tell the admin feed.
    publishRideLifecycle(isReassign ? 'reassigned' : 'assigned', assignedRide);
  }

  return {
    ride: serializeRideForAdminFeed(assignedRide),
    mode: isReassign ? 'reassign' : 'assign',
    previousDriverId,
    driverId: String(driverId),
    forced: forceAssign,
    overriddenReasons: eligibility.overridden,
  };
};
