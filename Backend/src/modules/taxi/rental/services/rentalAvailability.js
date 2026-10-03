import { RENTAL_HOLDING_STATUSES } from './rentalBilling.js';

/// Pure inventory math for rentals. The Mongo-facing wrapper lives in
/// rentalInventoryService.js; this file is what the tests exercise.
///
/// A vehicle type is a catalogue entry ("Swift, manual"), a unit is one car
/// with a number plate. Capacity for a window is the number of usable units
/// minus the most bookings that are ever out at the same moment inside that
/// window - not minus every booking that touches the window, because two
/// back-to-back bookings can share one car.

/// Units that can be handed out. `booked` is a live label (the car is out
/// right now) and still counts as fleet: whether it is free for a future
/// window is decided by the booking calendar, not by that label.
export const RENTAL_UNUSABLE_UNIT_STATUSES = ['maintenance', 'inactive'];

const toTime = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
};

export const rangesOverlap = (aStart, aEnd, bStart, bEnd) => {
  const as = toTime(aStart);
  const ae = toTime(aEnd);
  const bs = toTime(bStart);
  const be = toTime(bEnd);
  if (![as, ae, bs, be].every(Number.isFinite)) return false;
  return as < be && bs < ae;
};

/// The time a booking actually holds a car.
///
/// A car that is out (`assigned`/`end_requested`) past its return time has not
/// come back, so it keeps holding until now.
export const effectiveBookingWindow = (booking = {}, now = Date.now()) => {
  const start = toTime(booking.pickupDateTime);
  let end = toTime(booking.returnDateTime);
  const nowMs = toTime(now);
  if (['assigned', 'end_requested'].includes(String(booking.status || '')) && Number.isFinite(nowMs) && end < nowMs) {
    end = nowMs;
  }
  return { start, end };
};

export const isHoldingBooking = (booking = {}) => RENTAL_HOLDING_STATUSES.includes(String(booking.status || ''));

/// Bookings that hold a car at some point inside [from, to).
export const findOverlappingBookings = (bookings = [], from, to, { now = Date.now(), excludeBookingId = null } = {}) => {
  const excluded = excludeBookingId ? String(excludeBookingId) : '';
  return (Array.isArray(bookings) ? bookings : []).filter((booking) => {
    if (!isHoldingBooking(booking)) return false;
    if (excluded && String(booking._id || booking.id || '') === excluded) return false;
    const { start, end } = effectiveBookingWindow(booking, now);
    return rangesOverlap(start, end, from, to);
  });
};

/// Largest number of the given bookings that hold a car at the same instant
/// within [from, to). Sweep line over the clipped intervals; an interval
/// ending at t and one starting at t do not overlap.
export const maxConcurrentBookings = (bookings = [], from, to, { now = Date.now() } = {}) => {
  const fromMs = toTime(from);
  const toMs = toTime(to);
  const events = [];

  for (const booking of bookings) {
    const { start, end } = effectiveBookingWindow(booking, now);
    const clippedStart = Math.max(start, fromMs);
    const clippedEnd = Math.min(end, toMs);
    if (Number.isFinite(clippedStart) && Number.isFinite(clippedEnd) && clippedStart < clippedEnd) {
      events.push([clippedStart, 1], [clippedEnd, -1]);
    }
  }

  // Ends before starts at the same instant.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
};

/// How many cars of a type are free for [from, to).
export const computeAvailability = ({
  units = [],
  bookings = [],
  from,
  to,
  now = Date.now(),
  excludeBookingId = null,
} = {}) => {
  const allUnits = Array.isArray(units) ? units : [];
  const usableUnits = allUnits.filter((unit) => !RENTAL_UNUSABLE_UNIT_STATUSES.includes(String(unit?.status || 'available')));
  const overlapping = findOverlappingBookings(bookings, from, to, { now, excludeBookingId });
  const peakConcurrent = maxConcurrentBookings(overlapping, from, to, { now });
  const busyUnitIds = new Set(
    overlapping.map((booking) => String(booking.assignedUnitId || '')).filter(Boolean),
  );
  const freeUnits = usableUnits.filter((unit) => !busyUnitIds.has(String(unit._id || unit.id || '')));
  const available = Math.max(0, usableUnits.length - peakConcurrent);

  return {
    totalUnits: allUnits.length,
    usableUnits: usableUnits.length,
    overlappingBookings: overlapping.length,
    peakConcurrent,
    available,
    isAvailable: available > 0,
    freeUnitIds: available > 0 ? freeUnits.map((unit) => String(unit._id || unit.id)) : [],
  };
};

/// Bookings already holding one specific unit inside [from, to).
export const findUnitConflicts = (unitId, bookings = [], from, to, { now = Date.now(), excludeBookingId = null } = {}) => {
  const id = String(unitId || '');
  if (!id) return [];
  return findOverlappingBookings(
    (Array.isArray(bookings) ? bookings : []).filter((booking) => String(booking.assignedUnitId || '') === id),
    from,
    to,
    { now, excludeBookingId },
  );
};
