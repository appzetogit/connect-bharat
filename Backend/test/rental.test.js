import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeExtraKm,
  computeRentalBillingMetrics,
  priceOvertime,
  quoteRentalBooking,
  quoteRentalExtension,
  resolvePackageTerms,
  surchargeForHours,
  normalizeDriveModes,
  depositBalance,
} from '../src/modules/taxi/rental/services/rentalBilling.js';
import {
  computeAvailability,
  findUnitConflicts,
  maxConcurrentBookings,
  rangesOverlap,
} from '../src/modules/taxi/rental/services/rentalAvailability.js';
import { buildRentalInvoiceLines } from '../src/modules/taxi/rental/services/rentalInvoiceLines.js';

const H = 3600000;
const T0 = new Date('2026-10-01T06:00:00.000Z');
const at = (hours) => new Date(T0.getTime() + hours * H);

/// The formula userController/adminService used before rentalBilling
/// existed, kept verbatim so legacy bookings are proven to price the same.
const legacyMetrics = (item = {}, endedAt = null) => {
  const selectedPackage = item.selectedPackage || {};
  const includedHours = Math.max(Number(selectedPackage.durationHours || 0), 1);
  const basePrice = Math.max(Number(selectedPackage.price || 0), 0);
  const extraHourPrice = Math.max(Number(selectedPackage.extraHourPrice || 0), 0);
  const startDate = item.assignedAt || item.pickupDateTime || item.createdAt;
  const startMs = startDate ? new Date(startDate).getTime() : NaN;
  const endMs = endedAt ? new Date(endedAt).getTime() : Date.now();
  const hourlyRate = includedHours > 0 ? basePrice / includedHours : 0;
  if (!Number.isFinite(startMs)) {
    return {
      hourlyRate: Math.max(0, hourlyRate),
      includedHours,
      basePrice,
      extraHourRate: extraHourPrice,
      elapsedMinutes: 0,
      elapsedHours: 0,
      currentCharge: Math.max(basePrice, Number(item.payableNow || 0)),
      remainingDue: Math.max(0, Math.max(basePrice, Number(item.payableNow || 0)) - Number(item.payableNow || 0)),
    };
  }
  const elapsedMs = Math.max(0, endMs - startMs);
  const elapsedMinutes = Math.max(0, Math.ceil(elapsedMs / 60000));
  const elapsedHours = elapsedMs / 3600000;
  const charge = elapsedHours <= includedHours
    ? basePrice
    : basePrice + Math.ceil(Math.max(0, elapsedHours - includedHours)) * extraHourPrice;
  const currentCharge = Math.round((Math.max(Number(item.payableNow || 0), charge) + Number.EPSILON) * 100) / 100;
  return {
    hourlyRate: Math.max(0, Math.round((hourlyRate + Number.EPSILON) * 100) / 100),
    includedHours,
    basePrice: Math.round((basePrice + Number.EPSILON) * 100) / 100,
    extraHourRate: Math.round((extraHourPrice + Number.EPSILON) * 100) / 100,
    elapsedMinutes,
    elapsedHours: Math.round((elapsedHours + Number.EPSILON) * 100) / 100,
    currentCharge,
    remainingDue: Math.max(0, Math.round((currentCharge - Number(item.payableNow || 0) + Number.EPSILON) * 100) / 100),
  };
};

const LEGACY_KEYS = ['hourlyRate', 'includedHours', 'basePrice', 'extraHourRate', 'elapsedMinutes', 'elapsedHours', 'currentCharge', 'remainingDue'];

test('legacy hour-only bookings price exactly as before', () => {
  const cases = [];
  for (const durationHours of [1, 4, 8, 12]) {
    for (const price of [0, 499, 1299.5]) {
      for (const extraHourPrice of [0, 100, 149.99]) {
        for (const payableNow of [0, 200, 5000]) {
          for (const elapsed of [0, 0.5, durationHours, durationHours + 0.01, durationHours + 2.7, 40]) {
            cases.push({ durationHours, price, extraHourPrice, payableNow, elapsed });
          }
        }
      }
    }
  }
  for (const c of cases) {
    const item = {
      selectedPackage: { packageId: 'p', durationHours: c.durationHours, price: c.price, extraHourPrice: c.extraHourPrice },
      assignedAt: T0,
      payableNow: c.payableNow,
      rentalInspection: { pickupMeterReading: 1000, returnMeterReading: 1500 }, // km present but billing never enabled
    };
    const expected = legacyMetrics(item, at(c.elapsed));
    const actual = computeRentalBillingMetrics(item, at(c.elapsed));
    for (const key of LEGACY_KEYS) {
      assert.equal(actual[key], expected[key], `${key} for ${JSON.stringify(c)}`);
    }
  }
  const noStart = { selectedPackage: { durationHours: 4, price: 800 }, payableNow: 100 };
  for (const key of LEGACY_KEYS) {
    assert.equal(computeRentalBillingMetrics(noStart)[key], legacyMetrics(noStart)[key], key);
  }
});

test('hourly overtime charges each started extra hour', () => {
  const item = { selectedPackage: { durationHours: 4, price: 1000, extraHourPrice: 150 }, assignedAt: T0 };
  assert.equal(computeRentalBillingMetrics(item, at(4)).currentCharge, 1000);
  assert.equal(computeRentalBillingMetrics(item, at(4.1)).currentCharge, 1150);
  const m = computeRentalBillingMetrics(item, at(6.5));
  assert.equal(m.currentCharge, 1450);
  assert.equal(m.extraTimeCharge, 450);
  assert.equal(m.extraHours, 2.5);
});

test('daily packages bill per day spanned and per-day km', () => {
  const pkg = { id: 'd', pricingUnit: 'day', durationHours: 24, price: 2000, includedKm: 200, extraKmPrice: 10, extraDayPrice: 2500, extraHourPrice: 300 };
  const quote = quoteRentalBooking({ pkg, pickupDateTime: at(0), returnDateTime: at(60) });
  assert.equal(quote.billedDays, 3);
  assert.equal(quote.basePrice, 6000);
  assert.equal(quote.totalCost, 6000);
  assert.equal(quote.includedHours, 72);
  assert.equal(quote.includedKm, 600);

  // Minimum is the package length.
  const minQuote = quoteRentalBooking({ pkg: { ...pkg, durationHours: 48 }, pickupDateTime: at(0), returnDateTime: at(5) });
  assert.equal(minQuote.billedDays, 2);

  const booking = {
    selectedPackage: { pricingUnit: 'day', billedDays: 3, durationHours: 72, price: 2000, includedKm: 200, extraKmPrice: 10, extraDayPrice: 2500, extraHourPrice: 300 },
    assignedAt: T0,
    billingTerms: { kmBillingEnabled: true },
    rentalInspection: { pickupMeterReading: 10000, returnMeterReading: 10750 },
  };
  const onTime = computeRentalBillingMetrics(booking, at(72));
  assert.equal(onTime.basePrice, 6000);
  assert.equal(onTime.includedKm, 600);
  assert.equal(onTime.extraKm, 150);
  assert.equal(onTime.extraKmCharge, 1500);
  assert.equal(onTime.currentCharge, 7500);

  // 2h late: by the hour (600) since that is under a day.
  assert.equal(computeRentalBillingMetrics(booking, at(74)).extraTimeCharge, 600);
  // 20h late: hourly would be 6000, capped at one extra day (2500).
  assert.equal(computeRentalBillingMetrics(booking, at(92)).extraTimeCharge, 2500);
  // 30h late: one full day + 6h.
  assert.equal(computeRentalBillingMetrics(booking, at(102)).extraTimeCharge, 2500 + 1800);
});

test('day overtime falls back to the day rate', () => {
  const terms = resolvePackageTerms({ pricingUnit: 'day', durationHours: 24, price: 1800 });
  assert.equal(priceOvertime(terms, 3), 1800);
  assert.equal(priceOvertime(terms, 24), 1800);
  assert.equal(priceOvertime(terms, 25), 3600);
});

test('extra km is billed only when enabled, with readings and an allowance', () => {
  assert.deepEqual(computeExtraKm({ pickupMeterReading: 100, returnMeterReading: 400, includedKm: 200, enabled: true }), { distanceKm: 300, extraKm: 100 });
  assert.equal(computeExtraKm({ pickupMeterReading: 100, returnMeterReading: 400, includedKm: 200, enabled: false }).extraKm, 0);
  assert.equal(computeExtraKm({ pickupMeterReading: 100, returnMeterReading: null, includedKm: 200, enabled: true }).extraKm, 0);
  // includedKm 0 means unlimited.
  assert.equal(computeExtraKm({ pickupMeterReading: 100, returnMeterReading: 400, includedKm: 0, enabled: true }).extraKm, 0);
  // A reading that goes backwards is ignored rather than billed.
  assert.equal(computeExtraKm({ pickupMeterReading: 400, returnMeterReading: 100, includedKm: 50, enabled: true }).distanceKm, null);

  const hourly = {
    selectedPackage: { durationHours: 8, price: 1200, includedKm: 80, extraKmPrice: 12 },
    assignedAt: T0,
    billingTerms: { kmBillingEnabled: true },
    rentalInspection: { pickupMeterReading: 5000, returnMeterReading: 5100 },
  };
  const m = computeRentalBillingMetrics(hourly, at(8));
  assert.equal(m.extraKm, 20);
  assert.equal(m.currentCharge, 1200 + 240);
});

test('with-driver surcharge by unit', () => {
  assert.equal(surchargeForHours({ amount: 500, unit: 'per_day' }, 30), 1000);
  assert.equal(surchargeForHours({ amount: 100, unit: 'per_hour' }, 2.5), 300);
  assert.equal(surchargeForHours({ amount: 700, unit: 'per_booking' }, 50), 700);
  assert.equal(surchargeForHours({ amount: 700, unit: 'per_booking' }, 50, { includeBookingFee: false }), 0);
  assert.equal(surchargeForHours({ amount: 0, unit: 'per_day' }, 50), 0);

  const quote = quoteRentalBooking({
    pkg: { pricingUnit: 'hour', durationHours: 8, price: 1500 },
    pickupDateTime: at(0),
    returnDateTime: at(8),
    driveMode: 'with_driver',
    withDriverSurcharge: { amount: 100, unit: 'per_hour' },
  });
  assert.equal(quote.driverSurcharge, 800);
  assert.equal(quote.totalCost, 2300);

  const selfDrive = quoteRentalBooking({
    pkg: { durationHours: 8, price: 1500 },
    pickupDateTime: at(0),
    returnDateTime: at(8),
    driveMode: 'self_drive',
    withDriverSurcharge: { amount: 100, unit: 'per_hour' },
  });
  assert.equal(selfDrive.driverSurcharge, 0);
  assert.equal(selfDrive.totalCost, 1500);

  const booking = {
    selectedPackage: { durationHours: 8, price: 1500, extraHourPrice: 200 },
    driveMode: 'with_driver',
    withDriverSurcharge: { amount: 100, unit: 'per_hour' },
    assignedAt: T0,
  };
  const late = computeRentalBillingMetrics(booking, at(10));
  assert.equal(late.driverSurcharge, 1000); // 8h booked + 2h overtime
  assert.equal(late.currentCharge, 1500 + 400 + 1000);
});

test('extensions move the overtime threshold and are billed once', () => {
  const terms = resolvePackageTerms({ durationHours: 4, price: 800, extraHourPrice: 150, includedKm: 40 });
  const ext = quoteRentalExtension({ terms, from: at(4), to: at(7) });
  assert.equal(ext.amount, 450);
  assert.equal(ext.includedKm, 30);

  // No extra-hour rate configured: the package's own hourly rate applies.
  const fallback = quoteRentalExtension({ terms: resolvePackageTerms({ durationHours: 4, price: 800 }), from: at(4), to: at(6) });
  assert.equal(fallback.amount, 400);

  const withDriver = quoteRentalExtension({ terms, from: at(4), to: at(6), driveMode: 'with_driver', withDriverSurcharge: { amount: 50, unit: 'per_hour' } });
  assert.equal(withDriver.amount, 300 + 100);

  const base = { selectedPackage: { durationHours: 4, price: 800, extraHourPrice: 150 }, assignedAt: T0, payableNow: 200 };
  const approved = { ...base, extensions: [{ from: at(4), to: at(7), amount: 450, status: 'approved' }] };
  const m1 = computeRentalBillingMetrics(approved, at(7));
  assert.equal(m1.extraTimeCharge, 0);
  assert.equal(m1.extensionsCharge, 450);
  assert.equal(m1.currentCharge, 1250);
  assert.equal(m1.remainingDue, 1050);

  // Late beyond the extension is overtime from the extended return.
  assert.equal(computeRentalBillingMetrics(approved, at(8)).extraTimeCharge, 150);

  const paid = { ...base, extensions: [{ from: at(4), to: at(7), amount: 450, status: 'paid' }] };
  assert.equal(computeRentalBillingMetrics(paid, at(7)).remainingDue, 1250 - 200 - 450);

  // A request that was never approved changes nothing.
  const requested = { ...base, extensions: [{ from: at(4), to: at(7), amount: 450, status: 'requested' }] };
  assert.equal(computeRentalBillingMetrics(requested, at(7)).currentCharge, 800 + 3 * 150);
  assert.equal(computeRentalBillingMetrics(requested, at(7)).extensionsCharge, 0);
});

test('additional (damage) charges add to the final charge', () => {
  const item = {
    selectedPackage: { durationHours: 4, price: 800 },
    assignedAt: T0,
    additionalCharges: [{ amount: 1200 }, { amount: 300 }],
  };
  assert.equal(computeRentalBillingMetrics(item, at(4)).currentCharge, 2300);
});

test('drive modes default to self-drive', () => {
  assert.deepEqual(normalizeDriveModes(undefined), ['self_drive']);
  assert.deepEqual(normalizeDriveModes([]), ['self_drive']);
  assert.deepEqual(normalizeDriveModes(['with_driver', 'bogus', 'with_driver']), ['with_driver']);
});

test('range overlap is half-open', () => {
  assert.equal(rangesOverlap(at(0), at(4), at(4), at(8)), false);
  assert.equal(rangesOverlap(at(0), at(5), at(4), at(8)), true);
  assert.equal(rangesOverlap(at(2), at(3), at(0), at(8)), true);
});

test('availability counts peak concurrency, not every overlap', () => {
  const units = [{ _id: 'u1' }, { _id: 'u2' }, { _id: 'u3', status: 'maintenance' }];
  const bookings = [
    { _id: 'b1', status: 'confirmed', pickupDateTime: at(0), returnDateTime: at(4) },
    { _id: 'b2', status: 'pending', pickupDateTime: at(4), returnDateTime: at(8) }, // back to back with b1
    { _id: 'b3', status: 'completed', pickupDateTime: at(0), returnDateTime: at(8) }, // not holding
    { _id: 'b4', status: 'cancelled', pickupDateTime: at(0), returnDateTime: at(8) },
  ];
  const a = computeAvailability({ units, bookings, from: at(0), to: at(8), now: at(-1) });
  assert.equal(a.usableUnits, 2);
  assert.equal(a.overlappingBookings, 2);
  assert.equal(a.peakConcurrent, 1);
  assert.equal(a.available, 1);
  assert.equal(a.isAvailable, true);

  const busy = computeAvailability({
    units,
    bookings: [...bookings, { _id: 'b5', status: 'assigned', pickupDateTime: at(2), returnDateTime: at(6) }],
    from: at(0),
    to: at(8),
    now: at(-1),
  });
  assert.equal(busy.peakConcurrent, 2);
  assert.equal(busy.available, 0);
  assert.equal(busy.isAvailable, false);

  // Excluding the booking being extended.
  const ex = computeAvailability({ units: [{ _id: 'u1' }], bookings: [bookings[0]], from: at(0), to: at(4), now: at(-1), excludeBookingId: 'b1' });
  assert.equal(ex.available, 1);
});

test('a car still out past its return time keeps holding', () => {
  const bookings = [{ _id: 'b1', status: 'assigned', pickupDateTime: at(0), returnDateTime: at(4) }];
  const a = computeAvailability({ units: [{ _id: 'u1' }], bookings, from: at(5), to: at(9), now: at(6) });
  assert.equal(a.available, 0);
  const b = computeAvailability({ units: [{ _id: 'u1' }], bookings: [{ ...bookings[0], status: 'confirmed' }], from: at(5), to: at(9), now: at(6) });
  assert.equal(b.available, 1);
});

test('max concurrency sweep', () => {
  const list = [
    { status: 'confirmed', pickupDateTime: at(0), returnDateTime: at(10) },
    { status: 'confirmed', pickupDateTime: at(1), returnDateTime: at(3) },
    { status: 'confirmed', pickupDateTime: at(2), returnDateTime: at(4) },
    { status: 'confirmed', pickupDateTime: at(4), returnDateTime: at(5) },
  ];
  assert.equal(maxConcurrentBookings(list, at(0), at(10), { now: at(-1) }), 3);
  assert.equal(maxConcurrentBookings(list, at(3.5), at(10), { now: at(-1) }), 2);
});

test('unit conflicts only consider that unit', () => {
  const bookings = [
    { _id: 'b1', status: 'assigned', assignedUnitId: 'u1', pickupDateTime: at(0), returnDateTime: at(4), bookingReference: 'R1' },
    { _id: 'b2', status: 'confirmed', assignedUnitId: 'u2', pickupDateTime: at(0), returnDateTime: at(4) },
  ];
  assert.equal(findUnitConflicts('u1', bookings, at(2), at(6), { now: at(-1) }).length, 1);
  assert.equal(findUnitConflicts('u1', bookings, at(4), at(6), { now: at(-1) }).length, 0);
  assert.equal(findUnitConflicts('u1', bookings, at(2), at(6), { now: at(-1), excludeBookingId: 'b1' }).length, 0);
  assert.equal(findUnitConflicts('u3', bookings, at(0), at(6), { now: at(-1) }).length, 0);
});

test('invoice lines itemize charges, deposit and balance', () => {
  const booking = {
    selectedPackage: { label: '8 Hours', durationHours: 8, price: 2000, extraHourPrice: 200, includedKm: 80, extraKmPrice: 10 },
    assignedAt: T0,
    billingEndedAt: at(9),
    billingTerms: { kmBillingEnabled: true },
    rentalInspection: { pickupMeterReading: 0, returnMeterReading: 100 },
    payableNow: 500,
    paymentStatus: 'paid',
    commissionSnapshot: { serviceTaxPercentage: 5 },
    extensions: [],
    additionalCharges: [{ type: 'damage', reason: 'Bumper', amount: 700 }],
    deposit: { required: true, amount: 3000, status: 'held', deductions: [{ reason: 'Scratch', amount: 1000 }] },
  };
  const lines = buildRentalInvoiceLines(booking);
  const byCode = Object.fromEntries(lines.charges.map((line) => [line.code, line.amount]));
  assert.equal(byCode.base_package, 2000);
  assert.equal(byCode.extra_time, 200);
  assert.equal(byCode.extra_km, 200);
  assert.equal(byCode.damage, 700);
  assert.equal(byCode.deposit_deduction, 1000);
  assert.equal(lines.subtotal, 4100);
  assert.equal(lines.tax.amount, 205);
  assert.equal(lines.total, 4305);
  assert.equal(lines.creditTotal, 500);
  assert.equal(lines.deposit.held, 2000);
  assert.equal(lines.balance, 4305 - 500 - 1000);
  assert.equal(depositBalance(booking.deposit), 2000);
});
