import { DriverLocationHistory } from '../driver/models/DriverLocationHistory.js';
import { countCalendarDays, gpsTrailDistanceKm, resolveActualDistance } from '../outstation/services/outstationFare.js';

/// Actual km of a trip, for every service (docs/plans/corporate-v2.md §1.4).
///
/// The odometer delta wins (what the meter says), then the driver's GPS trail
/// (DriverLocationHistory between start and completion), then the routed
/// estimate. The arithmetic is the outstation module's (outstationFare.js);
/// the GPS loading moved here from outstationHooks so both use one copy.
///
/// Imports no ride service, so rideService and outstationHooks can both use it.

/// Km on the driver's GPS trail between the ride's start and completion.
export const loadRideGpsKm = async (ride) => {
  if (!ride?.driverId || !ride?.startedAt) return 0;
  const rows = await DriverLocationHistory.find({
    driverId: ride.driverId,
    createdAt: { $gte: ride.startedAt, $lte: ride.completedAt || new Date() },
  })
    .sort({ createdAt: 1 })
    .select('location createdAt')
    .limit(20000)
    .lean();
  return gpsTrailDistanceKm(rows.map((row) => ({ coordinates: row.location?.coordinates, at: row.createdAt })));
};

const isRoundTripOutstation = (ride) =>
  ride?.serviceType === 'intercity' && ['round_trip', 'multi_day'].includes(ride?.intercity?.tripType);

/// Sets `actualDistanceMeters` / `actualDistanceSource` on a ride document at
/// completion (not saved here). Reuses the outstation final-fare result when
/// that already worked the distance out. Never throws.
export const applyRideActualDistance = async (ride) => {
  if (!ride) return;
  try {
    let km;
    let source;
    if (ride.fareAdjustment?.computedAt && ride.fareAdjustment?.distanceSource) {
      km = Number(ride.fareAdjustment.actualKm) || 0;
      source = ride.fareAdjustment.distanceSource;
    } else {
      const estimatedKm = ((Number(ride.estimatedDistanceMeters) || 0) / 1000) * (isRoundTripOutstation(ride) ? 2 : 1);
      const gpsKm = await loadRideGpsKm(ride).catch(() => 0);
      const days = countCalendarDays(ride.startedAt || ride.acceptedAt || ride.createdAt || new Date(), ride.completedAt || new Date());
      ({ km, source } = resolveActualDistance({ odometer: ride.odometer || {}, gpsKm, estimatedKm, days }));
    }
    ride.actualDistanceMeters = Math.max(0, Math.round(km * 1000));
    ride.actualDistanceSource = ['odometer', 'gps', 'estimate'].includes(source) ? source : 'estimate';
  } catch (error) {
    console.warn('[actual-distance] failed for ride', String(ride?._id), error?.message);
  }
};
