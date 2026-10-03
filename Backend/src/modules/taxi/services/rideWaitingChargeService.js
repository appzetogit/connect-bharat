import { getTransportRideSettings } from './transportSettingsService.js';

/// Waiting charge for taxi and outstation rides.
///
/// Parcels have billed the minutes a driver waits at pickup for a long time
/// (`applyParcelWaitingCharge` in rideService). Rides carried the same terms on
/// their Set Price row - `waiting_charge` per minute after `free_waiting_before`
/// free minutes - and both are copied onto `ride.pricingSnapshot` at booking,
/// but nothing ever charged them. This charges them, behind
/// `transport_ride.enable_ride_waiting_charge` (default '0'), so no live fare
/// moves until an admin opts in.

/// Same bound as parcels: a driver who marks "arrived" and forgets to start
/// the trip must not bill the rider for the rest of the day.
export const RIDE_WAITING_CHARGE_CAP_MINUTES = 60;

const RIDE_SERVICE_TYPES = new Set(['ride', 'intercity']);

const isEnabledFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/// Pure arithmetic, exported for tests. Whole minutes waited past the free
/// allowance, capped, times the per-minute rate. Returns null when nothing is
/// owed so callers can leave the ride untouched.
export const computeWaitingCharge = ({
  arrivedAt,
  startedAt,
  perMinute = 0,
  freeMinutes = 0,
  capMinutes = RIDE_WAITING_CHARGE_CAP_MINUTES,
} = {}) => {
  if (!arrivedAt || !startedAt) return null;
  const elapsedMs = new Date(startedAt).getTime() - new Date(arrivedAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;

  const rate = Math.max(0, Number(perMinute) || 0);
  if (rate <= 0) return null;

  const free = Math.max(0, Number(freeMinutes) || 0);
  const waitedMinutes = Math.floor(elapsedMs / 60000);
  const chargeableMinutes = Math.min(Math.max(0, waitedMinutes - free), capMinutes);
  if (chargeableMinutes <= 0) return null;

  return {
    waitedMinutes,
    freeMinutes: free,
    perMinute: rate,
    chargeableMinutes,
    charge: Math.round(chargeableMinutes * rate * 100) / 100,
  };
};

/// Copies the waiting charge onto the stored fare breakdown, so the invoice
/// and admin views show the same line the rider paid. Only when a breakdown
/// exists - a client-priced ride has none and gets no partial one.
export const recordWaitingChargeInBreakdown = (ride, { chargeableMinutes, charge }) => {
  const breakdown = ride?.pricingSnapshot?.fare_breakdown;
  if (!breakdown || typeof breakdown !== 'object') return;

  ride.pricingSnapshot.fare_breakdown = {
    ...breakdown,
    waitingMinutes: chargeableMinutes,
    waitingCharge: charge,
    totalWithWaiting: Math.round((Number(breakdown.total || 0) + charge) * 100) / 100,
  };
  // fare_breakdown is Mixed: Mongoose does not see a nested reassignment
  // without this.
  if (typeof ride.markModified === 'function') {
    ride.markModified('pricingSnapshot.fare_breakdown');
  }
};

/// Applies the waiting charge to a taxi or outstation ride at completion,
/// before it is saved and settled. A no-op for parcels (they have their own
/// path), when the setting is off, when already applied, and for rides a
/// subscription covers - the subscription paid a fixed amount up front and a
/// charge added here would land on the driver's settlement unpaid.
export const applyRideWaitingCharge = async (ride, { settings = null } = {}) => {
  if (!ride || !RIDE_SERVICE_TYPES.has(ride.serviceType || 'ride')) return null;
  if (Number(ride.waitingCharge) > 0) return null;
  if (ride.subscriptionUsage?.covered) return null;

  const rideSettings = settings || await getTransportRideSettings();
  if (!isEnabledFlag(rideSettings?.enable_ride_waiting_charge)) return null;

  const result = computeWaitingCharge({
    arrivedAt: ride.arrivedAt,
    startedAt: ride.startedAt,
    perMinute: ride.pricingSnapshot?.waiting_charge,
    freeMinutes: ride.pricingSnapshot?.free_waiting_before,
  });
  if (!result) return null;

  ride.waitingMinutes = result.chargeableMinutes;
  ride.waitingCharge = result.charge;
  // Added before the ride is saved, because the wallet settlement that follows
  // completion reads ride.fare.
  ride.fare = Math.round((Number(ride.fare || 0) + result.charge) * 100) / 100;
  recordWaitingChargeInBreakdown(ride, result);

  return result;
};
