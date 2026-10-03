import { normalizePoint, toPoint } from '../../../../utils/geo.js';
import { runRedisCommand } from '../../../../infrastructure/redis/redisClient.js';
import { RIDE_LIVE_STATUS } from '../../constants/index.js';
import { getDriverRoom } from '../../services/dispatchService.js';
import { DriverLocationHistory } from '../../driver/models/DriverLocationHistory.js';
import {
  appendRideMessage,
  getActiveRideForIdentity,
  getRideDetails,
  getRideRoom,
  serializeRideRealtime,
  updateRideDriverLocation,
  updateRideLifecycle,
} from '../../services/rideService.js';
import {
  mirrorRideDriverLocation,
  mirrorRideRealtimeState,
} from '../../services/rideRealtimeSyncService.js';
import { authorizeRideRoomAccess } from '../middleware/rideRoomAuth.js';
import { SOCKET_EVENTS } from '../events.js';
import { clearDriverRoute, updateDriverRoute } from '../services/driverRouteService.js';
import { consumeScopedRateLimit } from '../../middlewares/rateLimitMiddleware.js';
import { publishDriverLocation } from '../../admin/operations/adminFeedService.js';

// Same fast-read cache key the ambient (not-on-a-ride) location handler
// writes in socket/index.js, so a REST read of "where is this driver" works
// the same way regardless of whether they're mid-trip.
const DRIVER_LOCATION_CACHE_TTL_SECONDS = 120;
const cacheDriverLocation = (driverId, payload) => {
  runRedisCommand(
    (client) =>
      client.set(`driver:${driverId}:location`, JSON.stringify(payload), {
        EX: DRIVER_LOCATION_CACHE_TTL_SECONDS,
      }),
    { label: 'cache driver location' },
  );
};

// Headroom over what a driver app on an 8m filter produces at speed, so an
// honest burst - leaving a tunnel, regaining lock - is not silently discarded.
// At 30 a three-metre filter went past the limit at ordinary city speed and
// the surplus was dropped on arrival, which is what gave the rider ragged
// spacing between fixes and a marker that sped up and slowed down.
const RIDE_LOCATION_RATE_LIMIT_MAX = 60;
const RIDE_LOCATION_RATE_LIMIT_WINDOW_MS = 10_000;

/// Past this a fix describes the sky rather than the road. Forwarding one puts
/// a car through a building on the rider's map, and neither app can tell it
/// from a real fix once it has arrived.
const RIDE_LOCATION_MAX_ACCURACY_METERS = 60;

const driverLifecycleStatuses = new Set([
  RIDE_LIVE_STATUS.ACCEPTED,
  RIDE_LIVE_STATUS.ARRIVING,
  RIDE_LIVE_STATUS.STARTED,
  RIDE_LIVE_STATUS.ARRIVED,
  RIDE_LIVE_STATUS.COMPLETED,
]);
const RIDE_LOCATION_PERSIST_MIN_DISTANCE_METERS = 12;
const RIDE_LOCATION_PERSIST_MAX_INTERVAL_MS = 4000;
const rideLocationPersistState = new Map();

const toRadians = (value) => Number(value || 0) * (Math.PI / 180);

const getDistanceMeters = (first = [], second = []) => {
  const [firstLng, firstLat] = first;
  const [secondLng, secondLat] = second;

  if (![firstLng, firstLat, secondLng, secondLat].every((value) => Number.isFinite(Number(value)))) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadiusMeters = 6371000;
  const deltaLat = toRadians(Number(secondLat) - Number(firstLat));
  const deltaLng = toRadians(Number(secondLng) - Number(firstLng));
  const startLat = toRadians(firstLat);
  const endLat = toRadians(secondLat);
  const haversine = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

export const registerRideSocketHandlers = ({ io, socket, onAsync }) => {
  const emitRideState = (ride) => {
    const payload = serializeRideRealtime(ride);
    io.to(getRideRoom(ride._id)).emit(SOCKET_EVENTS.RIDE_STATE, payload);
    setImmediate(() => {
      mirrorRideRealtimeState(payload).catch(() => {});
    });
    return payload;
  };

  socket.on(
    SOCKET_EVENTS.RIDE_JOIN,
    onAsync(socket, async ({ rideId }) => {
      if (!rideId) {
        throw new Error('rideId is required');
      }

      const ride = await authorizeRideRoomAccess({ socket, rideId });
      const room = getRideRoom(ride._id);
      socket.join(room);

      socket.emit(SOCKET_EVENTS.RIDE_JOINED, {
        rideId: String(ride._id),
        room,
      });

      const activeRide = await getActiveRideForIdentity({
        role: socket.auth.role,
        entityId: socket.auth.sub,
      });

      if (activeRide && String(activeRide._id) === String(ride._id)) {
        const payload = serializeRideRealtime(activeRide);
        socket.emit(SOCKET_EVENTS.RIDE_STATE, payload);
        setImmediate(() => {
          mirrorRideRealtimeState(payload).catch(() => {});
        });
        return;
      }

      // This ride is not (or no longer) the caller's active ride — most often
      // because it was cancelled or completed while this socket was
      // disconnected. The room broadcast that would normally announce that is
      // long gone by the time a new connection re-joins, so without this the
      // rejoining side (typically a driver whose transport dropped mid-trip)
      // is left showing a ride that is already over with nothing to correct
      // it. Sending this ride's own current state lets the existing
      // `ride:state` handler resolve it the same way a live cancellation or
      // completion does.
      //
      // Re-fetched fully rather than reusing `ride`: authorizeRideRoomAccess
      // only selects the fields it needs for the access check, and
      // serializeRideRealtime needs the rest (addresses, fare, populated
      // rider/delivery) to produce a payload the client can actually parse.
      const fullRide = await getRideDetails(ride._id);
      socket.emit(SOCKET_EVENTS.RIDE_STATE, serializeRideRealtime(fullRide));
    }),
  );

  socket.on(
    SOCKET_EVENTS.RIDE_REJOIN_CURRENT,
    onAsync(socket, async () => {
      const ride = await getActiveRideForIdentity({
        role: socket.auth.role,
        entityId: socket.auth.sub,
      });

      if (!ride) {
        socket.emit(SOCKET_EVENTS.RIDE_STATE, null);
        return;
      }

      const room = getRideRoom(ride._id);
      socket.join(room);
      socket.emit(SOCKET_EVENTS.RIDE_JOINED, {
        rideId: String(ride._id),
        room,
        rejoined: true,
      });
      const payload = serializeRideRealtime(ride);
      socket.emit(SOCKET_EVENTS.RIDE_STATE, payload);
      setImmediate(() => {
        mirrorRideRealtimeState(payload).catch(() => {});
      });
    }),
  );

  socket.on(
    SOCKET_EVENTS.RIDE_DRIVER_LOCATION_UPDATE,
    onAsync(socket, async ({ rideId, coordinates, heading, speed, accuracy, timestamp, sequence }) => {
      if (socket.auth.role !== 'driver') {
        throw new Error('Only drivers can update live ride location');
      }

      const rateLimitOutcome = await consumeScopedRateLimit({
        scope: 'ride_driver_location_socket',
        max: RIDE_LOCATION_RATE_LIMIT_MAX,
        windowMs: RIDE_LOCATION_RATE_LIMIT_WINDOW_MS,
        mode: 'custom',
        parts: [socket.auth.sub],
      });
      if (!rateLimitOutcome.allowed) {
        return;
      }

      await authorizeRideRoomAccess({ socket, rideId });
      const normalizedCoordinates = normalizePoint(coordinates, 'coordinates');
      const persistKey = `${rideId}:${socket.auth.sub}`;
      const now = Date.now();
      const previousPersistState = rideLocationPersistState.get(persistKey) || {};

      // Passing sequence through lets the rider *reject* a late packet; acting
      // on it here means the late packet is never sent to anyone in the first
      // place - including the driver's own second device, the admin map, and
      // the location history the analytics read.
      const incomingSequence = Number.isFinite(Number(sequence)) ? Number(sequence) : null;
      const lastSequence = Number(previousPersistState.sequence);
      if (incomingSequence !== null && Number.isFinite(lastSequence) && incomingSequence <= lastSequence) {
        return;
      }

      // Only once there is an earlier fix worth keeping instead: the first of a
      // trip goes through however vague it is, or the rider watches an empty
      // map until the phone gets a clean lock.
      const incomingAccuracy = Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
      if (
        incomingAccuracy !== null &&
        incomingAccuracy > RIDE_LOCATION_MAX_ACCURACY_METERS &&
        Array.isArray(previousPersistState.coordinates)
      ) {
        return;
      }
      const distanceFromPrevious = Array.isArray(previousPersistState.coordinates)
        ? getDistanceMeters(previousPersistState.coordinates, normalizedCoordinates)
        : Number.POSITIVE_INFINITY;
      const shouldPersistLocation = !Array.isArray(previousPersistState.coordinates) ||
        distanceFromPrevious >= RIDE_LOCATION_PERSIST_MIN_DISTANCE_METERS ||
        now - Number(previousPersistState.persistedAt || 0) >= RIDE_LOCATION_PERSIST_MAX_INTERVAL_MS;
      const fallbackLocationUpdate = {
        rideId: String(rideId),
        coordinates: normalizedCoordinates,
        heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
        speed: Number.isFinite(Number(speed)) ? Number(speed) : null,
        updatedAt: new Date().toISOString(),
      };
      const locationUpdate = shouldPersistLocation
        ? await updateRideDriverLocation({
            rideId,
            driverId: socket.auth.sub,
            coordinates: normalizedCoordinates,
            heading,
            speed,
          })
        : fallbackLocationUpdate;

      // Passthrough only, not persisted — this is what lets the rider app
      // reject a delayed/out-of-order packet (sequence/timestamp) and avoid
      // treating a poor-accuracy fix as grounds for a reroute. An older
      // driver build simply won't send these, and the rider already treats
      // every one of them as optional.
      const normalizedAccuracy = Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
      const normalizedTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : null;
      const normalizedSequence = Number.isFinite(Number(sequence)) ? Number(sequence) : null;
      const broadcastPayload = {
        ...locationUpdate,
        ...(normalizedAccuracy !== null ? { accuracy: normalizedAccuracy } : {}),
        ...(normalizedTimestamp !== null ? { timestamp: normalizedTimestamp } : {}),
        ...(normalizedSequence !== null ? { sequence: normalizedSequence } : {}),
      };

      io.to(getRideRoom(rideId)).emit(SOCKET_EVENTS.RIDE_DRIVER_LOCATION_UPDATED, broadcastPayload);
      publishDriverLocation(socket.auth.sub, { coordinates: normalizedCoordinates, heading: locationUpdate.heading, speed: locationUpdate.speed, rideId, isOnRide: true });
      // Fast-read cache, written every tick regardless of the persist
      // throttle above — a REST read should see the true latest fix.
      cacheDriverLocation(socket.auth.sub, {
        coordinates: normalizedCoordinates,
        heading: locationUpdate.heading,
        speed: locationUpdate.speed,
        updatedAt: now,
      });
      if (shouldPersistLocation) {
        setImmediate(() => {
          mirrorRideDriverLocation({
            rideId,
            coordinates: locationUpdate.coordinates,
            heading: locationUpdate.heading,
            speed: locationUpdate.speed,
          }).catch(() => {});
        });
        // Analytics only — never let this hold up the live-tracking path.
        DriverLocationHistory.create({
          driverId: socket.auth.sub,
          rideId,
          location: toPoint(normalizedCoordinates, 'coordinates'),
          heading: locationUpdate.heading,
          speed: locationUpdate.speed,
        }).catch((error) => {
          console.error('Failed to persist ride driver location history', error.message);
        });
      }

      rideLocationPersistState.set(persistKey, {
        coordinates: normalizedCoordinates,
        persistedAt: shouldPersistLocation ? now : Number(previousPersistState.persistedAt || 0),
        sequence: incomingSequence ?? previousPersistState.sequence ?? null,
      });

      // Keeps the Firebase breadcrumb trail, which is throttled to one write
      // per ten seconds inside, without the socket fan-out it used to do on
      // every tick: `ride:driver-route:updated` carried the whole accumulated
      // point array to a room where neither app has ever had a handler for it.
      updateDriverRoute({
        rideId,
        driverId: socket.auth.sub,
        coordinates: normalizedCoordinates,
      });
    }),
  );

  socket.on(
    SOCKET_EVENTS.RIDE_STATUS_UPDATE,
    onAsync(socket, async ({ rideId, status, paymentMethod }) => {
      if (socket.auth.role !== 'driver') {
        throw new Error('Only drivers can update ride status');
      }

      if (!driverLifecycleStatuses.has(status)) {
        throw new Error('Unsupported ride status transition');
      }

      await authorizeRideRoomAccess({ socket, rideId });

      const ride = await updateRideLifecycle({
        rideId,
        driverId: socket.auth.sub,
        nextStatus: status,
        paymentMethod,
      });
      const populatedRide = await getRideDetails(rideId);

      const payload = {
        rideId: String(populatedRide._id),
        status: populatedRide.status,
        liveStatus: populatedRide.liveStatus,
        acceptedAt: populatedRide.acceptedAt,
        arrivedAt: populatedRide.arrivedAt,
        startedAt: populatedRide.startedAt,
        completedAt: populatedRide.completedAt,
      };

      io.to(getRideRoom(rideId)).emit(SOCKET_EVENTS.RIDE_STATUS_UPDATED, payload);
      emitRideState(populatedRide);

      if (status === RIDE_LIVE_STATUS.COMPLETED) {
        const walletUpdate = ride.$locals?.walletUpdate;
        if (walletUpdate) {
          io.to(getDriverRoom(socket.auth.sub)).emit('driver:wallet:updated', {
            wallet: walletUpdate.wallet,
            transaction: walletUpdate.transaction,
          });
        }
        clearDriverRoute(socket.auth.sub);
        rideLocationPersistState.delete(`${rideId}:${socket.auth.sub}`);
      }
    }),
  );

  socket.on(
    SOCKET_EVENTS.RIDE_MESSAGE_SEND,
    onAsync(socket, async ({ rideId, message }) => {
      await authorizeRideRoomAccess({ socket, rideId });

      const savedMessage = await appendRideMessage({
        rideId,
        role: socket.auth.role,
        senderId: socket.auth.sub,
        message,
      });

      io.to(getRideRoom(rideId)).emit(SOCKET_EVENTS.RIDE_MESSAGE_NEW, savedMessage);
    }),
  );
};
