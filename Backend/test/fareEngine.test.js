import test from 'node:test';
import assert from 'node:assert/strict';

// The services import the app config, which insists on these at load time.
// Nothing here talks to Mongo; the values only let the modules load.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:1/fare-engine-test';
process.env.JWT_SECRET ||= 'fare-engine-test';

const {
  computeFareBreakdown,
  computePackageFare,
  hikeAppliesToBooking,
  isWithinDailyWindow,
  pickSurgeMultiplier,
} = await import('../src/modules/taxi/services/fareEngineService.js');
const { computePromoDiscount, normalizePromoDiscountType } = await import('../src/modules/taxi/services/promoService.js');
const {
  computeWaitingCharge,
  recordWaitingChargeInBreakdown,
} = await import('../src/modules/taxi/services/rideWaitingChargeService.js');
const { toLngLat } = await import('../src/modules/taxi/services/fareEstimateService.js');

const cityRule = {
  base_price: 50,
  base_distance: 2,
  price_per_distance: 12,
  time_price: 1,
  service_tax: 0,
};

// ── computeFareBreakdown ────────────────────────────────────────────────────

test('computeFareBreakdown: null without a pricing rule', () => {
  assert.equal(computeFareBreakdown({}), null);
});

test('computeFareBreakdown: inside the base distance pays the base price only', () => {
  const result = computeFareBreakdown({ pricingRule: cityRule, distanceMeters: 1500, durationMinutes: 30 });
  assert.equal(result.total, 50);
  assert.equal(result.distanceFare, 0);
  assert.equal(result.timeFare, 0);
  assert.equal(result.tariff, 'city');
});

test('computeFareBreakdown: beyond the base distance adds extra km and minutes', () => {
  // 10 km, 20 min: 50 + (8 * 12) + (20 * 1) = 166
  const result = computeFareBreakdown({ pricingRule: cityRule, distanceMeters: 10000, durationMinutes: 20 });
  assert.equal(result.distanceFare, 96);
  assert.equal(result.timeFare, 20);
  assert.equal(result.total, 166);
});

test('computeFareBreakdown: surge scales money terms only', () => {
  const result = computeFareBreakdown({
    pricingRule: cityRule, distanceMeters: 10000, durationMinutes: 20, surgeMultiplier: 1.5,
  });
  assert.equal(result.surgeMultiplier, 1.5);
  assert.equal(result.surgeAmount, 83);
  assert.equal(result.total, 249);
});

test('computeFareBreakdown: a multiplier below 1 is ignored', () => {
  const result = computeFareBreakdown({ pricingRule: cityRule, distanceMeters: 10000, durationMinutes: 20, surgeMultiplier: 0.5 });
  assert.equal(result.surgeMultiplier, 1);
  assert.equal(result.total, 166);
});

test('computeFareBreakdown: percentage night charge on the surged fare', () => {
  const result = computeFareBreakdown({
    pricingRule: { ...cityRule, night_charge: 10, night_charge_type: 'percentage' },
    distanceMeters: 10000,
    durationMinutes: 20,
    surgeMultiplier: 1.5,
    isNight: true,
  });
  assert.equal(result.nightCharge, 24.9);
  assert.equal(result.total, 274);
});

test('computeFareBreakdown: fixed night charge, and none in the day', () => {
  const rule = { ...cityRule, night_charge: 30, night_charge_type: 'fixed' };
  assert.equal(computeFareBreakdown({ pricingRule: rule, distanceMeters: 1000, isNight: true }).total, 80);
  assert.equal(computeFareBreakdown({ pricingRule: rule, distanceMeters: 1000, isNight: false }).total, 50);
});

test('computeFareBreakdown: minimum fare is a floor before tax', () => {
  const result = computeFareBreakdown({
    pricingRule: { ...cityRule, minimum_fare: 80, service_tax: 10 },
    distanceMeters: 1000,
  });
  assert.equal(result.minimumFareAdjustment, 30);
  assert.equal(result.subtotal, 80);
  assert.equal(result.tax, 8);
  assert.equal(result.total, 88);
});

test('computeFareBreakdown: intercity uses outstation rates when set, city rates otherwise', () => {
  const rule = {
    ...cityRule,
    outstation_base_price: 500,
    outstation_base_distance: 10,
    outstation_price_per_distance: 15,
    outstation_time_price: 0,
  };
  const outstation = computeFareBreakdown({ pricingRule: rule, distanceMeters: 100000, serviceType: 'intercity' });
  assert.equal(outstation.tariff, 'outstation');
  assert.equal(outstation.total, 500 + 90 * 15);

  const fallback = computeFareBreakdown({ pricingRule: cityRule, distanceMeters: 10000, durationMinutes: 20, serviceType: 'intercity' });
  assert.equal(fallback.tariff, 'city');
  assert.equal(fallback.total, 166);
});

test('computeFareBreakdown: total is rounded to whole rupees', () => {
  const result = computeFareBreakdown({ pricingRule: { ...cityRule, service_tax: 5 }, distanceMeters: 10000, durationMinutes: 20 });
  // 166 * 1.05 = 174.3
  assert.equal(result.total, 174);
});

// ── isWithinDailyWindow ─────────────────────────────────────────────────────

test('isWithinDailyWindow: plain window, end exclusive', () => {
  assert.equal(isWithinDailyWindow(9 * 60, '09:00', '17:00'), true);
  assert.equal(isWithinDailyWindow(17 * 60, '09:00', '17:00'), false);
  assert.equal(isWithinDailyWindow(8 * 60 + 59, '09:00', '17:00'), false);
});

test('isWithinDailyWindow: wraps past midnight', () => {
  assert.equal(isWithinDailyWindow(23 * 60, '22:00', '06:00'), true);
  assert.equal(isWithinDailyWindow(2 * 60, '22:00', '06:00'), true);
  assert.equal(isWithinDailyWindow(6 * 60, '22:00', '06:00'), false);
  assert.equal(isWithinDailyWindow(12 * 60, '22:00', '06:00'), false);
});

test('isWithinDailyWindow: empty or bad windows never match', () => {
  assert.equal(isWithinDailyWindow(600, '10:00', '10:00'), false);
  assert.equal(isWithinDailyWindow(600, 'bad', '11:00'), false);
  assert.equal(isWithinDailyWindow(600, '', ''), false);
});

// ── computePackageFare ──────────────────────────────────────────────────────

const packageRow = {
  _id: 'pkg1',
  package_vehicle_prices: [
    { vehicle_type: 'veh1', base_price: 2000 },
    { vehicle_type: 'veh2', base_price: 3000 },
  ],
};

test('computePackageFare: one way is the vehicle price', () => {
  const result = computePackageFare({ packageRow, vehicleTypeId: 'veh1', tripType: 'one_way' });
  assert.equal(result.total, 2000);
  assert.equal(result.tripType, 'one_way');
  assert.equal(result.packageId, 'pkg1');
});

test('computePackageFare: round trip applies the multiplier', () => {
  assert.equal(computePackageFare({ packageRow, vehicleTypeId: 'veh2', tripType: 'Round Trip' }).total, 5400);
  assert.equal(computePackageFare({ packageRow, vehicleTypeId: 'veh2', tripType: 'round_trip', roundTripMultiplier: 2 }).total, 6000);
  // A nonsense multiplier falls back to 1.8.
  assert.equal(computePackageFare({ packageRow, vehicleTypeId: 'veh1', tripType: 'round', roundTripMultiplier: 0 }).total, 3600);
});

test('computePackageFare: null for a vehicle not in the package', () => {
  assert.equal(computePackageFare({ packageRow, vehicleTypeId: 'veh9' }), null);
  assert.equal(computePackageFare({ packageRow: null, vehicleTypeId: 'veh1' }), null);
});

// ── surge rule ──────────────────────────────────────────────────────────────

test('pickSurgeMultiplier: highest hike vs zone peak, larger wins, never compounds', () => {
  assert.deepEqual(pickSurgeMultiplier({ hikeMultipliers: [1.2, 1.5], zonePeakPercent: 20 }), { multiplier: 1.5, source: 'price_hike' });
  assert.deepEqual(pickSurgeMultiplier({ hikeMultipliers: [1.1], zonePeakPercent: 30 }), { multiplier: 1.3, source: 'zone_peak' });
  assert.deepEqual(pickSurgeMultiplier({ hikeMultipliers: [], zonePeakPercent: 0 }), { multiplier: 1, source: 'none' });
  // A tie goes to the hike.
  assert.equal(pickSurgeMultiplier({ hikeMultipliers: [1.5], zonePeakPercent: 50 }).source, 'price_hike');
});

test('hikeAppliesToBooking: unscoped hikes are global', () => {
  assert.equal(hikeAppliesToBooking({}, { zoneId: 'z1', serviceLocationId: 'c1' }), true);
  assert.equal(hikeAppliesToBooking({ zone_ids: [], service_location_ids: [] }, {}), true);
});

test('hikeAppliesToBooking: scoped hikes match by city or zone', () => {
  const cityHike = { service_location_ids: ['c1'] };
  const zoneHike = { zone_ids: ['z1'] };
  assert.equal(hikeAppliesToBooking(cityHike, { zoneId: 'z9', serviceLocationId: 'c1' }), true);
  assert.equal(hikeAppliesToBooking(cityHike, { zoneId: 'z9', serviceLocationId: 'c2' }), false);
  assert.equal(hikeAppliesToBooking(zoneHike, { zoneId: 'z1', serviceLocationId: 'c2' }), true);
  assert.equal(hikeAppliesToBooking(zoneHike, { zoneId: null, serviceLocationId: 'c1' }), false);
});

// ── promo flat discount ─────────────────────────────────────────────────────

test('computePromoDiscount: percentage stays the default', () => {
  assert.equal(normalizePromoDiscountType(undefined), 'percentage');
  const result = computePromoDiscount({ fare: 200, promo: { discount_percentage: 10 } });
  assert.equal(result.discount_amount, 20);
  assert.equal(result.discount_type, 'percentage');
});

test('computePromoDiscount: flat amount, capped by fare and maximum', () => {
  assert.equal(computePromoDiscount({ fare: 200, promo: { discount_type: 'flat', discount_amount: 50 } }).discount_amount, 50);
  assert.equal(computePromoDiscount({ fare: 30, promo: { discount_type: 'flat', discount_amount: 50 } }).fare_after_discount, 0);
  assert.equal(
    computePromoDiscount({ fare: 200, promo: { discount_type: 'flat', discount_amount: 50, maximum_discount_amount: 40 } }).discount_amount,
    40,
  );
});

// ── waiting charge ──────────────────────────────────────────────────────────

test('computeWaitingCharge: free minutes, then per minute, capped', () => {
  const arrivedAt = new Date('2026-01-01T10:00:00Z');
  assert.equal(computeWaitingCharge({ arrivedAt, startedAt: new Date('2026-01-01T10:03:00Z'), perMinute: 2, freeMinutes: 5 }), null);
  const charged = computeWaitingCharge({ arrivedAt, startedAt: new Date('2026-01-01T10:12:30Z'), perMinute: 2, freeMinutes: 5 });
  assert.equal(charged.chargeableMinutes, 7);
  assert.equal(charged.charge, 14);
  const capped = computeWaitingCharge({ arrivedAt, startedAt: new Date('2026-01-01T15:00:00Z'), perMinute: 1, freeMinutes: 0 });
  assert.equal(capped.chargeableMinutes, 60);
  assert.equal(computeWaitingCharge({ arrivedAt, startedAt: new Date('2026-01-01T10:30:00Z'), perMinute: 0 }), null);
});

test('recordWaitingChargeInBreakdown: adds lines only when a breakdown exists', () => {
  const ride = { pricingSnapshot: { fare_breakdown: { total: 166 } } };
  recordWaitingChargeInBreakdown(ride, { chargeableMinutes: 7, charge: 14 });
  assert.equal(ride.pricingSnapshot.fare_breakdown.waitingCharge, 14);
  assert.equal(ride.pricingSnapshot.fare_breakdown.totalWithWaiting, 180);

  const bare = { pricingSnapshot: { fare_breakdown: null } };
  recordWaitingChargeInBreakdown(bare, { chargeableMinutes: 7, charge: 14 });
  assert.equal(bare.pricingSnapshot.fare_breakdown, null);
});

// ── estimate input ──────────────────────────────────────────────────────────

test('toLngLat: accepts [lng, lat], {lat, lng} and GeoJSON', () => {
  assert.deepEqual(toLngLat([77.59, 12.97], 'pickup'), [77.59, 12.97]);
  assert.deepEqual(toLngLat({ lat: 12.97, lng: 77.59 }, 'pickup'), [77.59, 12.97]);
  assert.deepEqual(toLngLat({ latitude: '12.97', longitude: '77.59' }, 'pickup'), [77.59, 12.97]);
  assert.deepEqual(toLngLat({ type: 'Point', coordinates: [77.59, 12.97] }, 'pickup'), [77.59, 12.97]);
  assert.throws(() => toLngLat('nope', 'pickup'));
});
