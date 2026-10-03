/// Rental money math, kept free of Mongo so it can be unit-tested and shared.
///
/// The user controller and the admin service each had their own copy of
/// `computeRentalRideMetrics`. Both now delegate here, so a booking reads the
/// same price on the rider's phone, the admin panel, the service-centre app and
/// the invoice.
///
/// Every new charge in here is opt-in by data, not by code path:
/// - a `day` package only exists if an admin sets `pricingUnit: 'day'` on it;
/// - km is billed only when the booking was created with `billingTerms.kmBillingEnabled`
///   (setting `rental.bill_extra_km`) and both odometer readings are recorded;
/// - the with-driver surcharge only applies to `driveMode: 'with_driver'`;
/// - extensions and additional (damage) charges only exist once created.
/// A legacy hour-only booking with none of that therefore prices exactly as
/// it did before this file existed.

export const RENTAL_PRICING_UNITS = ['hour', 'day'];
export const RENTAL_DRIVE_MODES = ['self_drive', 'with_driver'];
export const RENTAL_SURCHARGE_UNITS = ['per_booking', 'per_hour', 'per_day'];

/// Statuses in which a booking still holds a vehicle (or will), so it counts
/// against inventory and against a unit's calendar.
export const RENTAL_HOLDING_STATUSES = ['pending', 'confirmed', 'assigned', 'end_requested'];

/// Extensions that move the return time and are owed by the rider.
export const RENTAL_BILLABLE_EXTENSION_STATUSES = ['approved', 'paid'];

const HOUR_MS = 3600000;
const EPS = 1e-9;

export const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const nonNegative = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const toTime = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
};

/// Whole units, rounding up, but tolerant of float noise so 24.0000001h is one
/// day rather than two.
const ceilUnits = (value) => (value <= EPS ? 0 : Math.ceil(value - EPS));

export const normalizePricingUnit = (value) => (String(value || '').trim().toLowerCase() === 'day' ? 'day' : 'hour');

export const normalizeDriveMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  return RENTAL_DRIVE_MODES.includes(mode) ? mode : '';
};

/// A vehicle type stored before drive modes existed has no field at all; that
/// is today's implicit behaviour, which is self-drive (the DL KYC flow).
export const normalizeDriveModes = (value) => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const modes = [...new Set(list.map(normalizeDriveMode).filter(Boolean))];
  return modes.length ? modes : ['self_drive'];
};

export const normalizeWithDriverSurcharge = (value = {}) => {
  if (typeof value === 'number' || typeof value === 'string') {
    return { amount: nonNegative(value), unit: 'per_day' };
  }
  const unit = String(value?.unit || '').trim().toLowerCase();
  return {
    amount: roundMoney(nonNegative(value?.amount)),
    unit: RENTAL_SURCHARGE_UNITS.includes(unit) ? unit : 'per_day',
  };
};

export const normalizeSecurityDeposit = (value = {}) => {
  const enabled = value?.enabled;
  return {
    enabled: enabled === true || ['1', 'true', 'yes', 'on'].includes(String(enabled ?? '').trim().toLowerCase()),
    amount: roundMoney(nonNegative(value?.amount)),
  };
};

/// Normalized terms of one `RentalVehicleType.pricing[]` row.
///
/// For an `hour` row `price` buys the whole package (`durationHours`) and
/// `includedKm` is per package - unchanged from before. For a `day` row
/// `price` and `includedKm` are per day, and the booking is billed for as
/// many days as it spans (at least the package length).
export const resolvePackageTerms = (pkg = {}) => ({
  pricingUnit: normalizePricingUnit(pkg.pricingUnit),
  durationHours: Math.max(1, nonNegative(pkg.durationHours, 1)),
  price: nonNegative(pkg.price),
  includedKm: nonNegative(pkg.includedKm),
  extraHourPrice: nonNegative(pkg.extraHourPrice),
  extraKmPrice: nonNegative(pkg.extraKmPrice),
  extraDayPrice: nonNegative(pkg.extraDayPrice),
});

/// Days billed for a `day` package covering `hours`.
export const billedDaysFor = (terms, hours) =>
  Math.max(1, ceilUnits(nonNegative(hours) / 24), ceilUnits(terms.durationHours / 24));

/// Surcharge for having a driver over `hours`. `per_booking` is charged once,
/// with the base booking, never again on overtime or extensions.
export const surchargeForHours = (surcharge, hours, { includeBookingFee = true } = {}) => {
  const { amount, unit } = normalizeWithDriverSurcharge(surcharge);
  const safeHours = nonNegative(hours);
  if (amount <= 0) return 0;
  if (unit === 'per_booking') return includeBookingFee ? amount : 0;
  if (safeHours <= EPS) return 0;
  if (unit === 'per_hour') return roundMoney(ceilUnits(safeHours) * amount);
  return roundMoney(ceilUnits(safeHours / 24) * amount);
};

/// Price of time beyond what the rider booked (late return).
///
/// Hour packages keep the original rule: every started extra hour at
/// `extraHourPrice`. Day packages charge `extraDayPrice` (falling back to the
/// day rate) per full extra day; a part day is charged by the hour but never
/// more than a full day.
export const priceOvertime = (terms, extraHours) => {
  const hours = nonNegative(extraHours);
  if (hours <= EPS) return 0;

  if (terms.pricingUnit !== 'day') {
    return roundMoney(ceilUnits(hours) * terms.extraHourPrice);
  }

  const dayRate = terms.extraDayPrice > 0 ? terms.extraDayPrice : terms.price;
  const fullDays = Math.floor((hours + EPS) / 24);
  const remainder = Math.max(0, hours - fullDays * 24);
  const remainderCharge = remainder <= EPS
    ? 0
    : terms.extraHourPrice > 0
      ? Math.min(ceilUnits(remainder) * terms.extraHourPrice, dayRate)
      : dayRate;

  return roundMoney(fullDays * dayRate + remainderCharge);
};

/// Upfront price of a booking, used at creation and by the quote endpoint.
export const quoteRentalBooking = ({
  pkg = {},
  pickupDateTime,
  returnDateTime,
  driveMode = 'self_drive',
  withDriverSurcharge = null,
} = {}) => {
  const terms = resolvePackageTerms(pkg);
  const pickupMs = toTime(pickupDateTime);
  const returnMs = toTime(returnDateTime);
  const requestedHours = Number.isFinite(pickupMs) && Number.isFinite(returnMs)
    ? Math.max(0, (returnMs - pickupMs) / HOUR_MS)
    : 0;

  let billedDays = 0;
  let basePrice = terms.price;
  let includedHours = terms.durationHours;
  let includedKm = terms.includedKm;

  if (terms.pricingUnit === 'day') {
    billedDays = billedDaysFor(terms, requestedHours);
    basePrice = terms.price * billedDays;
    includedHours = billedDays * 24;
    includedKm = terms.includedKm * billedDays;
  }

  const surcharge = normalizeWithDriverSurcharge(withDriverSurcharge || {});
  const driverSurcharge = normalizeDriveMode(driveMode) === 'with_driver'
    ? surchargeForHours(surcharge, includedHours, { includeBookingFee: true })
    : 0;

  return {
    pricingUnit: terms.pricingUnit,
    billedDays,
    requestedHours: roundMoney(requestedHours),
    includedHours,
    includedKm,
    basePrice: roundMoney(basePrice),
    unitPrice: terms.price,
    extraHourPrice: terms.extraHourPrice,
    extraKmPrice: terms.extraKmPrice,
    extraDayPrice: terms.extraDayPrice,
    driverSurcharge,
    totalCost: roundMoney(basePrice + driverSurcharge),
  };
};

/// Price of extending a booking from its current return time to a new one.
///
/// Uses the overtime rates, because an extension is overtime agreed in
/// advance. When an hour package has no `extraHourPrice` configured the
/// package's own hourly rate is used instead, so an extension is never free by
/// accident.
export const quoteRentalExtension = ({ terms: rawTerms = {}, from, to, driveMode = 'self_drive', withDriverSurcharge = null } = {}) => {
  const terms = rawTerms.pricingUnit !== undefined && rawTerms.durationHours !== undefined
    ? rawTerms
    : resolvePackageTerms(rawTerms);
  const fromMs = toTime(from);
  const toMs = toTime(to);
  const hours = Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.max(0, (toMs - fromMs) / HOUR_MS) : 0;

  const effectiveTerms = terms.pricingUnit !== 'day' && terms.extraHourPrice <= 0
    ? { ...terms, extraHourPrice: terms.durationHours > 0 ? terms.price / terms.durationHours : 0 }
    : terms;

  const timeCharge = priceOvertime(effectiveTerms, hours);
  const includedKm = terms.pricingUnit === 'day'
    ? terms.includedKm * ceilUnits(hours / 24)
    : terms.durationHours > 0
      ? Math.round((terms.includedKm * hours) / terms.durationHours)
      : 0;
  const driverSurcharge = normalizeDriveMode(driveMode) === 'with_driver'
    ? surchargeForHours(withDriverSurcharge || {}, hours, { includeBookingFee: false })
    : 0;

  return {
    hours: roundMoney(hours),
    timeCharge,
    driverSurcharge,
    includedKm,
    amount: roundMoney(timeCharge + driverSurcharge),
  };
};

/// Pricing terms for a stored booking.
///
/// The snapshot on the booking is the source of truth. When the vehicle type
/// is populated the old code took the larger of snapshot and live package for
/// duration, price and extra-hour price; that is preserved so legacy bookings
/// price identically.
export const resolveBookingTerms = (item = {}) => {
  const selected = item.selectedPackage || {};
  const packageId = String(selected.packageId || '').trim();
  const vehiclePricing = Array.isArray(item.vehicleTypeId?.pricing) ? item.vehicleTypeId.pricing : [];
  const matched = vehiclePricing.find((entry) => String(entry?.id || entry?.packageId || '').trim() === packageId) || {};

  const pricingUnit = normalizePricingUnit(selected.pricingUnit || matched.pricingUnit);
  const pick = (key) => (selected[key] !== undefined && selected[key] !== null ? nonNegative(selected[key]) : nonNegative(matched[key]));

  const terms = {
    pricingUnit,
    durationHours: Math.max(nonNegative(selected.durationHours), nonNegative(matched.durationHours), 1),
    price: Math.max(nonNegative(selected.price), nonNegative(matched.price), 0),
    extraHourPrice: Math.max(nonNegative(selected.extraHourPrice), nonNegative(matched.extraHourPrice), 0),
    includedKm: pick('includedKm'),
    extraKmPrice: pick('extraKmPrice'),
    extraDayPrice: pick('extraDayPrice'),
  };

  if (pricingUnit === 'day') {
    // A day booking snapshots the per-day rate and the number of days; the
    // duration it stores is the whole booking, so derive days from it when an
    // older snapshot lacks billedDays.
    const billedDays = Math.max(1, nonNegative(selected.billedDays) || ceilUnits(terms.durationHours / 24));
    return {
      ...terms,
      billedDays,
      basePrice: terms.price * billedDays,
      includedHours: billedDays * 24,
      totalIncludedKm: terms.includedKm * billedDays,
    };
  }

  return {
    ...terms,
    billedDays: 0,
    basePrice: terms.price,
    includedHours: terms.durationHours,
    totalIncludedKm: terms.includedKm,
  };
};

export const summarizeExtensions = (extensions = []) => {
  const billable = (Array.isArray(extensions) ? extensions : []).filter((entry) =>
    RENTAL_BILLABLE_EXTENSION_STATUSES.includes(String(entry?.status || '')),
  );
  return billable.reduce(
    (acc, entry) => {
      const fromMs = toTime(entry.from);
      const toMs = toTime(entry.to);
      const hours = Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.max(0, (toMs - fromMs) / HOUR_MS) : 0;
      acc.hours += hours;
      acc.amount += nonNegative(entry.amount);
      acc.includedKm += nonNegative(entry.includedKm);
      if (entry.status === 'paid') acc.paid += nonNegative(entry.amount);
      acc.count += 1;
      return acc;
    },
    { hours: 0, amount: 0, includedKm: 0, paid: 0, count: 0 },
  );
};

export const sumAdditionalCharges = (charges = []) =>
  roundMoney((Array.isArray(charges) ? charges : []).reduce((sum, entry) => sum + nonNegative(entry?.amount), 0));

/// Km driven beyond the allowance, from the inspection odometer readings.
///
/// `includedKm: 0` means unlimited km (the convention rental apps use), so a
/// package with no allowance configured never bills km.
export const computeExtraKm = ({ pickupMeterReading, returnMeterReading, includedKm, enabled }) => {
  const start = Number(pickupMeterReading);
  const end = Number(returnMeterReading);
  const hasReadings =
    pickupMeterReading !== null && pickupMeterReading !== undefined && pickupMeterReading !== '' &&
    returnMeterReading !== null && returnMeterReading !== undefined && returnMeterReading !== '' &&
    Number.isFinite(start) && Number.isFinite(end) && end >= start;
  const distanceKm = hasReadings ? roundMoney(end - start) : null;

  if (!enabled || !hasReadings || nonNegative(includedKm) <= 0) {
    return { distanceKm, extraKm: 0 };
  }

  return { distanceKm, extraKm: roundMoney(Math.max(0, end - start - nonNegative(includedKm))) };
};

/// Live or final charge of a rental booking.
///
/// Returns every field the old `computeRentalRideMetrics` returned, with the
/// same values for a legacy booking, plus the itemized parts.
export const computeRentalBillingMetrics = (item = {}, endedAt = null, { now = Date.now() } = {}) => {
  const terms = resolveBookingTerms(item);
  const payableNow = nonNegative(item.payableNow);
  const startDate = item.assignedAt || item.pickupDateTime || item.createdAt;
  const startMs = toTime(startDate);
  const endMs = endedAt ? toTime(endedAt) : now;
  const hourlyRate = terms.includedHours > 0 ? terms.basePrice / terms.includedHours : 0;

  const withDriver = normalizeDriveMode(item.driveMode) === 'with_driver';
  const surcharge = normalizeWithDriverSurcharge(item.withDriverSurcharge || {});
  const baseSurcharge = withDriver ? surchargeForHours(surcharge, terms.includedHours, { includeBookingFee: true }) : 0;
  const extensions = summarizeExtensions(item.extensions);
  const additionalCharges = sumAdditionalCharges(item.additionalCharges);
  const km = computeExtraKm({
    pickupMeterReading: item.rentalInspection?.pickupMeterReading,
    returnMeterReading: item.rentalInspection?.returnMeterReading,
    includedKm: terms.totalIncludedKm + extensions.includedKm,
    enabled: item.billingTerms?.kmBillingEnabled === true,
  });
  const extraKmCharge = roundMoney(km.extraKm * terms.extraKmPrice);

  const common = {
    pricingUnit: terms.pricingUnit,
    billedDays: terms.billedDays,
    allowedHours: roundMoney(terms.includedHours + extensions.hours),
    distanceKm: km.distanceKm,
    includedKm: roundMoney(terms.totalIncludedKm + extensions.includedKm),
    extraKm: km.extraKm,
    extraKmRate: roundMoney(terms.extraKmPrice),
    extraKmCharge,
    extensionHours: roundMoney(extensions.hours),
    extensionsCharge: roundMoney(extensions.amount),
    extensionsPaid: roundMoney(extensions.paid),
    additionalCharges,
  };

  if (!Number.isFinite(startMs)) {
    const gross = terms.basePrice + baseSurcharge + extensions.amount + additionalCharges + extraKmCharge;
    const currentCharge = Math.max(gross, payableNow);
    return {
      hourlyRate: Math.max(0, hourlyRate),
      includedHours: terms.includedHours,
      basePrice: terms.basePrice,
      extraHourRate: terms.extraHourPrice,
      elapsedMinutes: 0,
      elapsedHours: 0,
      currentCharge,
      remainingDue: Math.max(0, currentCharge - payableNow - extensions.paid),
      ...common,
      extraHours: 0,
      extraTimeCharge: 0,
      driverSurcharge: baseSurcharge,
      grossCharge: roundMoney(gross),
    };
  }

  const elapsedMs = Math.max(0, (Number.isFinite(endMs) ? endMs : now) - startMs);
  const elapsedMinutes = Math.max(0, Math.ceil(elapsedMs / 60000));
  const elapsedHours = elapsedMs / HOUR_MS;
  const overtimeHours = Math.max(0, elapsedHours - terms.includedHours - extensions.hours);
  const extraTimeCharge = priceOvertime(terms, overtimeHours);
  const overtimeSurcharge = withDriver ? surchargeForHours(surcharge, overtimeHours, { includeBookingFee: false }) : 0;
  const driverSurcharge = roundMoney(baseSurcharge + overtimeSurcharge);

  const gross = terms.basePrice + extraTimeCharge + driverSurcharge + extensions.amount + additionalCharges + extraKmCharge;
  const currentCharge = roundMoney(Math.max(payableNow, gross));
  const remainingDue = Math.max(0, roundMoney(currentCharge - payableNow - extensions.paid));

  return {
    hourlyRate: Math.max(0, roundMoney(hourlyRate)),
    includedHours: terms.includedHours,
    basePrice: roundMoney(terms.basePrice),
    extraHourRate: roundMoney(terms.extraHourPrice),
    elapsedMinutes,
    elapsedHours: roundMoney(elapsedHours),
    currentCharge,
    remainingDue,
    ...common,
    extraHours: roundMoney(overtimeHours),
    extraTimeCharge,
    driverSurcharge,
    grossCharge: roundMoney(gross),
  };
};

/// What is left of a security deposit after the deductions recorded on it.
export const depositBalance = (deposit = {}) =>
  roundMoney(
    Math.max(
      0,
      Number(deposit.amount || 0) -
        (Array.isArray(deposit.deductions) ? deposit.deductions : []).reduce((sum, entry) => sum + Number(entry?.amount || 0), 0),
    ),
  );
