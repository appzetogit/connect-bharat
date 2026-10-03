import {
  emitToDriver,
  getDriverRoom,
  getSocketServer,
  markDriverRejectedFromDispatch,
  notifyRideAccepted,
} from '../../services/dispatchService.js';
import { acceptRideAssignment, getRideRoom } from '../../services/rideService.js';
import { SOCKET_EVENTS } from '../../socket/events.js';

/**
 * Accepting and rejecting a ride offer, shared by the socket handlers
 * (`acceptRide` / `rejectRide` in socket/index.js) and the REST fallback
 * (`POST /drivers/ride-offers/:rideId/accept|reject`).
 *
 * One implementation so the two paths can't drift: a driver on a flaky
 * connection who accepts over REST must leave the ride, the rider and the
 * other notified drivers in exactly the state a socket accept would.
 *
 * With a `socket`, room joins and the driver-facing emits go to that socket
 * (the old behaviour). Without one, they go to every socket the driver has
 * open, via the `driver:<id>` room, so a driver app that reconnects its socket
 * after the REST call is already in the ride room.
 */

export const acceptRideOffer = async ({ rideId, driverId, socket = null }) => {
  // First successful claim wins; later accepts are rejected by the service layer.
  const ride = await acceptRideAssignment({ rideId, driverId });
  const room = getRideRoom(ride._id);

  if (socket) {
    socket.join(room);
  } else {
    getSocketServer()?.in(getDriverRoom(driverId)).socketsJoin(room);
  }

  await notifyRideAccepted(ride);

  const acceptedPayload = {
    rideId: String(ride._id),
    room,
    status: ride.status,
    liveStatus: ride.liveStatus,
    acceptedAt: ride.acceptedAt,
  };
  const joinedPayload = { rideId: String(ride._id), room };

  const emit = socket
    ? (event, payload) => socket.emit(event, payload)
    : (event, payload) => emitToDriver(driverId, event, payload);

  emit('rideAccepted', acceptedPayload);
  emit(SOCKET_EVENTS.RIDE_STATE, acceptedPayload);
  emit(SOCKET_EVENTS.RIDE_JOINED, joinedPayload);

  return { ride, acceptedPayload };
};

export const rejectRideOffer = async ({ rideId, driverId, socket = null }) => {
  // Recorded and broadcast together, as the socket handler always did: the
  // broadcast must not wait on the dispatch-state write.
  const recorded = markDriverRejectedFromDispatch(rideId, driverId);

  const payload = { rideId: String(rideId), driverId: String(driverId) };
  if (socket) {
    socket.to(getRideRoom(rideId)).emit('driverRejectedRide', payload);
  } else {
    getSocketServer()?.to(getRideRoom(rideId)).emit('driverRejectedRide', payload);
  }

  await recorded;
  return payload;
};
