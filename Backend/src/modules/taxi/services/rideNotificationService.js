import { sendPushNotificationToEntities } from './pushNotificationService.js';

/// Push notifications for each step of a trip.
///
/// These used to be socket-only, which meant they were visible while the app
/// was open and silently lost the moment it was backgrounded — a rider watching
/// for "your driver has arrived" saw nothing unless they happened to be staring
/// at the screen.
///
/// Kept in its own module because `rideService` cannot import `dispatchService`
/// (that one already imports `rideService`, and the cycle breaks at load time).
/// This file imports only the push helper, so it stays a leaf.

const rupees = (value) => `₹${Math.round(Number(value) || 0)}`;

const riderName = (ride) => ride?.userId?.name || 'your rider';
const driverName = (ride) => ride?.driverId?.name || 'Your driver';

/// Sent as ordinary notification pushes, not data-only.
///
/// Data-only is right for the driver's ride offer, where native code has to
/// draw the full-screen card. These are plain status updates with nothing to
/// render, so letting FCM put them straight in the tray is both simpler and
/// what actually shows up when the app is closed.
const RIDER_MESSAGES = {
  arriving: (ride) => ({
    title: 'Your driver has arrived',
    body: `${driverName(ride)} is waiting at ${ride.pickupAddress || 'the pickup point'}.`,
  }),
  started: (ride) => ({
    title: 'Trip started',
    body: `On the way to ${ride.dropAddress || 'your destination'}. Have a safe trip.`,
  }),
  completed: (ride) => ({
    title: 'Trip completed',
    body: `Fare ${rupees(ride.fare)}. Thanks for riding with Connect Bharat.`,
  }),
};

const DRIVER_MESSAGES = {
  started: (ride) => ({
    title: 'Trip started',
    body: `Heading to ${ride.dropAddress || 'the drop location'} with ${riderName(ride)}.`,
  }),
  completed: (ride) => ({
    title: 'Trip completed',
    body: `${rupees(ride.fare)} collected from ${riderName(ride)}.`,
  }),
};

/// Notifies both sides that a trip moved on.
///
/// `accepted` is deliberately absent: `notifyRideAccepted` already pushes that
/// one from the accept path, and sending it here too would show the rider two
/// notifications for the same event.
///
/// Best-effort throughout — a failed notification must never roll back a trip
/// transition that already happened.
export const notifyRideLifecycle = async (ride, liveStatus) => {
  if (!ride || !liveStatus) return;

  const userId = String(ride.userId?._id || ride.userId || '');
  const driverId = String(ride.driverId?._id || ride.driverId || '');
  const data = {
    type: `ride_${liveStatus}`,
    rideId: String(ride._id),
    status: ride.status || '',
    liveStatus,
  };

  const riderMessage = RIDER_MESSAGES[liveStatus]?.(ride);
  const driverMessage = DRIVER_MESSAGES[liveStatus]?.(ride);

  const sends = [];

  if (riderMessage && userId) {
    sends.push(
      sendPushNotificationToEntities({
        userIds: [userId],
        title: riderMessage.title,
        body: riderMessage.body,
        data,
      }),
    );
  }

  if (driverMessage && driverId) {
    sends.push(
      sendPushNotificationToEntities({
        driverIds: [driverId],
        title: driverMessage.title,
        body: driverMessage.body,
        data,
      }),
    );
  }

  if (!sends.length) return;

  await Promise.all(sends).catch((error) => {
    console.error(`Failed to send ride ${liveStatus} notification`, error);
  });
};

/// Tells the driver their rider cancelled.
///
/// The driver may be parked with the app closed, waiting at the pickup point,
/// with no reason to look at their phone — the socket event alone left them
/// waiting for someone who was never coming.
export const notifyRideCancelledByUser = async (ride, reasonTitle = '') => {
  const driverId = String(ride?.driverId?._id || ride?.driverId || '');
  if (!driverId) return;

  await sendPushNotificationToEntities({
    driverIds: [driverId],
    title: 'Ride cancelled',
    body: reasonTitle
      ? `${riderName(ride)} cancelled: ${reasonTitle}`
      : `${riderName(ride)} cancelled this ride.`,
    data: {
      type: 'ride_cancelled_by_user',
      rideId: String(ride._id),
      reason: reasonTitle,
    },
  }).catch((error) => {
    console.error('Failed to send ride-cancelled-by-user notification', error);
  });
};
