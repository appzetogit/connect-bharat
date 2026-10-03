import { PriceHike } from '../admin/models/PriceHike.js';
import { ServiceLocation } from '../admin/models/ServiceLocation.js';
import { Zone } from '../driver/models/Zone.js';
import { isHikeActiveAt } from './priceHikeService.js';
import { getTransportRideSettings } from './transportSettingsService.js';

/// The fare a rider is charged, worked out on the server.
///
/// Until this existed the apps priced the trip from the published Set Price
/// rows and the server booked whatever number they sent. That made every fare
/// rule an honour system: surge, a minimum fare and night charges could not be
/// enforced, because nothing on the server knew what the fare should be.
///
/// The arithmetic matches what the apps already do (`calculateEstimatedFare`
/// in the web client's SelectVehicle.jsx), so turning this on moves no fare by
/// itself: a trip inside the base distance pays the base price, and beyond it
/// pays base + extra km + minutes. The new terms - minimum fare, night charge
/// and surge - default to nothing, so an admin opts into each one.

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toNonNegative = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const toMinutesOfDay = (value) => {
  const [hour, minute] = String(value || '').split(':').map((part) => Number(part));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return (hour * 60) + minute;
};

/// Weekday and minute-of-day at `at`, on the clock of `timezone`.
export const clockInZone = (at = new Date(), timezone = DEFAULT_TIMEZONE) => {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || DEFAULT_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    // An admin typo in a city's timezone must not stop bookings.
    return clockInZone(at, DEFAULT_TIMEZONE);
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((part) => [part.type, part.value]),
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    day: weekdays[parts.weekday] ?? 0,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
};

/// Whether minute-of-day `minutes` falls in a start-end window, which may wrap
/// past midnight (22:00-06:00).
export const isWithinDailyWindow = (minutes, startTime, endTime) => {
  const start = toMinutesOfDay(startTime);
  const end = toMinutesOfDay(endTime);

  if (start === null || end === null || start === end) {
    return false;
  }

  return end < start
    ? minutes >= start || minutes < end
    : minutes >= start && minutes < end;
};

const resolveTariffMode = (pricingRule, serviceType) => {
  if (serviceType !== 'intercity') {
    return 'city';
  }

  // An outstation trip is priced on the outstation rates when the admin has set
  // them, and on the city rates otherwise - the same row, so a vehicle that was
  // never given outstation rates still gets a fare rather than zero.
  return toNonNegative(pricingRule?.outstation_price_per_distance) > 0
    || toNonNegative(pricingRule?.outstation_base_price) > 0
    ? 'outstation'
    : 'city';
};

/// Pure fare arithmetic over one Set Price row. Exported so it can be tested
/// without a database.
///
/// `surgeMultiplier` scales the money terms (base, distance, time), the way
/// priceHikeService always described it; thresholds and percentages are left
/// alone. The night charge is applied on the surged subtotal, the minimum fare
/// is a floor under the pre-tax figure, and tax goes on last.
export const computeFareBreakdown = ({
  pricingRule,
  distanceMeters = 0,
  durationMinutes = 0,
  serviceType = 'ride',
  surgeMultiplier = 1,
  isNight = false,
} = {}) => {
  if (!pricingRule) {
    return null;
  }

  const mode = resolveTariffMode(pricingRule, serviceType);
  const prefix = mode === 'outstation' ? 'outstation_' : '';
  const basePrice = toNonNegative(pricingRule[`${prefix}base_price`]);
  const baseDistanceKm = toNonNegative(pricingRule[`${prefix}base_distance`]);
  const pricePerKm = toNonNegative(pricingRule[`${prefix}price_per_distance`]);
  const pricePerMinute = toNonNegative(pricingRule[`${prefix}time_price`]);
  const serviceTaxPercent = toNonNegative(pricingRule.service_tax);
  const minimumFare = toNonNegative(pricingRule.minimum_fare);
  const multiplier = Number(surgeMultiplier) > 1 ? Number(surgeMultiplier) : 1;

  const distanceKm = Math.max(0, toNonNegative(distanceMeters) / 1000);
  const minutes = Math.max(0, toNonNegative(durationMinutes));
  const extraKm = Math.max(0, distanceKm - baseDistanceKm);
  // Inside the base distance the base price covers the trip outright, time
  // included - the apps have always quoted it this way.
  const withinBaseDistance = baseDistanceKm > 0 && distanceKm <= baseDistanceKm;

  const baseFare = basePrice;
  const distanceFare = withinBaseDistance ? 0 : extraKm * pricePerKm;
  const timeFare = withinBaseDistance ? 0 : minutes * pricePerMinute;
  const tripFare = baseFare + distanceFare + timeFare;
  const surgeAmount = tripFare * (multiplier - 1);
  const surgedFare = tripFare + surgeAmount;

  let nightCharge = 0;
  if (isNight) {
    const nightValue = toNonNegative(pricingRule.night_charge);
    nightCharge = String(pricingRule.night_charge_type || 'percentage').toLowerCase() === 'fixed'
      ? nightValue
      : (surgedFare * nightValue) / 100;
  }

  const beforeMinimum = surgedFare + nightCharge;
  const minimumFareAdjustment = minimumFare > beforeMinimum ? minimumFare - beforeMinimum : 0;
  const subtotal = beforeMinimum + minimumFareAdjustment;
  const tax = (subtotal * serviceTaxPercent) / 100;
  const total = subtotal + tax;

  return {
    tariff: mode,
    distanceKm: roundMoney(distanceKm),
    durationMinutes: Math.round(minutes),
    baseDistanceKm,
    pricePerKm,
    pricePerMinute,
    baseFare: roundMoney(baseFare),
    distanceFare: roundMoney(distanceFare),
    timeFare: roundMoney(timeFare),
    surgeMultiplier: multiplier,
    surgeAmount: roundMoney(surgeAmount),
    nightCharge: roundMoney(nightCharge),
    isNight: Boolean(isNight),
    minimumFare,
    minimumFareAdjustment: roundMoney(minimumFareAdjustment),
    subtotal: roundMoney(subtotal),
    serviceTaxPercent,
    tax: roundMoney(tax),
    // Whole rupees, because every bid step and every client display is in
    // whole rupees and the apps have always rounded the quote.
    total: Math.max(0, Math.round(total)),
  };
};

const isRoundTrip = (tripType) => /round/i.test(String(tripType || ''));

/// Fare for an intercity package trip: the package's price for this vehicle,
/// times the round-trip multiplier for a return journey. Mirrors the apps'
/// IntercityVehicle.jsx, so the number booked is the number the rider saw.
export const computePackageFare = ({ packageRow, vehicleTypeId, tripType, roundTripMultiplier = 1.8 } = {}) => {
  if (!packageRow || !vehicleTypeId) {
    return null;
  }

  const vehiclePrice = (packageRow.package_vehicle_prices || [])
    .find((row) => String(row?.vehicle_type || '') === String(vehicleTypeId));
  if (!vehiclePrice) {
    return null;
  }

  const oneWay = toNonNegative(vehiclePrice.base_price);
  const multiplier = isRoundTrip(tripType)
    ? (Number(roundTripMultiplier) > 0 ? Number(roundTripMultiplier) : 1.8)
    : 1;

  return {
    tariff: 'package',
    packageId: String(packageRow._id),
    tripType: isRoundTrip(tripType) ? 'round_trip' : 'one_way',
    baseFare: roundMoney(oneWay),
    roundTripMultiplier: multiplier,
    subtotal: roundMoney(oneWay * multiplier),
    tax: 0,
    total: Math.max(0, Math.round(oneWay * multiplier)),
  };
};

const isEnabledFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/// Surge multiplier in force for a booking right now, or 1.
///
/// Two sources, and the larger wins rather than compounding: the global
/// Price Hike windows, and the zone's own peak surge percentage. Both are
/// behind the `enable_surge_pricing` switch, because production already has
/// hike windows configured that were only ever displayed - turning them on
/// silently with this deploy would raise live fares.
export const resolveSurgeMultiplier = async ({ zone = null, at = new Date(), settings = null } = {}) => {
  const rideSettings = settings || await getTransportRideSettings();
  if (!isEnabledFlag(rideSettings?.enable_surge_pricing)) {
    return { multiplier: 1, source: 'disabled' };
  }

  const hikes = await PriceHike.find({ active: true })
    .select('days startTime endTime timezone multiplier')
    .lean();
  const hikeMultiplier = hikes
    .filter((hike) => isHikeActiveAt(hike, clockInZone(at, hike.timezone)))
    .map((hike) => Number(hike.multiplier) || 1)
    .reduce((highest, value) => Math.max(highest, value), 1);

  const zonePercent = toNonNegative(zone?.peak_zone_surge_percentage);
  const zoneMultiplier = 1 + (zonePercent / 100);

  if (hikeMultiplier <= 1 && zoneMultiplier <= 1) {
    return { multiplier: 1, source: 'none' };
  }

  return hikeMultiplier >= zoneMultiplier
    ? { multiplier: hikeMultiplier, source: 'price_hike' }
    : { multiplier: zoneMultiplier, source: 'zone_peak' };
};

const resolveTimezone = async ({ zone = null, serviceLocationId = null } = {}) => {
  const locationId = serviceLocationId || zone?.service_location_id || null;
  if (!locationId) {
    return DEFAULT_TIMEZONE;
  }
  const location = await ServiceLocation.findById(locationId).select('timezone').lean();
  return location?.timezone || DEFAULT_TIMEZONE;
};

export const isNightTimeFor = ({ pricingRule, at = new Date(), timezone = DEFAULT_TIMEZONE }) => {
  if (!(toNonNegative(pricingRule?.night_charge) > 0)) {
    return false;
  }
  const { minutes } = clockInZone(at, timezone);
  return isWithinDailyWindow(
    minutes,
    pricingRule.night_start_time || '22:00',
    pricingRule.night_end_time || '06:00',
  );
};

/// The full server-side quote for one vehicle: resolves surge and night time,
/// then prices. `at` is the pickup time, so a scheduled ride is priced for when
/// it runs rather than when it was booked.
export const quoteFareForPricingRule = async ({
  pricingRule,
  distanceMeters,
  durationMinutes,
  serviceType = 'ride',
  zone = null,
  zoneId = null,
  serviceLocationId = null,
  at = new Date(),
  settings = null,
}) => {
  if (!pricingRule) {
    return null;
  }

  const resolvedZone = zone || (zoneId ? await Zone.findById(zoneId).select('peak_zone_surge_percentage service_location_id').lean() : null);
  const [surge, timezone] = await Promise.all([
    resolveSurgeMultiplier({ zone: resolvedZone, at, settings }),
    resolveTimezone({ zone: resolvedZone, serviceLocationId }),
  ]);

  const breakdown = computeFareBreakdown({
    pricingRule,
    distanceMeters,
    durationMinutes,
    serviceType,
    surgeMultiplier: surge.multiplier,
    isNight: isNightTimeFor({ pricingRule, at, timezone }),
  });

  return breakdown ? { ...breakdown, surgeSource: surge.source, timezone } : null;
};
