import { computeFareBreakdown } from '../../services/fareEngineService.js';

/// Outstation pricing arithmetic. Pure: no database, no settings, so every
/// money rule here is covered by test/outstation.test.js.
///
/// How an outstation trip is billed (the Indian intercity-cab convention the
/// SOW describes):
///
/// - One way: the routed distance, priced on the Set Price row's outstation
///   rates through the same fare engine city rides use (base, per-km,
///   per-minute, minimum fare, night charge, surge, tax).
/// - Round trip and multi-day: out and back, so twice the routed distance -
///   but never less than `outstation_min_km_per_day` x days, because a car
///   and driver held for a day earn nothing while parked.
/// - Driver allowance per day and night allowance per night are added on top.
///   They are the driver's food and stay, paid through, so they are not taxed
///   or surged.
///
/// Every new rate defaults to 0 on the Set Price row, which makes each rule
/// a no-op until an admin sets it: a one-way trip with no allowances prices
/// exactly as fareEngineService already did.

export const OUTSTATION_TRIP_TYPES = Object.freeze(['one_way', 'round_trip', 'multi_day']);

const TRIP_TYPE_LABELS = Object.freeze({
  one_way: 'One Way',
  round_trip: 'Round Trip',
  multi_day: 'Multi Day',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toNonNegative = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

/// The trip-type code for whatever the app sent, or null when it is not one
/// we know. The web client sends 'One Way' / 'Round Trip'; the Flutter apps
/// are being moved to the codes. An empty value is a one-way trip, which is
/// what every outstation booking was before trip types existed.
export const normalizeTripType = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'one_way';
  if (OUTSTATION_TRIP_TYPES.includes(raw)) return raw;

  const compact = raw.replace(/[\s_-]+/g, '');
  if (/multi/.test(compact)) return 'multi_day';
  if (/round|return|twoway/.test(compact)) return 'round_trip';
  if (/oneway|single|drop|one/.test(compact)) return 'one_way';
  return null;
};

export const tripTypeLabel = (tripType) => TRIP_TYPE_LABELS[tripType] || '';

const isReturnTrip = (tripType) => tripType === 'round_trip' || tripType === 'multi_day';

const parseDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

/// YYYY-MM-DD of `date` on the given clock. Days are counted on the city's
/// calendar, so a trip leaving at 11pm and returning at 1am is two days.
const calendarDay = (date, timezone = DEFAULT_TIMEZONE) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || DEFAULT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE }).format(date);
  }
};

/// Calendar days from `startAt` to `endAt` inclusive (same day = 1).
export const countCalendarDays = (startAt, endAt, timezone = DEFAULT_TIMEZONE) => {
  const start = parseDate(startAt);
  const end = parseDate(endAt);
  if (!start || !end || end.getTime() < start.getTime()) return 1;
  const startDay = Date.parse(`${calendarDay(start, timezone)}T00:00:00Z`);
  const endDay = Date.parse(`${calendarDay(end, timezone)}T00:00:00Z`);
  return Math.max(1, Math.round((endDay - startDay) / DAY_MS) + 1);
};

/// The trip-type fields of an intercity booking, validated.
///
/// Throws a plain Error with `statusCode: 400` (callers wrap it into an
/// ApiError) so this file stays free of HTTP concerns.
export const normalizeOutstationTripFields = (intercity = {}, { scheduledAt = null } = {}) => {
  const tripType = normalizeTripType(intercity?.tripType);
  if (!tripType) {
    const error = new Error('intercity.tripType must be one_way, round_trip or multi_day');
    error.statusCode = 400;
    throw error;
  }

  const startAt = parseDate(intercity?.startAt)
    || parseDate(scheduledAt)
    || parseDate(intercity?.travelDate || intercity?.date);
  const returnAt = isReturnTrip(tripType) ? parseDate(intercity?.returnAt || intercity?.returnDate) : null;

  if (startAt && returnAt && returnAt.getTime() < startAt.getTime()) {
    const error = new Error('intercity.returnAt must be after the start of the trip');
    error.statusCode = 400;
    throw error;
  }

  const requestedDays = Math.floor(Number(intercity?.days));
  let days = 1;
  if (isReturnTrip(tripType)) {
    if (Number.isFinite(requestedDays) && requestedDays >= 1) {
      days = requestedDays;
    } else if (startAt && returnAt) {
      days = countCalendarDays(startAt, returnAt);
    }
  }

  if (tripType === 'multi_day' && days < 2) {
    const error = new Error('A multi_day trip needs intercity.days of 2 or more, or a returnAt on a later day');
    error.statusCode = 400;
    throw error;
  }

  return {
    // Kept blank when the app sent nothing, so a non-intercity ride's empty
    // intercity sub-document stays empty.
    tripType: String(intercity?.tripType ?? '').trim() ? tripType : '',
    tripTypeLabel: String(intercity?.tripType ?? '').trim() ? tripTypeLabel(tripType) : '',
    startAt,
    returnAt,
    days: Math.min(days, 60),
  };
};

/// The outstation rates of one Set Price row, in the shape the arithmetic
/// below reads. Also what is locked onto the booked quote.
export const extractOutstationRates = (pricingRule = {}) => ({
  outstation_base_price: toNonNegative(pricingRule?.outstation_base_price),
  outstation_base_distance: toNonNegative(pricingRule?.outstation_base_distance),
  outstation_price_per_distance: toNonNegative(pricingRule?.outstation_price_per_distance),
  outstation_time_price: toNonNegative(pricingRule?.outstation_time_price),
  outstation_min_km_per_day: toNonNegative(pricingRule?.outstation_min_km_per_day),
  outstation_driver_allowance_per_day: toNonNegative(pricingRule?.outstation_driver_allowance_per_day),
  outstation_night_allowance_per_night: toNonNegative(pricingRule?.outstation_night_allowance_per_night),
  service_tax: toNonNegative(pricingRule?.service_tax),
  minimum_fare: toNonNegative(pricingRule?.minimum_fare),
  night_charge_type: pricingRule?.night_charge_type || 'percentage',
  night_charge: toNonNegative(pricingRule?.night_charge),
  waiting_charge: toNonNegative(pricingRule?.waiting_charge),
  free_waiting_before: toNonNegative(pricingRule?.free_waiting_before),
});

/// Distance, days and allowances for an outstation trip, before money.
export const planOutstationTrip = ({
  rates = {},
  tripType = 'one_way',
  days = 1,
  oneWayDistanceMeters = 0,
  oneWayDurationMinutes = 0,
} = {}) => {
  const type = normalizeTripType(tripType) || 'one_way';
  const returning = isReturnTrip(type);
  const tripDays = returning ? Math.max(1, Math.floor(Number(days) || 1)) : 1;
  const legs = returning ? 2 : 1;

  const oneWayKm = toNonNegative(oneWayDistanceMeters) / 1000;
  const tripKm = oneWayKm * legs;
  const tripMinutes = toNonNegative(oneWayDurationMinutes) * legs;
  const minKmPerDay = toNonNegative(rates.outstation_min_km_per_day);
  // One way is billed on the road actually driven; the per-day minimum is for
  // a car held through the day, which only happens on a return trip.
  const minimumKm = returning ? minKmPerDay * tripDays : 0;
  const billableKm = Math.max(tripKm, minimumKm);

  const nights = returning ? tripDays - 1 : 0;
  const driverAllowancePerDay = toNonNegative(rates.outstation_driver_allowance_per_day);
  const nightAllowancePerNight = toNonNegative(rates.outstation_night_allowance_per_night);
  const driverAllowance = driverAllowancePerDay * tripDays;
  const nightAllowance = nightAllowancePerNight * nights;

  return {
    tripType: type,
    days: tripDays,
    nights,
    legs,
    oneWayKm: roundMoney(oneWayKm),
    tripKm: roundMoney(tripKm),
    tripMinutes: Math.round(tripMinutes),
    minKmPerDay,
    minimumKm: roundMoney(minimumKm),
    billableKm: roundMoney(billableKm),
    driverAllowancePerDay,
    driverAllowance: roundMoney(driverAllowance),
    nightAllowancePerNight,
    nightAllowance: roundMoney(nightAllowance),
    allowancesTotal: roundMoney(driverAllowance + nightAllowance),
  };
};

/// The booked outstation quote: the fare engine's breakdown for the billable
/// km, plus allowances. `tripBreakdown` is computeFareBreakdown's (or
/// quoteFareForPricingRule's) result for `plan.billableKm`.
export const composeOutstationFare = ({ plan, tripBreakdown, rates = {} }) => {
  if (!plan || !tripBreakdown) return null;
  const tripFare = Math.max(0, Number(tripBreakdown.total) || 0);
  return {
    ...tripBreakdown,
    tariff: 'outstation',
    tripType: plan.tripType,
    days: plan.days,
    nights: plan.nights,
    oneWayKm: plan.oneWayKm,
    tripKm: plan.tripKm,
    tripMinutes: plan.tripMinutes,
    minKmPerDay: plan.minKmPerDay,
    minimumKm: plan.minimumKm,
    billableKm: plan.billableKm,
    driverAllowancePerDay: plan.driverAllowancePerDay,
    driverAllowance: plan.driverAllowance,
    nightAllowancePerNight: plan.nightAllowancePerNight,
    nightAllowance: plan.nightAllowance,
    allowancesTotal: plan.allowancesTotal,
    tripFare,
    rates,
    total: Math.max(0, Math.round(tripFare + plan.allowancesTotal)),
  };
};

/// Synchronous outstation quote with surge and night already decided. The
/// booking path uses the async quoteOutstationFare in outstationHooks.js,
/// which resolves surge and night the same way city rides do.
export const computeOutstationFare = ({
  pricingRule,
  tripType = 'one_way',
  days = 1,
  distanceMeters = 0,
  durationMinutes = 0,
  surgeMultiplier = 1,
  isNight = false,
} = {}) => {
  if (!pricingRule) return null;
  const rates = extractOutstationRates(pricingRule);
  const plan = planOutstationTrip({
    rates,
    tripType,
    days,
    oneWayDistanceMeters: distanceMeters,
    oneWayDurationMinutes: durationMinutes,
  });
  const tripBreakdown = computeFareBreakdown({
    pricingRule,
    distanceMeters: plan.billableKm * 1000,
    durationMinutes: plan.tripMinutes,
    serviceType: 'intercity',
    surgeMultiplier,
    isNight,
  });
  return composeOutstationFare({ plan, tripBreakdown, rates });
};

/// Advance due at booking: none, a percentage of the fare, or a fixed sum
/// (never more than the fare). Whole rupees, like the fare.
export const computeAdvanceAmount = ({ type = 'none', value = 0, fare = 0 } = {}) => {
  const normalizedType = String(type || 'none').trim().toLowerCase();
  const safeFare = toNonNegative(fare);
  const safeValue = toNonNegative(value);
  if (safeFare <= 0 || safeValue <= 0) return 0;
  if (normalizedType === 'percentage') {
    return Math.min(safeFare, Math.round((safeFare * Math.min(safeValue, 100)) / 100));
  }
  if (normalizedType === 'fixed') {
    return Math.min(safeFare, Math.round(safeValue));
  }
  return 0;
};

/// The advance a rider has actually paid on this ride, or 0. Read by the
/// completion-payment amounts and by driver wallet settlement, which both
/// have to treat it as money already collected online.
export const advancePaidAmount = (ride = {}) => (
  String(ride?.advance?.status || '') === 'paid' ? roundMoney(toNonNegative(ride?.advance?.amount)) : 0
);

/// Haversine sum over a GPS trail of [lng, lat] points, in km, ignoring jumps
/// faster than `maxSpeedKmph` (a lost fix that snaps across the map would
/// otherwise bill the rider for it).
export const gpsTrailDistanceKm = (points = [], { maxSpeedKmph = 160 } = {}) => {
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  let meters = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const [lng1, lat1] = previous?.coordinates || [];
    const [lng2, lat2] = current?.coordinates || [];
    if (![lng1, lat1, lng2, lat2].every((v) => Number.isFinite(Number(v)))) continue;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const segment = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const seconds = (new Date(current.at).getTime() - new Date(previous.at).getTime()) / 1000;
    if (Number.isFinite(seconds) && seconds > 0 && (segment / 1000) / (seconds / 3600) > maxSpeedKmph) continue;
    meters += segment;
  }
  return roundMoney(meters / 1000);
};

/// Picks the actual km for the trip: odometer first (it is what the meter in
/// the car says, and the driver photographed it), then the GPS trail, then the
/// estimate. An odometer delta that is negative or absurd (over 3000 km a
/// day) is a typo and is skipped rather than billed.
export const resolveActualDistance = ({ odometer = {}, gpsKm = 0, estimatedKm = 0, days = 1 } = {}) => {
  const start = Number(odometer?.startReading);
  const end = Number(odometer?.endReading);
  const hasReadings = odometer?.startReading !== null && odometer?.startReading !== undefined
    && odometer?.endReading !== null && odometer?.endReading !== undefined
    && Number.isFinite(start) && Number.isFinite(end);
  if (hasReadings) {
    const delta = end - start;
    if (delta > 0 && delta <= 3000 * Math.max(1, days)) {
      return { km: roundMoney(delta), source: 'odometer' };
    }
  }
  if (toNonNegative(gpsKm) > 0) {
    return { km: roundMoney(gpsKm), source: 'gps' };
  }
  return { km: roundMoney(toNonNegative(estimatedKm)), source: 'estimate' };
};

/// What an outstation trip finally costs, against what was booked.
///
/// Additive on the booked fare, never below it: the rider agreed to the
/// booked price, and a shorter road does not cut the driver's pay. On top:
/// - extra km past the booked billable km (re-floored at the per-day minimum
///   for the days actually used), at the locked per-km rate and surge;
/// - extra driving time, for single-day trips only - on a multi-day trip
///   the clock includes nights parked, which are paid as allowances instead;
/// - waiting at pickup past the free minutes, at the locked waiting rate;
/// - allowances for days beyond the booking;
/// - tax at the locked rate on the extra km, time and waiting;
/// - tolls, parking, permits and state taxes at cost.
///
/// `booked` is the quote from composeOutstationFare. For a ride booked
/// without one (a package trip, or a client-priced fare) there are no per-km
/// rates to bill extra km at, so only waiting, tolls and taxes apply.
export const computeOutstationFinalFare = ({
  bookedFare = 0,
  booked = null,
  actual = {},
  waiting = {},
  expenses = [],
} = {}) => {
  const safeBookedFare = toNonNegative(bookedFare);
  const hasRates = booked?.tariff === 'outstation';
  const rates = booked?.rates || {};
  const surge = Number(booked?.surgeMultiplier) > 1 ? Number(booked.surgeMultiplier) : 1;
  const taxPercent = toNonNegative(booked?.serviceTaxPercent ?? rates.service_tax);
  const reasons = [];

  const actualKm = toNonNegative(actual.distanceKm);
  const bookedDays = Math.max(1, Math.floor(Number(booked?.days) || 1));
  const actualDays = Math.max(1, Math.floor(Number(actual.days) || 1));
  const returning = isReturnTrip(booked?.tripType);
  const extraDays = returning ? Math.max(0, actualDays - bookedDays) : 0;

  let extraKm = 0;
  let extraKmCharge = 0;
  let extraTimeMinutes = 0;
  let extraTimeCharge = 0;
  let allowances = 0;
  const bookedKm = hasRates ? toNonNegative(booked.billableKm) : 0;

  if (hasRates) {
    const pricePerKm = toNonNegative(booked.pricePerKm ?? rates.outstation_price_per_distance);
    const pricePerMinute = toNonNegative(booked.pricePerMinute ?? rates.outstation_time_price);
    const baseDistanceKm = toNonNegative(booked.baseDistanceKm ?? rates.outstation_base_distance);
    const minKmPerDay = toNonNegative(booked.minKmPerDay ?? rates.outstation_min_km_per_day);
    const actualMinimumKm = returning ? minKmPerDay * Math.max(bookedDays, actualDays) : 0;
    const actualBillableKm = Math.max(actualKm, actualMinimumKm);

    extraKm = Math.max(0, actualBillableKm - Math.max(bookedKm, baseDistanceKm));
    extraKmCharge = extraKm * pricePerKm * surge;
    if (extraKm > 0) reasons.push(`${roundMoney(extraKm)} km over the booked ${roundMoney(bookedKm)} km`);

    const beyondBase = !(baseDistanceKm > 0 && actualBillableKm <= baseDistanceKm);
    if (bookedDays === 1 && actualDays === 1 && beyondBase && pricePerMinute > 0) {
      extraTimeMinutes = Math.max(0, Math.round(toNonNegative(actual.durationMinutes) - toNonNegative(booked.tripMinutes)));
      extraTimeCharge = extraTimeMinutes * pricePerMinute * surge;
      if (extraTimeMinutes > 0) reasons.push(`${extraTimeMinutes} min over the booked driving time`);
    }

    if (extraDays > 0) {
      const perDay = toNonNegative(booked.driverAllowancePerDay ?? rates.outstation_driver_allowance_per_day);
      const perNight = toNonNegative(booked.nightAllowancePerNight ?? rates.outstation_night_allowance_per_night);
      allowances = (perDay + perNight) * extraDays;
      reasons.push(`${extraDays} day(s) beyond the booking`);
    }
  } else {
    reasons.push('no per-km rates were locked at booking, so only waiting, tolls and taxes apply');
  }

  const perMinuteWaiting = toNonNegative(waiting.perMinute ?? rates.waiting_charge);
  const freeWaiting = toNonNegative(waiting.freeMinutes ?? rates.free_waiting_before);
  const waitedMinutes = Math.floor(toNonNegative(actual.waitingMinutes));
  const capMinutes = toNonNegative(waiting.capMinutes, 0) || 120;
  const waitingMinutes = perMinuteWaiting > 0
    ? Math.min(Math.max(0, waitedMinutes - freeWaiting), capMinutes)
    : 0;
  const waitingCharge = waitingMinutes * perMinuteWaiting;
  if (waitingMinutes > 0) reasons.push(`${waitingMinutes} min waiting past the free ${freeWaiting} min`);

  const taxOnExtras = ((extraKmCharge + extraTimeCharge + waitingCharge) * taxPercent) / 100;

  let tollsTotal = 0;
  let stateTaxes = 0;
  for (const item of Array.isArray(expenses) ? expenses : []) {
    const amount = toNonNegative(item?.amount);
    if (String(item?.type || '') === 'state_tax') stateTaxes += amount;
    else tollsTotal += amount;
  }
  if (tollsTotal > 0) reasons.push('tolls, parking and permits at cost');
  if (stateTaxes > 0) reasons.push('state taxes at cost');

  const extras = extraKmCharge + extraTimeCharge + waitingCharge + taxOnExtras + allowances + tollsTotal + stateTaxes;
  const finalFare = Math.max(0, Math.round(safeBookedFare + extras));

  return {
    bookedFare: roundMoney(safeBookedFare),
    finalFare,
    actualKm: roundMoney(actualKm),
    distanceSource: actual.distanceSource || '',
    bookedKm: roundMoney(bookedKm),
    extraKm: roundMoney(extraKm),
    extraKmCharge: roundMoney(extraKmCharge),
    extraTimeMinutes,
    extraTimeCharge: roundMoney(extraTimeCharge),
    waitingMinutes,
    waitingCharge: roundMoney(waitingCharge),
    extraDays,
    allowances: roundMoney(allowances),
    tollsTotal: roundMoney(tollsTotal),
    stateTaxes: roundMoney(stateTaxes),
    taxOnExtras: roundMoney(taxOnExtras),
    reason: reasons.length ? reasons.join('; ') : 'trip ran as booked',
  };
};

/// Invoice rows for an outstation ride, for invoiceService to print under the
/// totals. Kept here so the outstation rules stay in one place; the invoice
/// only lays them out. Rows with a zero amount are skipped, except the total
/// and balance, which always print.
///
/// Returns [] for a ride that is not intercity.
export const buildOutstationInvoiceLines = (ride = {}) => {
  if (String(ride?.serviceType || '') !== 'intercity') return [];

  const adjustment = ride?.fareAdjustment || {};
  const booked = adjustment.bookedBreakdown || ride?.pricingSnapshot?.fare_breakdown || null;
  const applied = Boolean(adjustment.applied && adjustment.computedAt);
  const lines = [];
  const push = (label, amount, { always = false } = {}) => {
    const value = roundMoney(Number(amount) || 0);
    if (always || value !== 0) lines.push({ label, amount: value });
  };

  if (booked?.tariff === 'outstation') {
    const typeLabel = tripTypeLabel(booked.tripType) || 'Outstation';
    push(`${typeLabel} fare (${roundMoney(booked.billableKm)} km${booked.days > 1 ? `, ${booked.days} days` : ''})`, booked.tripFare, { always: true });
    push(`Driver allowance (${booked.days} day${booked.days > 1 ? 's' : ''})`, booked.driverAllowance);
    push(`Night allowance (${booked.nights} night${booked.nights === 1 ? '' : 's'})`, booked.nightAllowance);
  } else {
    push('Trip fare', applied ? adjustment.bookedFare : ride?.fare, { always: true });
  }

  if (applied) {
    push(`Extra km (${roundMoney(adjustment.extraKm)} km)`, adjustment.extraKmCharge);
    push(`Extra time (${adjustment.extraTimeMinutes} min)`, adjustment.extraTimeCharge);
    push(`Waiting (${adjustment.waitingMinutes} min)`, adjustment.waitingCharge);
    push(`Extra day allowances (${adjustment.extraDays})`, adjustment.allowances);
    push('Tax on extras', adjustment.taxOnExtras);
    push('Tolls, parking and permits', adjustment.tollsTotal);
    push('State taxes', adjustment.stateTaxes);
  }

  const total = roundMoney(Number(ride?.fare) || 0);
  const advance = advancePaidAmount(ride);
  push('Total fare', total, { always: true });
  push('Advance paid', -advance);
  push('Balance', Math.max(0, total - advance), { always: true });
  return lines;
};
