import test from 'node:test';
import assert from 'node:assert/strict';

// outstationFare.js reaches config/env.js through the fare engine's model
// imports. Nothing here touches a database; env.js only insists the variables
// exist.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/outstation-test';
process.env.JWT_SECRET ||= 'outstation-test-secret';

const {
  advancePaidAmount,
  buildOutstationInvoiceLines,
  computeAdvanceAmount,
  computeOutstationFare,
  computeOutstationFinalFare,
  countCalendarDays,
  gpsTrailDistanceKm,
  normalizeOutstationTripFields,
  normalizeTripType,
  resolveActualDistance,
} = await import('../src/modules/taxi/outstation/services/outstationFare.js');

// 100 base covers the first 10 km, then 12/km. No time price, no tax unless set.
const rule = (overrides = {}) => ({
  outstation_base_price: 100,
  outstation_base_distance: 10,
  outstation_price_per_distance: 12,
  outstation_time_price: 0,
  service_tax: 0,
  minimum_fare: 0,
  ...overrides,
});

test('trip types: codes, legacy labels and junk', () => {
  assert.equal(normalizeTripType('One Way'), 'one_way');
  assert.equal(normalizeTripType('Round Trip'), 'round_trip');
  assert.equal(normalizeTripType('round_trip'), 'round_trip');
  assert.equal(normalizeTripType('multi-day'), 'multi_day');
  assert.equal(normalizeTripType('Multi Day'), 'multi_day');
  assert.equal(normalizeTripType(''), 'one_way');
  assert.equal(normalizeTripType(undefined), 'one_way');
  assert.equal(normalizeTripType('helicopter'), null);
});

test('trip fields: days from returnAt on the IST calendar, validation', () => {
  const fields = normalizeOutstationTripFields({
    tripType: 'Round Trip',
    travelDate: '2026-10-05T04:30:00.000Z', // 10:00 IST
    returnAt: '2026-10-07T13:30:00.000Z', // 19:00 IST
  });
  assert.equal(fields.tripType, 'round_trip');
  assert.equal(fields.tripTypeLabel, 'Round Trip');
  assert.equal(fields.days, 3);

  // 23:00 IST to 01:00 IST next day is two calendar days.
  assert.equal(countCalendarDays('2026-10-05T17:30:00.000Z', '2026-10-05T19:30:00.000Z'), 2);
  assert.equal(countCalendarDays('2026-10-05T04:30:00.000Z', '2026-10-05T10:30:00.000Z'), 1);

  assert.throws(() => normalizeOutstationTripFields({ tripType: 'multi_day' }), /multi_day/);
  assert.throws(() => normalizeOutstationTripFields({ tripType: 'helicopter' }), /tripType/);
  assert.throws(
    () => normalizeOutstationTripFields({ tripType: 'round_trip', travelDate: '2026-10-05', returnAt: '2026-10-01' }),
    /returnAt/,
  );
  assert.equal(normalizeOutstationTripFields({ tripType: 'multi_day', days: 4 }).days, 4);
  // A one-way trip is always one day whatever the app says.
  assert.equal(normalizeOutstationTripFields({ tripType: 'one_way', days: 4 }).days, 1);
  // A non-intercity ride's empty sub-document stays empty.
  assert.equal(normalizeOutstationTripFields({}).tripType, '');
});

test('one way with no new rates prices exactly like the fare engine', () => {
  const fare = computeOutstationFare({ pricingRule: rule(), tripType: 'one_way', distanceMeters: 150000 });
  // 100 + (150 - 10) * 12 = 1780
  assert.equal(fare.total, 1780);
  assert.equal(fare.billableKm, 150);
  assert.equal(fare.allowancesTotal, 0);
  assert.equal(fare.tariff, 'outstation');
});

test('round trip prices out and back', () => {
  const fare = computeOutstationFare({ pricingRule: rule(), tripType: 'round_trip', days: 1, distanceMeters: 150000 });
  // 300 km: 100 + 290 * 12 = 3580
  assert.equal(fare.tripKm, 300);
  assert.equal(fare.total, 3580);
});

test('multi-day applies the per-day minimum km and allowances', () => {
  const pricingRule = rule({
    outstation_min_km_per_day: 250,
    outstation_driver_allowance_per_day: 300,
    outstation_night_allowance_per_night: 200,
  });
  const fare = computeOutstationFare({ pricingRule, tripType: 'multi_day', days: 3, distanceMeters: 150000 });
  // Driven 300 km, but 3 days x 250 = 750 km minimum.
  assert.equal(fare.billableKm, 750);
  assert.equal(fare.tripFare, 100 + (750 - 10) * 12); // 8980
  assert.equal(fare.driverAllowance, 900);
  assert.equal(fare.nightAllowance, 400); // 2 nights
  assert.equal(fare.total, 8980 + 900 + 400);

  // When the road is longer than the minimum, the road wins.
  const long = computeOutstationFare({ pricingRule, tripType: 'multi_day', days: 2, distanceMeters: 400000 });
  assert.equal(long.billableKm, 800);
});

test('the per-day minimum never applies to a one-way trip', () => {
  const fare = computeOutstationFare({
    pricingRule: rule({ outstation_min_km_per_day: 250, outstation_driver_allowance_per_day: 300 }),
    tripType: 'one_way',
    distanceMeters: 100000,
  });
  assert.equal(fare.billableKm, 100);
  assert.equal(fare.driverAllowance, 300); // one day
  assert.equal(fare.nightAllowance, 0);
});

test('allowances are not taxed; the trip fare is', () => {
  const fare = computeOutstationFare({
    pricingRule: rule({ service_tax: 5, outstation_driver_allowance_per_day: 300 }),
    tripType: 'one_way',
    distanceMeters: 110000, // 100 + 100 * 12 = 1300, +5% = 1365
  });
  assert.equal(fare.tripFare, 1365);
  assert.equal(fare.total, 1665);
});

test('advance: none, percentage, fixed capped at the fare', () => {
  assert.equal(computeAdvanceAmount({ type: 'none', value: 20, fare: 1000 }), 0);
  assert.equal(computeAdvanceAmount({ type: 'percentage', value: 20, fare: 1785 }), 357);
  assert.equal(computeAdvanceAmount({ type: 'percentage', value: 150, fare: 1000 }), 1000);
  assert.equal(computeAdvanceAmount({ type: 'fixed', value: 500, fare: 1000 }), 500);
  assert.equal(computeAdvanceAmount({ type: 'fixed', value: 5000, fare: 1000 }), 1000);
  assert.equal(computeAdvanceAmount({ type: 'fixed', value: 500, fare: 0 }), 0);
  assert.equal(advancePaidAmount({ advance: { status: 'paid', amount: 300 } }), 300);
  assert.equal(advancePaidAmount({ advance: { status: 'pending', amount: 300 } }), 0);
});

test('actual distance: odometer, then GPS, then estimate', () => {
  assert.deepEqual(
    resolveActualDistance({ odometer: { startReading: 1000, endReading: 1320 }, gpsKm: 310, estimatedKm: 300 }),
    { km: 320, source: 'odometer' },
  );
  // A reversed or absurd odometer pair is ignored.
  assert.equal(resolveActualDistance({ odometer: { startReading: 1320, endReading: 1000 }, gpsKm: 310 }).source, 'gps');
  assert.equal(resolveActualDistance({ odometer: { startReading: 0, endReading: 99999 }, gpsKm: 0, estimatedKm: 300 }).source, 'estimate');
  assert.equal(resolveActualDistance({ odometer: {}, gpsKm: 0, estimatedKm: 300 }).km, 300);
});

test('GPS trail skips teleporting fixes', () => {
  const t0 = Date.parse('2026-10-05T05:00:00Z');
  const points = [
    { coordinates: [75.8577, 22.7196], at: new Date(t0) },
    { coordinates: [75.8577, 22.8096], at: new Date(t0 + 10 * 60000) }, // ~10 km in 10 min
    { coordinates: [80.0, 26.0], at: new Date(t0 + 11 * 60000) }, // hundreds of km in a minute
    { coordinates: [75.8577, 22.8996], at: new Date(t0 + 20 * 60000) }, // back on the road
  ];
  const km = gpsTrailDistanceKm(points);
  assert.ok(km > 9.9 && km < 10.1, `expected ~10 km, got ${km}`);
});

const bookedRoundTrip = () => computeOutstationFare({
  pricingRule: rule({
    outstation_time_price: 1,
    outstation_min_km_per_day: 250,
    outstation_driver_allowance_per_day: 300,
    outstation_night_allowance_per_night: 200,
    service_tax: 5,
  }),
  tripType: 'round_trip',
  days: 2,
  distanceMeters: 300000, // 600 km out and back, above the 500 km minimum
  durationMinutes: 300,
});

test('final fare: a trip that ran as booked costs the booked fare', () => {
  const booked = bookedRoundTrip();
  const result = computeOutstationFinalFare({
    bookedFare: booked.total,
    booked,
    actual: { distanceKm: 590, distanceSource: 'odometer', durationMinutes: 2000, days: 2, waitingMinutes: 5 },
  });
  assert.equal(result.finalFare, booked.total);
  assert.equal(result.extraKm, 0);
  // Multi-day: the clock includes nights, so no extra time is charged.
  assert.equal(result.extraTimeCharge, 0);
});

test('final fare: extra km, an extra day, tolls and state tax', () => {
  const booked = bookedRoundTrip();
  const result = computeOutstationFinalFare({
    bookedFare: booked.total,
    booked,
    actual: { distanceKm: 820, distanceSource: 'odometer', durationMinutes: 3000, days: 3 },
    expenses: [
      { type: 'toll', amount: 450 },
      { type: 'parking', amount: 50 },
      { type: 'state_tax', amount: 800 },
    ],
  });
  // 3 days x 250 = 750 km floor; 820 driven; booked 600 -> 220 extra km.
  assert.equal(result.extraKm, 220);
  assert.equal(result.extraKmCharge, 220 * 12);
  assert.equal(result.extraDays, 1);
  assert.equal(result.allowances, 500);
  assert.equal(result.tollsTotal, 500);
  assert.equal(result.stateTaxes, 800);
  assert.equal(result.taxOnExtras, (220 * 12 * 5) / 100);
  assert.equal(result.finalFare, Math.round(booked.total + 2640 + 132 + 500 + 500 + 800));
});

test('final fare: the per-day floor for the extra day applies even on a short road', () => {
  const booked = bookedRoundTrip();
  const result = computeOutstationFinalFare({
    bookedFare: booked.total,
    booked,
    actual: { distanceKm: 600, durationMinutes: 3000, days: 3 },
  });
  // 750 km floor for 3 days against 600 booked.
  assert.equal(result.extraKm, 150);
});

test('final fare: single-day trip pays extra time and waiting', () => {
  const booked = computeOutstationFare({
    pricingRule: rule({ outstation_time_price: 2, waiting_charge: 3, free_waiting_before: 10 }),
    tripType: 'one_way',
    distanceMeters: 150000,
    durationMinutes: 180,
  });
  const result = computeOutstationFinalFare({
    bookedFare: booked.total,
    booked,
    actual: { distanceKm: 150, durationMinutes: 240, days: 1, waitingMinutes: 25 },
    waiting: { perMinute: 3, freeMinutes: 10 },
  });
  assert.equal(result.extraTimeMinutes, 60);
  assert.equal(result.extraTimeCharge, 120);
  assert.equal(result.waitingMinutes, 15);
  assert.equal(result.waitingCharge, 45);
  assert.equal(result.finalFare, booked.total + 165);
});

test('final fare: never below the booked fare, and safe without locked rates', () => {
  const booked = bookedRoundTrip();
  const shorter = computeOutstationFinalFare({
    bookedFare: booked.total,
    booked,
    actual: { distanceKm: 100, durationMinutes: 60, days: 1 },
  });
  assert.equal(shorter.finalFare, booked.total);

  // A package trip has no per-km rates; only tolls are added.
  const packageTrip = computeOutstationFinalFare({
    bookedFare: 2500,
    booked: { tariff: 'package', total: 2500 },
    actual: { distanceKm: 900, days: 1 },
    expenses: [{ type: 'toll', amount: 300 }],
  });
  assert.equal(packageTrip.extraKm, 0);
  assert.equal(packageTrip.finalFare, 2800);
});

test('invoice lines: base, allowances, extras, advance and balance', () => {
  const booked = bookedRoundTrip();
  const adjustment = computeOutstationFinalFare({
    bookedFare: booked.total,
    booked,
    actual: { distanceKm: 700, days: 2 },
    expenses: [{ type: 'toll', amount: 450 }],
  });
  const ride = {
    serviceType: 'intercity',
    fare: adjustment.finalFare,
    advance: { status: 'paid', amount: 1000 },
    fareAdjustment: { ...adjustment, applied: true, computedAt: new Date(), bookedBreakdown: booked },
  };
  const lines = buildOutstationInvoiceLines(ride);
  const byLabel = Object.fromEntries(lines.map((line) => [line.label.replace(/ \(.*\)$/, ''), line.amount]));
  assert.equal(byLabel['Round Trip fare'], booked.tripFare);
  assert.equal(byLabel['Driver allowance'], 600);
  assert.equal(byLabel['Night allowance'], 200);
  assert.equal(byLabel['Extra km'], 100 * 12);
  assert.equal(byLabel['Tolls, parking and permits'], 450);
  assert.equal(byLabel['Total fare'], adjustment.finalFare);
  assert.equal(byLabel['Advance paid'], -1000);
  assert.equal(byLabel.Balance, adjustment.finalFare - 1000);
  assert.deepEqual(buildOutstationInvoiceLines({ serviceType: 'ride', fare: 100 }), []);
});
