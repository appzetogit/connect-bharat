import { Ride } from '../../user/models/Ride.js';

/// Live feed for the admin panel: ride lifecycle and driver positions, pushed
/// to the `admin:broadcast` socket room every admin socket joins on connect
/// (see addSocketSubscriptions in services/dispatchService.js).
///
/// Before this the panel only polled REST, so the Ongoing page and the map
/// were up to a minute behind. The existing emit points call into here with
/// one line each; everything below is best-effort and never throws, because a
/// failed admin notification must not fail a rider's booking or a driver's
/// status change.
///
/// The socket server is looked up lazily with a dynamic import. rideService
/// calls this module, and dispatchService imports rideService, so a static
/// import of dispatchService here would close an import cycle at load time.

export const ADMIN_FEED_EVENTS = Object.freeze({
  RIDE_LIFECYCLE: 'admin:ride:lifecycle',
  DRIVER_LOCATION: 'admin:driver:location',
});

export const ADMIN_ROOM = 'admin:broadcast';

/// One position per driver at most this often. Drivers send every 3-30s, so
/// at 5s the map stays smooth while 1,000 online drivers cost at most 200
/// small messages a second to the admin room.
export const DRIVER_LOCATION_FEED_INTERVAL_MS = 5000;

const CANCELLATION_ACTORS = new Set(['user', 'driver', 'admin', 'system']);

let dispatchModulePromise = null;
const loadDispatchModule = () => {
  if (!dispatchModulePromise) {
    dispatchModulePromise = import('../../services/dispatchService.js').catch((error) => {
      dispatchModulePromise = null;
      throw error;
    });
  }
  return dispatchModulePromise;
};

const emitToAdminRoom = (event, payload) => {
  loadDispatchModule()
    .then((dispatch) => {
      const io = dispatch.getSocketServer?.();
      if (io) {
        io.to(ADMIN_ROOM).emit(event, payload);
      }
    })
    .catch((error) => {
      console.error('[admin-feed] emit failed', event, error?.message || error);
    });
};

/// Same lazy path for the per-driver and per-user rooms, for modules that sit
/// under rideService/matchingService in the import graph and so cannot import
/// dispatchService themselves.
export const emitToDriverRoom = (driverId, event, payload) => {
  if (!driverId) return;
  loadDispatchModule()
    .then((dispatch) => dispatch.emitToDriver?.(String(driverId), event, payload))
    .catch((error) => console.error('[admin-feed] driver emit failed', event, error?.message || error));
};

export const emitToUserRoom = (userId, event, payload) => {
  if (!userId) return;
  loadDispatchModule()
    .then((dispatch) => {
      const io = dispatch.getSocketServer?.();
      if (io) io.to(dispatch.getUserRoom(String(userId))).emit(event, payload);
    })
    .catch((error) => console.error('[admin-feed] user emit failed', event, error?.message || error));
};

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const nameOf = (value) => (value && typeof value === 'object' && value.name ? value.name : '');

/// The compact ride shape the admin feed carries. Accepts a Mongoose document,
/// a lean object, or one with userId/driverId populated.
export const serializeRideForAdminFeed = (ride = {}) => {
  const lastLocation = ride?.lastDriverLocation?.coordinates?.length === 2
    ? {
        lng: Number(ride.lastDriverLocation.coordinates[0]),
        lat: Number(ride.lastDriverLocation.coordinates[1]),
        heading: ride.lastDriverLocation.heading ?? null,
        updatedAt: ride.lastDriverLocation.updatedAt || null,
      }
    : null;

  return {
    rideId: idOf(ride?._id),
    serviceType: ride?.serviceType || 'ride',
    status: ride?.status || '',
    liveStatus: ride?.liveStatus || '',
    fare: Number(ride?.fare || 0),
    paymentMethod: ride?.paymentMethod || '',
    bookingMode: ride?.bookingMode || 'normal',
    userId: idOf(ride?.userId),
    userName: nameOf(ride?.userId),
    driverId: idOf(ride?.driverId),
    driverName: nameOf(ride?.driverId),
    vehicleTypeId: idOf(ride?.vehicleTypeId),
    serviceLocationId: idOf(ride?.service_location_id),
    pickupAddress: ride?.pickupAddress || '',
    dropAddress: ride?.dropAddress || '',
    pickup: Array.isArray(ride?.pickupLocation?.coordinates) ? ride.pickupLocation.coordinates : null,
    drop: Array.isArray(ride?.dropLocation?.coordinates) ? ride.dropLocation.coordinates : null,
    scheduledAt: ride?.scheduledAt || null,
    createdAt: ride?.createdAt || null,
    acceptedAt: ride?.acceptedAt || null,
    startedAt: ride?.startedAt || null,
    completedAt: ride?.completedAt || null,
    cancelledByRole: ride?.cancelledByRole || '',
    assignedBy: ride?.assignedBy?.adminId
      ? {
          adminId: idOf(ride.assignedBy.adminId),
          at: ride.assignedBy.at || null,
          mode: ride.assignedBy.mode || 'manual',
        }
      : null,
    lastDriverLocation: lastLocation,
  };
};

/// The accept path is shared by driver accepts and admin assignments; the
/// assignedBy stamp written by manual assignment tells them apart.
export const lifecycleEventForAcceptedRide = (ride = {}) => {
  if (!ride?.assignedBy?.adminId) return 'accepted';
  return ride.assignedBy.previousDriverId ? 'reassigned' : 'assigned';
};

/// Ride lifecycle hook. `event` is one of created, accepted, assigned,
/// reassigned, status, completed, cancelled. A status change to completed is
/// reported as `completed` so the panel can count it without inspecting fields.
export const publishRideLifecycle = (event, ride, extra = {}) => {
  try {
    if (!ride?._id) return;
    const summary = serializeRideForAdminFeed(ride);
    const resolvedEvent = event === 'status' && summary.liveStatus === 'completed' ? 'completed' : event;
    emitToAdminRoom(ADMIN_FEED_EVENTS.RIDE_LIFECYCLE, {
      event: resolvedEvent,
      at: new Date().toISOString(),
      ride: summary,
      ...extra,
    });
  } catch (error) {
    console.error('[admin-feed] ride lifecycle failed', error?.message || error);
  }
};

/// Cancellation hook: records who cancelled (for the dashboard split) and tells
/// the panel. Only fills cancelledByRole when nothing set it first, so the
/// first path to cancel a ride is the one credited.
export const publishRideCancelled = (ride, actorRole = '', extra = {}) => {
  try {
    if (!ride?._id) return;
    const actor = CANCELLATION_ACTORS.has(String(actorRole)) ? String(actorRole) : '';
    if (actor) {
      Ride.updateOne(
        { _id: ride._id, $or: [{ cancelledByRole: { $exists: false } }, { cancelledByRole: '' }, { cancelledByRole: null }] },
        { $set: { cancelledByRole: actor } },
      ).catch((error) => console.error('[admin-feed] could not record cancellation actor', error?.message || error));
    }
    publishRideLifecycle('cancelled', { ...(ride.toObject ? ride.toObject() : ride), cancelledByRole: actor || ride.cancelledByRole || '' }, {
      cancelledBy: actor,
      ...extra,
    });
  } catch (error) {
    console.error('[admin-feed] ride cancelled failed', error?.message || error);
  }
};

/// Per-key "at most once every N ms" gate. Pure apart from its own map, so it
/// is unit-tested directly. Stale keys are pruned once the map grows, so a day
/// of drivers coming and going doesn't accumulate forever.
export const createKeyedThrottle = (intervalMs, { maxKeys = 20_000 } = {}) => {
  const lastEmitAt = new Map();

  return {
    shouldEmit(key, nowMs = Date.now()) {
      const safeKey = String(key || '');
      if (!safeKey) return false;
      const previous = lastEmitAt.get(safeKey);
      if (previous !== undefined && nowMs - previous < intervalMs) {
        return false;
      }
      lastEmitAt.set(safeKey, nowMs);

      if (lastEmitAt.size > maxKeys) {
        const cutoff = nowMs - intervalMs * 12;
        for (const [entryKey, at] of lastEmitAt) {
          if (at < cutoff) lastEmitAt.delete(entryKey);
        }
      }
      return true;
    },
    size: () => lastEmitAt.size,
    reset: () => lastEmitAt.clear(),
  };
};

const driverLocationThrottle = createKeyedThrottle(DRIVER_LOCATION_FEED_INTERVAL_MS);

/// Driver position hook, called from both location handlers (ambient and
/// on-trip). Throttled per driver; the on-trip handler passes rideId so the
/// panel can tie a moving pin to its trip.
export const publishDriverLocation = (driverId, { coordinates, heading = null, speed = null, rideId = null, isOnRide = undefined } = {}) => {
  try {
    if (!driverId || !Array.isArray(coordinates) || coordinates.length !== 2) return;
    const [lng, lat] = coordinates.map(Number);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (!driverLocationThrottle.shouldEmit(driverId)) return;

    emitToAdminRoom(ADMIN_FEED_EVENTS.DRIVER_LOCATION, {
      driverId: String(driverId),
      lat,
      lng,
      heading: Number.isFinite(Number(heading)) && heading !== null ? Number(heading) : null,
      speed: Number.isFinite(Number(speed)) && speed !== null ? Number(speed) : null,
      rideId: rideId ? String(rideId) : null,
      ...(isOnRide === undefined ? {} : { isOnRide: Boolean(isOnRide) }),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin-feed] driver location failed', error?.message || error);
  }
};
