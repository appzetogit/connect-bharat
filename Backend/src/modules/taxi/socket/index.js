import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import { env } from '../../../config/env.js';
import { connectRedis, isRedisEnabled, runRedisCommand } from '../../../infrastructure/redis/redisClient.js';
import { normalizePoint, toPoint } from '../../../utils/geo.js';
import { Driver } from '../driver/models/Driver.js';
import { DriverLocationHistory } from '../driver/models/DriverLocationHistory.js';
import { Ride } from '../user/models/Ride.js';
import {
  broadcastSupportMessage,
  createSupportMessage,
  getSupportParticipantRoom,
  getSupportRoom,
  getSupportRoleRoom,
  markSupportMessagesAsRead,
  parseSupportConversationKey,
  setSupportChatServer,
} from '../chat/services/supportChatService.js';
import {
  addSocketSubscriptions,
  joinRideRoom,
  markDriverRejectedFromDispatch,
  notifyLateAvailableDriver,
  notifyRideAccepted,
  notifyRideBidUpdated,
  setSocketServer,
  startDispatchFlow,
} from '../services/dispatchService.js';
import { findZoneByPickup } from '../services/matchingService.js';
import { acceptRideAssignment, createRideRecord, getRideRoom, submitRideBid } from '../services/rideService.js';
import { SOCKET_EVENTS } from './events.js';
import { registerRideSocketHandlers } from './handlers/rideSocketHandler.js';
import { authorizeRideRoomAccess } from './middleware/rideRoomAuth.js';
import { attachSocketAuth } from './middleware/socketAuth.js';
import { clearDriverRoute } from './services/driverRouteService.js';
import { consumeScopedRateLimit } from '../middlewares/rateLimitMiddleware.js';
import { acceptRideOffer, rejectRideOffer } from '../driver/services/rideOfferActionService.js';

const DRIVER_LOCATION_WRITE_MIN_DISTANCE_METERS = 25;
const DRIVER_LOCATION_WRITE_MAX_INTERVAL_MS = 15000;
const DRIVER_ZONE_REFRESH_MIN_DISTANCE_METERS = 120;
const DRIVER_ZONE_REFRESH_MAX_INTERVAL_MS = 60000;
const driverLocationState = new Map();

// Fast-read cache for "where is this driver right now" — Mongo remains the
// source of truth (written on the same throttle as everything else below),
// this is purely so a REST read elsewhere doesn't wait on a Mongo round trip.
// Expires on its own so a driver who disconnects without a clean 'disconnect'
// event (killed app, dead battery) doesn't leave a stale entry forever.
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

// Generous headroom over the client's real cadence (one send every 3-30s per
// driver, adaptive — see the Flutter side) so legitimate bursts (a GPS fix
// retried after a dropped packet, a reconnect catch-up) never get dropped,
// while still capping a misbehaving or malicious client well short of
// hammering the DB on every tick.
const DRIVER_LOCATION_RATE_LIMIT_MAX = 30;
const DRIVER_LOCATION_RATE_LIMIT_WINDOW_MS = 10_000;

/// Compass bearing from one coordinate to the next, 0 = north, clockwise.
///
/// Devices do report a heading, but only while moving and not on every
/// platform, so it is treated as a hint: used when present and sane, derived
/// from the last two positions otherwise. Without this the rider's marker
/// always points north no matter which way the car is going.
const computeBearing = ([fromLng, fromLat], [toLng, toLat]) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLng = toRad(toLng - fromLng);
  const lat1 = toRad(fromLat);
  const lat2 = toRad(toLat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

/// Below this the GPS jitter of a stationary vehicle would spin the marker, so
/// the previous heading is kept instead.
const HEADING_MIN_MOVE_METERS = 8;



const getSocketClientIp = (socket) => {
  const forwardedFor = socket.handshake.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return socket.handshake.address || socket.conn?.remoteAddress || 'unknown';
};

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

const onAsync = (socket, handler) => async (payload = {}) => {
  try {
    await handler(payload);
  } catch (error) {
    socket.emit('errorMessage', {
      message: error.message || 'Socket operation failed',
    });
  }
};

/**
 * Rooms live in each process's memory, so with more than one backend instance an
 * io.to(room).emit() only reaches the sockets attached to *that* process. The
 * Redis adapter fans every emit out over pub/sub so all instances deliver it.
 * Without it, multi-instance silently drops ride offers, chat and live tracking
 * whenever sender and receiver land on different processes.
 */
const attachRedisAdapter = async (io) => {
  if (!isRedisEnabled()) {
    console.warn('[socket] redis disabled - safe only while a single instance runs');
    return;
  }

  const client = await connectRedis();
  if (!client?.isReady) {
    console.warn('[socket] redis not ready - adapter not attached');
    return;
  }

  // The subscriber connection cannot issue normal commands, so the adapter needs
  // its own pair rather than the shared client.
  const pubClient = client.duplicate();
  const subClient = client.duplicate();
  pubClient.on('error', (error) => console.error('[socket] redis pub error', error.message));
  subClient.on('error', (error) => console.error('[socket] redis sub error', error.message));
  await Promise.all([pubClient.connect(), subClient.connect()]);

  io.adapter(createAdapter(pubClient, subClient));
  console.log('[socket] redis adapter attached');
};

export const configureTaxiSocketServer = async (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(','),
      credentials: true,
    },
  });

  await attachRedisAdapter(io);

  attachSocketAuth(io);
  setSocketServer(io);
  setSupportChatServer(io);

  io.on('connection', async (socket) => {
    const identity = socket.auth;

    addSocketSubscriptions(socket, { role: identity.role, entityId: identity.sub });

    socket.join(getSupportParticipantRoom(identity.role, identity.sub));
    socket.join(getSupportRoleRoom(identity.role));

    if (identity.role === 'driver') {
      await Driver.findByIdAndUpdate(identity.sub, { socketId: socket.id });
      const previousDriverState = driverLocationState.get(identity.sub) || {};
      driverLocationState.set(identity.sub, {
        ...previousDriverState,
        socketId: socket.id,
      });
      notifyLateAvailableDriver(identity.sub).catch((error) => {
        console.error('Failed to notify late-available driver on socket connect', error);
      });
    }

    socket.on('chat:join', ({ conversationKey }) => {
      if (conversationKey) {
        const parsed = parseSupportConversationKey(conversationKey);

        if (parsed) {
          for (const key of parsed.keys) {
            socket.join(getSupportRoom(key));
          }
          return;
        }

        socket.join(getSupportRoom(conversationKey));
      }
    });

    socket.on(
      'chat:send',
      onAsync(socket, async ({ message, receiverRole, receiverId, conversationKey }) => {
        let nextReceiverRole = receiverRole;
        let nextReceiverId = receiverId;

        if (identity.role === 'admin' && (!nextReceiverRole || !nextReceiverId) && conversationKey) {
          const parsed = parseSupportConversationKey(conversationKey);
          nextReceiverRole = parsed?.peerRole;
          nextReceiverId = parsed?.peerId;
        }

        const savedMessage = await createSupportMessage({
          senderRole: identity.role,
          senderId: identity.sub,
          receiverRole: nextReceiverRole,
          receiverId: nextReceiverId,
          conversationKey,
          message,
        });

        broadcastSupportMessage(savedMessage);
      }),
    );

    socket.on(
      'chat:read',
      onAsync(socket, async ({ conversationKey }) => {
        if (!conversationKey) {
          return;
        }

        await markSupportMessagesAsRead({
          role: identity.role,
          id: identity.sub,
          conversationKey,
        });
      }),
    );

    socket.on(
      'joinRide',
      onAsync(socket, async ({ rideId }) => {
        if (!rideId) {
          return;
        }

        await authorizeRideRoomAccess({ socket, rideId });
        joinRideRoom(socket, rideId);
      }),
    );

    registerRideSocketHandlers({ io, socket, onAsync });

    socket.on(
      'locationUpdate',
      onAsync(socket, async ({ coordinates, heading, speed }) => {
        if (identity.role !== 'driver') {
          return;
        }

        const rateLimitOutcome = await consumeScopedRateLimit({
          scope: 'driver_location_socket',
          max: DRIVER_LOCATION_RATE_LIMIT_MAX,
          windowMs: DRIVER_LOCATION_RATE_LIMIT_WINDOW_MS,
          mode: 'custom',
          parts: [identity.sub],
        });
        if (!rateLimitOutcome.allowed) {
          return;
        }

        // Drivers push fresh GPS coordinates every few seconds so matching stays accurate.
        const normalizedCoords = normalizePoint(coordinates, 'coordinates');
        const now = Date.now();
        const previousDriverState = driverLocationState.get(identity.sub) || {};
        const distanceFromPrevious = Array.isArray(previousDriverState.coordinates)
          ? getDistanceMeters(previousDriverState.coordinates, normalizedCoords)
          : Number.POSITIVE_INFINITY;
        const timeSincePreviousWrite = now - Number(previousDriverState.updatedAt || 0);

        // Trust the device when it gives a usable heading; otherwise derive one
        // from the movement since the last ping, and hold the previous value
        // while the vehicle is essentially stationary. Resolved up front —
        // this used to be computed after the block below that already
        // consumed it, which threw on every write (a `let` read before its
        // own declaration) and silently dropped the driver's location update
        // whenever shouldWriteDriverState was true, i.e. on almost every
        // real-world tick (first ping, >25m moved, >15s elapsed, or a
        // reconnect). That's why a driver who was online but not yet on a
        // ride would so often show stale on the demand map and in nearby-ETA
        // lookups: the DB write for that path was failing silently.
        const reportedHeading = Number(heading);
        let resolvedHeading = Number.isFinite(reportedHeading) && reportedHeading >= 0 && reportedHeading <= 360
          ? reportedHeading
          : null;

        if (resolvedHeading === null) {
          resolvedHeading = Array.isArray(previousDriverState.coordinates)
            && distanceFromPrevious >= HEADING_MIN_MOVE_METERS
            ? computeBearing(previousDriverState.coordinates, normalizedCoords)
            : (previousDriverState.heading ?? null);
        }

        const shouldRefreshZone = !previousDriverState.zoneId ||
          distanceFromPrevious >= DRIVER_ZONE_REFRESH_MIN_DISTANCE_METERS ||
          now - Number(previousDriverState.zoneResolvedAt || 0) >= DRIVER_ZONE_REFRESH_MAX_INTERVAL_MS;
        const zone = shouldRefreshZone
          ? await findZoneByPickup(normalizedCoords)
          : (previousDriverState.zoneId ? { _id: previousDriverState.zoneId } : null);
        const nextZoneId = zone?._id ? String(zone._id) : null;
        const shouldWriteDriverState = !Array.isArray(previousDriverState.coordinates) ||
          distanceFromPrevious >= DRIVER_LOCATION_WRITE_MIN_DISTANCE_METERS ||
          timeSincePreviousWrite >= DRIVER_LOCATION_WRITE_MAX_INTERVAL_MS ||
          previousDriverState.socketId !== socket.id ||
          String(previousDriverState.zoneId || '') !== String(nextZoneId || '');
        const normalizedSpeed = Number.isFinite(Number(speed)) ? Number(speed) : null;

        if (shouldWriteDriverState) {
          await Driver.findByIdAndUpdate(identity.sub, {
            socketId: socket.id,
            location: toPoint(normalizedCoords, 'coordinates'),
            heading: resolvedHeading,
            zoneId: zone?._id || null,
          });

          // Analytics only — never let this hold up the live-tracking path.
          DriverLocationHistory.create({
            driverId: identity.sub,
            location: toPoint(normalizedCoords, 'coordinates'),
            heading: resolvedHeading,
            speed: normalizedSpeed,
          }).catch((error) => {
            console.error('Failed to persist driver location history', error.message);
          });
        }

        // Fast-read cache: written on every tick (not just throttled writes)
        // so a REST read always sees the true latest fix, not one up to
        // DRIVER_LOCATION_WRITE_MAX_INTERVAL_MS stale.
        cacheDriverLocation(identity.sub, {
          coordinates: normalizedCoords,
          heading: resolvedHeading,
          speed: normalizedSpeed,
          updatedAt: now,
        });

        driverLocationState.set(identity.sub, {
          coordinates: normalizedCoords,
          updatedAt: shouldWriteDriverState ? now : Number(previousDriverState.updatedAt || 0),
          zoneId: nextZoneId,
          zoneResolvedAt: shouldRefreshZone ? now : Number(previousDriverState.zoneResolvedAt || 0),
          socketId: socket.id,
          heading: resolvedHeading,
        });

        // The rider's map listens for this. It was declared in events.js but
        // never emitted, so live tracking never worked at all.
        const activeRide = await Ride.findOne({
          driverId: identity.sub,
          status: { $in: ['accepted', 'ongoing'] },
        })
          .select('_id')
          .lean();

        if (activeRide) {
          await Ride.updateOne(
            { _id: activeRide._id },
            {
              $set: {
                lastDriverLocation: {
                  type: 'Point',
                  coordinates: normalizedCoords,
                  heading: resolvedHeading,
                  speed: normalizedSpeed,
                  updatedAt: new Date(),
                },
              },
            },
          );

          io.to(getRideRoom(activeRide._id)).emit(SOCKET_EVENTS.RIDE_DRIVER_LOCATION_UPDATED, {
            rideId: String(activeRide._id),
            coordinates: normalizedCoords,
            lng: normalizedCoords[0],
            lat: normalizedCoords[1],
            heading: resolvedHeading,
            speed: normalizedSpeed,
            updatedAt: new Date().toISOString(),
          });
        }

        notifyLateAvailableDriver(identity.sub).catch((error) => {
          console.error('Failed to notify late-available driver on location update', error);
        });
      }),
    );

    socket.on(
      'requestRide',
      onAsync(socket, async ({ pickup, drop, fare, estimatedDistanceMeters, estimatedDurationMinutes, vehicleTypeId, vehicleIconType, paymentMethod, serviceType, intercity }) => {
        if (identity.role !== 'user') {
          return;
        }

        const rateLimitOutcome = await consumeScopedRateLimit({
          scope: 'ride_create_socket',
          max: 10,
          windowMs: 10 * 60 * 1000,
          mode: 'auth_or_ip',
          parts: [identity.sub || `ip:${getSocketClientIp(socket)}`],
        });
        if (!rateLimitOutcome.allowed) {
          socket.emit('errorMessage', {
            message: 'Too many ride requests. Please try again later.',
          });
          return;
        }

        // Ride creation and dispatch share the same service path as the REST controller.
        const ride = await createRideRecord({
          userId: identity.sub,
          pickupCoords: normalizePoint(pickup, 'pickup'),
          dropCoords: normalizePoint(drop, 'drop'),
          fare: Number(fare || 0),
          estimatedDistanceMeters: Number(estimatedDistanceMeters || 0),
          estimatedDurationMinutes: Number(estimatedDurationMinutes || 0),
          vehicleTypeId,
          vehicleIconType,
          paymentMethod,
          serviceType,
          intercity,
        });

        joinRideRoom(socket, ride._id);
        await startDispatchFlow(ride);

        socket.emit('rideCreated', {
          rideId: String(ride._id),
          room: getRideRoom(ride._id),
          status: ride.status,
        });

        socket.emit(SOCKET_EVENTS.RIDE_JOINED, {
          rideId: String(ride._id),
          room: getRideRoom(ride._id),
        });
      }),
    );

    socket.on(
      'acceptRide',
      onAsync(socket, async ({ rideId }) => {
        if (identity.role !== 'driver' || !rideId) {
          return;
        }

        // Shared with the REST fallback (POST /drivers/ride-offers/:rideId/accept).
        await acceptRideOffer({ rideId, driverId: identity.sub, socket });
      }),
    );

    socket.on(
      'submitRideBid',
      onAsync(socket, async ({ rideId, bidFare }) => {
        if (identity.role !== 'driver' || !rideId) {
          return;
        }

        const result = await submitRideBid({
          rideId,
          driverId: identity.sub,
          bidFare,
        });

        socket.emit('rideBidSubmitted', {
          rideId: String(rideId),
          bid: result.bid,
        });

        await notifyRideBidUpdated(result);
      }),
    );

    socket.on('rejectRide', ({ rideId }) => {
      if (identity.role !== 'driver' || !rideId) {
        return;
      }

      // Shared with the REST fallback (POST /drivers/ride-offers/:rideId/reject).
      rejectRideOffer({ rideId, driverId: identity.sub, socket }).catch((error) => {
        console.error('Failed to mark driver rejection from dispatch', error);
      });
    });

    socket.on('disconnect', async () => {
      if (identity.role === 'driver') {
        clearDriverRoute(identity.sub);
        const previousDriverState = driverLocationState.get(identity.sub);
        if (previousDriverState) {
          driverLocationState.set(identity.sub, {
            ...previousDriverState,
            socketId: null,
          });
        }
        await Driver.findByIdAndUpdate(identity.sub, { socketId: null });
      }
    });
  });

  return io;
};
