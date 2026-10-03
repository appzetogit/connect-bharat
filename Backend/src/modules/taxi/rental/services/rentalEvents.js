import { emitToAdmins, emitToDriver, getSocketServer, getUserRoom } from '../../services/dispatchService.js';

/// Socket fan-out for rental changes. Best effort: a socket failure must never
/// fail the API call that caused it, so everything here swallows errors.

export const RENTAL_SOCKET_EVENTS = {
  bookingUpdated: 'rental:booking_updated',
  depositUpdated: 'rental:deposit_updated',
  extensionRequested: 'rental:extension_requested',
  extensionUpdated: 'rental:extension_updated',
  damageReported: 'rental:damage_reported',
  damageUpdated: 'rental:damage_report_updated',
  driverAssigned: 'rental:driver_assigned',
  invoiceReady: 'rental:invoice_ready',
};

const safe = (fn) => {
  try {
    fn();
  } catch (error) {
    console.warn('[rental-events] emit failed:', error?.message || error);
  }
};

export const emitRentalToUser = (userId, event, payload) =>
  safe(() => {
    const io = getSocketServer();
    const id = String(userId?._id || userId || '');
    if (io && id) io.to(getUserRoom(id)).emit(event, payload);
  });

export const emitRentalToDriver = (driverId, event, payload) =>
  safe(() => emitToDriver(String(driverId?._id || driverId || ''), event, payload));

export const emitRentalToAdmins = (event, payload) => safe(() => emitToAdmins(event, payload));
