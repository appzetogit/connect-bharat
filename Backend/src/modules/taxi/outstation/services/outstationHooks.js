import { ApiError } from '../../../../utils/ApiError.js';
import { getOrLoadCachedValue } from '../../../../utils/cache.js';
import { RIDE_LIVE_STATUS } from '../../constants/index.js';
import { createDefaultBusinessSettings } from '../../admin/data/defaultBusinessSettings.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { DriverLocationHistory } from '../../driver/models/DriverLocationHistory.js';
import { quoteFareForPricingRule } from '../../services/fareEngineService.js';
import { getTransportRideSettings } from '../../services/transportSettingsService.js';
import {
  composeOutstationFare,
  computeAdvanceAmount,
  computeOutstationFinalFare,
  countCalendarDays,
  extractOutstationRates,
  gpsTrailDistanceKm,
  normalizeOutstationTripFields,
  planOutstationTrip,
  resolveActualDistance,
  roundMoney,
} from './outstationFare.js';

/// The outstation module's hooks into the shared ride flow.
///
/// services/rideService.js calls each of these with a single line, so the
/// outstation rules can change here without touching that file. Nothing in
/// this file imports rideService, dispatchService or a controller: rideService
/// imports this, so any of those would be an import cycle.
///
/// Every hook is a no-op for a ride that is not `serviceType: 'intercity'`.

/// Defaults for settings this module reads. They are also in
/// admin/data/defaultBusinessSettings.js; repeating them here means a
/// settings document (or a defaults file) without the keys still behaves.
export const OUTSTATION_SETTING_DEFAULTS = Object.freeze({
  outstation_advance_timeout_minutes: '15',
  enable_outstation_final_fare_adjustment: '0',
  outstation_advance_refund_to_wallet: '1',
  require_outstation_odometer: '0',
});

const isEnabledFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

const isIntercity = (ride) => String(ride?.serviceType || '').toLowerCase() === 'intercity';

const toHttpError = (error) => (
  error?.statusCode && !(error instanceof ApiError) ? new ApiError(error.statusCode, error.message) : error
);

const defaultCustomization = createDefaultBusinessSettings().customization || {};

const getCustomizationSettings = async () => getOrLoadCachedValue(
  'cache:settings:customization:outstation',
  {
    ttlMs: 30_000,
    load: async () => {
      const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('customization').lean();
      return { ...defaultCustomization, ...(doc?.customization || {}) };
    },
  },
);

/// The outstation settings in one object: transport_ride keys plus the one
/// customization switch, each falling back to OUTSTATION_SETTING_DEFAULTS.
export const getOutstationSettings = async () => {
  const [transport, customization] = await Promise.all([
    getTransportRideSettings(),
    getCustomizationSettings().catch(() => defaultCustomization),
  ]);
  const pick = (source, key) => (
    source?.[key] === undefined || source?.[key] === null || source?.[key] === ''
      ? OUTSTATION_SETTING_DEFAULTS[key]
      : source[key]
  );
  const timeout = Number(pick(transport, 'outstation_advance_timeout_minutes'));
  return {
    advanceTimeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? timeout : 15,
    finalFareAdjustmentEnabled: isEnabledFlag(pick(transport, 'enable_outstation_final_fare_adjustment')),
    refundAdvanceToWallet: isEnabledFlag(pick(transport, 'outstation_advance_refund_to_wallet')),
    requireOdometer: isEnabledFlag(pick(customization, 'require_outstation_odometer')),
  };
};

/// Trip-type fields, validated, as an ApiError on bad input.
export const normalizeOutstationIntercity = (intercity = {}, options = {}) => {
  try {
    return normalizeOutstationTripFields(intercity || {}, options);
  } catch (error) {
    throw toHttpError(error);
  }
};

/// Server quote for an off-package outstation trip, or null to fall through
/// to the plain fare engine.
///
/// Hooked into rideService.resolveBookingFare once it has established that
/// the vehicle has outstation rates. Surge and night are resolved by
/// quoteFareForPricingRule exactly as for a city ride; this only decides the
/// distance it is asked to price (out and back, floored at the per-day
/// minimum) and adds the allowances.
export const quoteOutstationFare = async ({
  pricingRule,
  distanceMeters,
  durationMinutes,
  intercity = null,
  zone = null,
  zoneId = null,
  serviceLocationId = null,
  at = new Date(),
  settings = null,
}) => {
  if (!pricingRule) return null;
  const trip = normalizeOutstationIntercity(intercity || {}, { scheduledAt: at });
  const rates = extractOutstationRates(pricingRule);
  const plan = planOutstationTrip({
    rates,
    tripType: trip.tripType || 'one_way',
    days: trip.days,
    oneWayDistanceMeters: distanceMeters,
    oneWayDurationMinutes: durationMinutes,
  });
  const tripBreakdown = await quoteFareForPricingRule({
    pricingRule,
    distanceMeters: plan.billableKm * 1000,
    durationMinutes: plan.tripMinutes,
    serviceType: 'intercity',
    zone,
    zoneId,
    serviceLocationId,
    at,
    settings,
  });
  return composeOutstationFare({ plan, tripBreakdown, rates });
};

/// Extra fields for Ride.create on an intercity booking: the validated trip
/// type, dates and locked allowances inside `intercity`, and the advance.
///
/// `intercity` is rideService's normalized sub-document; `rawIntercity` is
/// what the app sent (for returnAt/days, which that normalizer drops). Spread
/// after `intercity:` in the create call, so the returned `intercity` wins.
/// Returns {} for every other service.
export const buildOutstationBookingFields = async ({
  serviceType,
  intercity = {},
  rawIntercity = {},
  fare = 0,
  pricingRule = null,
  fareBreakdown = null,
  scheduledAt = null,
  subscriptionCovered = false,
}) => {
  if (String(serviceType || '').toLowerCase() !== 'intercity') return {};

  const trip = normalizeOutstationIntercity(rawIntercity || {}, { scheduledAt });
  const outstationQuote = fareBreakdown?.tariff === 'outstation' ? fareBreakdown : null;
  const fields = {
    intercity: {
      ...intercity,
      tripType: trip.tripType || 'one_way',
      tripTypeLabel: trip.tripTypeLabel || 'One Way',
      startAt: trip.startAt,
      returnAt: trip.returnAt,
      days: outstationQuote?.days || trip.days,
      driverAllowancePerDay: outstationQuote?.driverAllowancePerDay
        ?? roundMoney(Number(pricingRule?.outstation_driver_allowance_per_day) || 0),
      nightAllowancePerNight: outstationQuote?.nightAllowancePerNight
        ?? roundMoney(Number(pricingRule?.outstation_night_allowance_per_night) || 0),
    },
  };

  const advanceType = String(pricingRule?.outstation_advance_type || 'none').toLowerCase();
  const advanceValue = Math.max(0, Number(pricingRule?.outstation_advance_value) || 0);
  const amount = computeAdvanceAmount({ type: advanceType, value: advanceValue, fare });

  // A ride a rider's subscription already pays for owes nothing up front.
  if (amount > 0 && !subscriptionCovered) {
    const { advanceTimeoutMinutes } = await getOutstationSettings();
    fields.advance = {
      required: true,
      amount,
      type: advanceType,
      value: advanceValue,
      status: 'pending',
      expiresAt: new Date(Date.now() + advanceTimeoutMinutes * 60 * 1000),
    };
  }

  return fields;
};

/// With `customization.require_outstation_odometer` on, an intercity trip
/// cannot start without the start reading, nor complete without the end
/// reading. Mirrors assertParcelProof in rideService.
export const assertOutstationOdometer = async (ride, nextStatus) => {
  if (!isIntercity(ride)) return;
  if (nextStatus !== RIDE_LIVE_STATUS.STARTED && nextStatus !== RIDE_LIVE_STATUS.COMPLETED) return;

  const { requireOdometer } = await getOutstationSettings();
  if (!requireOdometer) return;

  const odometer = ride?.odometer || {};
  const hasStart = odometer.startReading !== null && odometer.startReading !== undefined;
  const hasEnd = odometer.endReading !== null && odometer.endReading !== undefined;

  if (!hasStart) {
    throw new ApiError(400, 'Record the odometer start reading before starting the trip');
  }
  if (nextStatus === RIDE_LIVE_STATUS.COMPLETED && !hasEnd) {
    throw new ApiError(400, 'Record the odometer end reading before completing the trip');
  }
};

const loadGpsKm = async (ride) => {
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

const isDriverCollectionPaid = (ride) => (
  Boolean(ride?.driverPaymentCollection?.paidAt)
  || ['paid', 'captured', 'completed'].includes(String(ride?.driverPaymentCollection?.status || '').toLowerCase())
);

/// Works out the final fare of an intercity trip at completion and, when
/// `transport_ride.enable_outstation_final_fare_adjustment` is on, charges it.
///
/// Called from updateRideLifecycle next to applyParcelWaitingCharge, after
/// completedAt is stamped and before the ride is saved, because the wallet
/// settlement that follows reads ride.fare.
///
/// With the setting off the result is still stored on ride.fareAdjustment
/// with `applied: false`, so ops can see what the rule would have charged
/// before switching it on. Never throws: a failure here must not stop a
/// driver completing the trip.
export const applyOutstationFinalFare = async (ride) => {
  if (!isIntercity(ride)) return;
  if (ride.fareAdjustment?.computedAt) return; // already worked out

  try {
    const { finalFareAdjustmentEnabled } = await getOutstationSettings();
    const booked = ride.pricingSnapshot?.fare_breakdown || null;
    const days = countCalendarDays(ride.startedAt || ride.acceptedAt || ride.createdAt, ride.completedAt || new Date());
    const estimatedKm = Number(booked?.tripKm)
      || ((Number(ride.estimatedDistanceMeters) || 0) / 1000) * (['round_trip', 'multi_day'].includes(ride.intercity?.tripType) ? 2 : 1);

    const gpsKm = await loadGpsKm(ride).catch(() => 0);
    const distance = resolveActualDistance({ odometer: ride.odometer || {}, gpsKm, estimatedKm, days });

    const durationMinutes = ride.startedAt
      ? Math.max(0, ((ride.completedAt || new Date()).getTime() - new Date(ride.startedAt).getTime()) / 60000)
      : 0;
    const waitingMinutes = ride.arrivedAt && ride.startedAt
      ? Math.max(0, (new Date(ride.startedAt).getTime() - new Date(ride.arrivedAt).getTime()) / 60000)
      : 0;

    const result = computeOutstationFinalFare({
      bookedFare: Number(ride.fare) || 0,
      booked,
      actual: {
        distanceKm: distance.km,
        distanceSource: distance.source,
        durationMinutes,
        waitingMinutes,
        days,
      },
      waiting: {
        perMinute: Number(ride.pricingSnapshot?.waiting_charge) || 0,
        freeMinutes: Number(ride.pricingSnapshot?.free_waiting_before) || 0,
      },
      expenses: (ride.intercity?.tollsAndPermits || []).map((item) => ({ type: item.type, amount: item.amount })),
    });

    // A ride already paid for in full (a rider subscription) cannot be billed
    // more at completion, so it is only ever a dry run.
    const alreadyPaid = isDriverCollectionPaid(ride);
    const apply = finalFareAdjustmentEnabled && !alreadyPaid;

    ride.fareAdjustment = {
      ...result,
      reason: alreadyPaid && finalFareAdjustmentEnabled
        ? `${result.reason}; not applied because the fare was prepaid`
        : result.reason,
      computedAt: new Date(),
      applied: apply,
      bookedBreakdown: booked,
    };

    if (apply) {
      ride.waitingMinutes = result.waitingMinutes;
      ride.waitingCharge = result.waitingCharge;
      ride.fare = result.finalFare;
    }
  } catch (error) {
    console.error('[outstation] final fare adjustment failed for ride', String(ride?._id), error?.message);
  }
};

/// Outstation fields for the realtime ride payload. Spread into
/// serializeRideRealtime; {} for other services so their payload is unchanged.
export const serializeOutstationRealtime = (ride) => {
  if (!isIntercity(ride)) return {};
  const advance = ride.advance || {};
  const adjustment = ride.fareAdjustment || {};
  const advancePaid = advance.status === 'paid' ? Number(advance.amount) || 0 : 0;
  return {
    advance: {
      required: Boolean(advance.required),
      amount: Number(advance.amount) || 0,
      status: advance.status || 'none',
      provider: advance.provider || '',
      paidAt: advance.paidAt || null,
      expiresAt: advance.expiresAt || null,
    },
    odometer: ride.odometer
      ? {
          startReading: ride.odometer.startReading ?? null,
          startPhoto: ride.odometer.startPhoto || '',
          startAt: ride.odometer.startAt || null,
          endReading: ride.odometer.endReading ?? null,
          endPhoto: ride.odometer.endPhoto || '',
          endAt: ride.odometer.endAt || null,
        }
      : null,
    fareAdjustment: adjustment.computedAt
      ? {
          applied: Boolean(adjustment.applied),
          bookedFare: adjustment.bookedFare,
          finalFare: adjustment.finalFare,
          extraKm: adjustment.extraKm,
          extraKmCharge: adjustment.extraKmCharge,
          extraTimeCharge: adjustment.extraTimeCharge,
          waitingCharge: adjustment.waitingCharge,
          tollsTotal: adjustment.tollsTotal,
          stateTaxes: adjustment.stateTaxes,
          allowances: adjustment.allowances,
          reason: adjustment.reason,
        }
      : null,
    amountDue: Math.max(0, roundMoney((Number(ride.fare) || 0) - advancePaid)),
  };
};
