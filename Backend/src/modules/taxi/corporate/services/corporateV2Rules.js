/// Pure Corporate v2 rules (docs/plans/corporate-v2.md): IST allowance
/// periods, office boundary, company tariff fare, the company/employee split,
/// the driver wallet credit for a cash excess, and code generation. No
/// database or env access, so every money rule is unit-tested
/// (Backend/test/corporate-v2.test.js).

import { computeFareBreakdown } from '../../services/fareEngineService.js';
import { normalizeTripType } from '../../outstation/services/outstationFare.js';
import { normalizeCorporateServiceType, round2 } from './corporatePolicyEngine.js';

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const EXCESS_METHODS = Object.freeze(['cash', 'online', 'wallet']);

const nonNegative = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
};

// --- IST periods ------------------------------------------------------------

/// The IST calendar date of `date` as a UTC-midnight Date (so getUTC* read the
/// IST day).
const istDay = (date) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

/// ISO-8601 week of the IST date: weeks start Monday, week 1 is the week with
/// the year's first Thursday, so 29 Dec can be week 1 of the next year and
/// 1 Jan can be week 52/53 of the previous one.
export const getIsoWeek = (date = new Date()) => {
  const day = istDay(date);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(day.getTime() + (3 - weekday) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const dayOfYear = Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / DAY_MS);
  return { isoYear, week: Math.floor(dayOfYear / 7) + 1 };
};

export const isoWeekKey = (date = new Date()) => {
  const { isoYear, week } = getIsoWeek(date);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
};

export const istMonthKey = (date = new Date()) => {
  const day = istDay(date);
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}`;
};

/// 'weekly' -> '2026-W41', anything else -> '2026-10'.
export const getAllowancePeriodKey = (period, date = new Date()) =>
  (period === 'weekly' ? isoWeekKey(date) : istMonthKey(date));

/// [from, to) of the IST week (Monday 00:00 IST -> next Monday 00:00 IST)
/// containing `date`, as UTC instants, with its ISO week key.
export const getIstWeekRange = (date = new Date()) => {
  const day = istDay(date);
  const weekday = (day.getUTCDay() + 6) % 7;
  const mondayUtcMidnight = day.getTime() - weekday * DAY_MS;
  const from = new Date(mondayUtcMidnight - IST_OFFSET_MS);
  const to = new Date(mondayUtcMidnight + 7 * DAY_MS - IST_OFFSET_MS);
  return { from, to, periodKey: isoWeekKey(from) };
};

export const getPreviousIstWeekRange = (now = new Date()) => {
  const { from } = getIstWeekRange(now);
  return getIstWeekRange(new Date(from.getTime() - 60 * 1000));
};

/// Monday is 0, IST.
export const getIstWeekday = (date = new Date()) => (istDay(date).getUTCDay() + 6) % 7;

// --- office boundary ------------------------------------------------------

export const haversineKm = (from = [], to = []) => {
  const [lng1, lat1] = (from || []).map(Number);
  const [lng2, lat2] = (to || []).map(Number);
  if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) return Infinity;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const officeCoordinates = (office) => {
  const coords = office?.location?.coordinates;
  if (Array.isArray(coords) && coords.length === 2) return coords;
  if (office && office.lat !== undefined && office.lng !== undefined) return [office.lng, office.lat];
  return null;
};

export const isInsideAnyOffice = (point, offices = []) =>
  (offices || []).some((office) => {
    const center = officeCoordinates(office);
    const radius = nonNegative(office?.radiusKm);
    return center && radius > 0 && haversineKm(center, point) <= radius;
  });

/// Whether a trip respects the company's travel zone. `pickup`/`drop` are
/// [lng, lat]. Free roaming (or the master switch off) always passes.
/// `both_ends`: pickup and drop each inside some office circle;
/// `either_end`: at least one of them.
export const checkTravelZone = ({ travelZone = null, pickup, drop, enabled = true } = {}) => {
  const mode = travelZone?.mode === 'office_boundary' ? 'office_boundary' : 'free_roaming';
  if (!enabled || mode !== 'office_boundary') {
    return { applies: false, withinBoundary: true, pickupInside: null, dropInside: null, rule: null };
  }
  const rule = travelZone?.rule === 'either_end' ? 'either_end' : 'both_ends';
  const offices = travelZone?.offices || [];
  const pickupInside = isInsideAnyOffice(pickup, offices);
  const dropInside = isInsideAnyOffice(drop, offices);
  const withinBoundary = rule === 'either_end' ? pickupInside || dropInside : pickupInside && dropInside;
  return { applies: true, withinBoundary, pickupInside, dropInside, rule };
};

/// Offices as the rider app / refusal payload shows them.
export const serializeOffices = (offices = []) =>
  (offices || []).map((office) => {
    const coords = officeCoordinates(office) || [null, null];
    return {
      id: office?._id ? String(office._id) : undefined,
      name: office?.name || '',
      address: office?.address || '',
      lat: coords[1],
      lng: coords[0],
      radiusKm: nonNegative(office?.radiusKm),
    };
  });

// --- company tariff -------------------------------------------------------

export const tariffAppliesTo = ({ tariff = null, serviceType, masterEnabled = true } = {}) => {
  if (!masterEnabled || !tariff?.enabled) return false;
  const service = normalizeCorporateServiceType(serviceType);
  const appliesTo = Array.isArray(tariff.appliesTo) && tariff.appliesTo.length ? tariff.appliesTo : ['ride', 'intercity'];
  return appliesTo.includes(service);
};

/// The vehicle's own row when there is one, else the company fallback.
export const resolveTariffRate = (tariff = {}, vehicleTypeId = null) => {
  const row = vehicleTypeId
    ? (tariff?.byVehicleType || []).find((item) => String(item?.vehicleTypeId || '') === String(vehicleTypeId))
    : null;
  const source = row || tariff || {};
  return {
    source: row ? 'vehicle' : 'fallback',
    baseFare: nonNegative(source.baseFare),
    baseKm: nonNegative(source.baseKm),
    perKm: nonNegative(source.perKm),
    perMinute: nonNegative(source.perMinute),
    minimumFare: nonNegative(source.minimumFare),
  };
};

/// Fare on the company's rate card, through the very arithmetic Set Price
/// fares use (computeFareBreakdown) by handing it a synthetic pricing rule:
/// base covers baseKm, then per-km and per-minute, the minimum fare floor, GST
/// at the Set Price `service_tax`. No surge or night charge: the rate card is
/// the negotiated price.
export const computeCorporateTariffFare = ({
  tariff = {},
  vehicleTypeId = null,
  distanceMeters = 0,
  durationMinutes = 0,
  serviceTaxPercent = 0,
} = {}) => {
  const rate = resolveTariffRate(tariff, vehicleTypeId);
  const breakdown = computeFareBreakdown({
    pricingRule: {
      base_price: rate.baseFare,
      base_distance: rate.baseKm,
      price_per_distance: rate.perKm,
      time_price: rate.perMinute,
      minimum_fare: rate.minimumFare,
      service_tax: nonNegative(serviceTaxPercent),
    },
    distanceMeters,
    durationMinutes,
    serviceType: 'ride',
    surgeMultiplier: 1,
    isNight: false,
  });
  return { ...breakdown, tariff: 'corporate', rateSource: rate.source };
};

// --- allowance and split ----------------------------------------------------

export const computeRemainingKm = ({ allowanceKm = 0, usedKm = 0, reservedKm = 0 } = {}) =>
  round2(Math.max(0, nonNegative(allowanceKm) - nonNegative(usedKm) - nonNegative(reservedKm)));

/// Company / employee shares of one fare.
///
///   coveredKm      = min(remaining, km)          (all of km when the allowance is off)
///   excessKm       = km - coveredKm
///   employeeAmount = round(fare * excessKm / km) (whole rupees)
///   companyAmount  = fare - employeeAmount
///
/// The same formula serves the estimate at booking (estimated km, remaining
/// after other reservations) and the final split at completion (actual km,
/// remaining after this ride's own reservation is released).
export const computeCorporateSplit = ({ fare = 0, km = 0, remainingKm = 0, allowanceEnabled = false } = {}) => {
  const safeFare = round2(nonNegative(fare));
  const safeKm = round2(nonNegative(km));
  if (!allowanceEnabled) {
    return { km: safeKm, coveredKm: safeKm, excessKm: 0, employeeAmount: 0, companyAmount: safeFare };
  }
  const coveredKm = round2(Math.min(nonNegative(remainingKm), safeKm));
  const excessKm = round2(Math.max(0, safeKm - coveredKm));
  const employeeAmount = safeKm > 0 ? Math.min(safeFare, Math.round((safeFare * excessKm) / safeKm)) : 0;
  return {
    km: safeKm,
    coveredKm,
    excessKm,
    employeeAmount,
    companyAmount: round2(safeFare - employeeAmount),
  };
};

export const normalizeExcessMethods = (methods) => {
  const list = Array.isArray(methods) ? methods.map((item) => String(item || '').trim().toLowerCase()).filter((item) => EXCESS_METHODS.includes(item)) : [];
  return list.length ? [...new Set(list)] : [...EXCESS_METHODS];
};

/// The method used when the final split finds an excess the booking did not
/// expect: cash when allowed, else online, else wallet.
export const defaultEmployeePaymentMethod = (allowedMethods) => {
  const allowed = normalizeExcessMethods(allowedMethods);
  return ['cash', 'online', 'wallet'].find((item) => allowed.includes(item)) || 'cash';
};

/// Validates the method a rider / travel desk picked. Returns
/// { ok, method, reason }.
export const resolveEmployeePaymentMethod = ({ requested = '', allowedMethods, required = false } = {}) => {
  const allowed = normalizeExcessMethods(allowedMethods);
  const method = String(requested || '').trim().toLowerCase();
  if (!method) {
    return required
      ? { ok: false, method: '', reason: 'employeePaymentMethod is required: part of this trip is over your km allowance', allowed }
      : { ok: true, method: '', allowed };
  }
  if (!allowed.includes(method)) {
    return { ok: false, method, reason: `employeePaymentMethod must be one of ${allowed.join(', ')}`, allowed };
  }
  return { ok: true, method, allowed };
};

/// What the employee owes after the final split, and its state:
/// nothing owed -> not_required; cash -> paid (the driver collected it on
/// completion); online / wallet -> pending until the completion payment.
export const resolveFinalEmployeePayment = ({ employeeAmount = 0, chosenMethod = '', allowedMethods } = {}) => {
  if (!(Number(employeeAmount) > 0)) {
    return { employeePaymentMethod: chosenMethod || '', employeePaymentStatus: 'not_required' };
  }
  const allowed = normalizeExcessMethods(allowedMethods);
  const method = allowed.includes(chosenMethod) ? chosenMethod : defaultEmployeePaymentMethod(allowed);
  return { employeePaymentMethod: method, employeePaymentStatus: method === 'cash' ? 'paid' : 'pending' };
};

/// What a corporate ride's driver wallet movement is.
///
/// Commission is on the full fare. With no excess, or an excess paid online /
/// from the wallet, the driver is credited `driverEarnings` (fare -
/// commission) exactly as today. With a cash excess the driver already holds
/// `employeeAmount`, so the credit is fare - commission - employeeAmount, which
/// can be negative (then booked as a commission deduction, the way cash rides
/// are).
export const computeCorporateDriverWalletCredit = ({ driverEarnings = 0, split = null } = {}) => {
  const earnings = round2(Number(driverEarnings) || 0);
  const cashCollected = split?.employeePaymentMethod === 'cash' ? nonNegative(split?.employeeAmount) : 0;
  const amount = round2(earnings - cashCollected);
  return { amount, cashCollected: round2(cashCollected), type: cashCollected > 0 && amount < 0 ? 'commission_deduction' : 'ride_earning' };
};

/// Km a trip is expected to cover: the routed distance, doubled for an
/// outstation round trip / multi-day booking.
export const estimateTripKm = ({ distanceMeters = 0, serviceType = 'ride', tripType = '' } = {}) => {
  const km = nonNegative(distanceMeters) / 1000;
  return round2(isRoundTripService(serviceType, tripType) ? km * 2 : km);
};

/// An outstation round trip / multi-day booking ('Round Trip' or 'round_trip').
export const isRoundTripService = (serviceType, tripType) =>
  normalizeCorporateServiceType(serviceType) === 'intercity' && ['round_trip', 'multi_day'].includes(normalizeTripType(tripType));

// --- codes ------------------------------------------------------------------

/// `ACME-0001`.
export const formatEmployeeCode = (corporateCode, seq) =>
  `${String(corporateCode || 'CORP').trim().toUpperCase()}-${String(Math.max(1, Math.floor(Number(seq) || 1))).padStart(4, '0')}`;

export const normalizeEmployeeCode = (value) => String(value ?? '').trim().toUpperCase();

/// Company code candidates from its name, in the order to try them: the first
/// six letters, then that stem with a letter suffix (ACMEA, ACMEB, ...), then
/// two-letter suffixes. Uppercase letters only, max 6.
export const corporateCodeCandidates = (name = '') => {
  const letters = String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
  const base = (letters || 'CORP').slice(0, 6);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const candidates = [base];
  const stem1 = base.slice(0, 5);
  for (const a of alphabet) candidates.push(`${stem1}${a}`);
  const stem2 = base.slice(0, 4);
  for (const a of alphabet) for (const b of alphabet) candidates.push(`${stem2}${a}${b}`);
  return [...new Set(candidates)];
};
