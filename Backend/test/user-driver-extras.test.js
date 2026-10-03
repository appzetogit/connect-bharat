import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDateRangeCondition,
  listIstDayKeys,
  parseDateRange,
  resolveNamedRange,
  toIstDayKey,
} from '../src/modules/taxi/services/dateRangeFilter.js';
import {
  MAX_USER_EMERGENCY_CONTACTS,
  enforceSingleDefault,
  nextRunningAverage,
  normalizeAddressInput,
  normalizeEmergencyContactInput,
  normalizeProfileInput,
  normalizeRatingInput,
  serializeAddress,
} from '../src/modules/taxi/user/services/userExtrasValidation.js';
import {
  buildIntercityDetails,
  buildInvoiceLineItems,
  buildParcelDetails,
} from '../src/modules/taxi/services/invoiceLineItems.js';
import {
  normalizeAutocomplete,
  normalizeGeocodeResults,
  normalizePlaceDetails,
} from '../src/modules/taxi/services/mapsProxyNormalize.js';
import { buildSosSmsText, locationLinkFor } from '../src/modules/taxi/safety/services/sosMessage.js';
import {
  buildExotelConnectRequest,
  isExotelConfigured,
  toE164,
} from '../src/modules/taxi/services/callMaskingService.js';
import { fillDailyBuckets, shapeEarningsTotals } from '../src/modules/taxi/driver/services/driverEarningsService.js';

const sum = (items) => Math.round(items.reduce((acc, item) => acc + item.amount, 0) * 100) / 100;

// --- date ranges --------------------------------------------------------------

test('a plain date is an IST calendar day, inclusive at both ends', () => {
  const { from, to } = parseDateRange({ from: '2026-10-01', to: '2026-10-03' });
  assert.equal(from.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(to.toISOString(), '2026-10-03T18:29:59.999Z');
});

test('no dates means no filter, so old history queries are unchanged', () => {
  assert.equal(buildDateRangeCondition({}), null);
  assert.deepEqual(Object.keys(buildDateRangeCondition({ from: '2026-10-01' })), ['$gte']);
});

test('bad or inverted dates are a 400', () => {
  assert.throws(() => parseDateRange({ from: 'yesterday' }), { statusCode: 400 });
  assert.throws(() => parseDateRange({ from: '2026-10-05', to: '2026-10-01' }), { statusCode: 400 });
});

test('week starts on Monday in IST, month on the 1st', () => {
  // Saturday 3 Oct 2026, 01:00 IST (still Friday in UTC).
  const now = new Date('2026-10-02T19:30:00.000Z');
  assert.equal(toIstDayKey(now), '2026-10-03');
  assert.equal(toIstDayKey(resolveNamedRange({ range: 'week', now }).from), '2026-09-28');
  assert.equal(toIstDayKey(resolveNamedRange({ range: 'month', now }).from), '2026-10-01');
  assert.equal(toIstDayKey(resolveNamedRange({ range: 'day', now }).from), '2026-10-03');
});

test('custom ranges need both ends and are capped', () => {
  assert.throws(() => resolveNamedRange({ range: 'custom', from: '2026-01-01' }), { statusCode: 400 });
  assert.throws(() => resolveNamedRange({ range: 'custom', from: '2026-01-01', to: '2026-12-31' }), { statusCode: 400 });
  assert.throws(() => resolveNamedRange({ range: 'year' }), { statusCode: 400 });
});

test('day keys are zero-filled across the range', () => {
  const { from, to } = parseDateRange({ from: '2026-10-01', to: '2026-10-03' });
  assert.deepEqual(listIstDayKeys(from, to), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

// --- addresses / profile / contacts ---------------------------------------------

test('address create needs street, city, state and coordinates', () => {
  const body = { label: 'work', street: '12 MG Road', city: 'Bengaluru', state: 'KA', lat: 12.97, lng: 77.59 };
  const address = normalizeAddressInput(body);
  assert.equal(address.label, 'Office');
  assert.deepEqual(address.location, { type: 'Point', coordinates: [77.59, 12.97] });
  assert.throws(() => normalizeAddressInput({ ...body, lat: undefined, lng: undefined }), { statusCode: 400 });
  assert.throws(() => normalizeAddressInput({ ...body, city: '' }), { statusCode: 400 });
  assert.throws(() => normalizeAddressInput({ ...body, label: 'Gym' }), { statusCode: 400 });
});

test('address update only returns fields that were sent', () => {
  assert.deepEqual(normalizeAddressInput({ street: 'New street' }, { partial: true }), { street: 'New street' });
});

test('exactly one default address', () => {
  const list = [{ _id: 'a', isDefault: false }, { _id: 'b', isDefault: true }, { _id: 'c', isDefault: true }];
  enforceSingleDefault(list);
  assert.deepEqual(list.map((a) => a.isDefault), [false, true, false]);
  enforceSingleDefault(list, 'c');
  assert.deepEqual(list.map((a) => a.isDefault), [false, false, true]);
  const none = [{ _id: 'x', isDefault: false }];
  enforceSingleDefault(none);
  assert.equal(none[0].isDefault, true);
});

test('serialized address exposes lat/lng', () => {
  const out = serializeAddress({ _id: 'a1', street: 's', location: { coordinates: [77.5, 12.9] } });
  assert.equal(out.lat, 12.9);
  assert.equal(out.lng, 77.5);
});

test('profile accepts gender and dates, rejects future and under-13', () => {
  const now = new Date('2026-10-03T00:00:00Z');
  const out = normalizeProfileInput({ gender: 'Prefer not to say', dateOfBirth: '1990-05-01', anniversary: '' }, { now });
  assert.equal(out.gender, 'prefer-not-to-say');
  assert.equal(out.dateOfBirth.toISOString().slice(0, 10), '1990-05-01');
  assert.equal(out.anniversary, null);
  assert.throws(() => normalizeProfileInput({ dateOfBirth: '2020-01-01' }, { now }), { statusCode: 400 });
  assert.throws(() => normalizeProfileInput({ anniversary: '2027-01-01' }, { now }), { statusCode: 400 });
  assert.throws(() => normalizeProfileInput({ gender: 'robot' }, { now }), { statusCode: 400 });
  assert.deepEqual(normalizeProfileInput({}, { now }), {});
});

test('emergency contacts: 10 digits, no duplicates, max 5', () => {
  const contact = normalizeEmergencyContactInput({ name: 'Asha', phone: '+91 98765 43210' }, []);
  assert.equal(contact.phone, '9876543210');
  assert.throws(() => normalizeEmergencyContactInput({ name: 'Asha', phone: '12345' }, []), { statusCode: 400 });
  assert.throws(() => normalizeEmergencyContactInput({ name: 'B', phone: '9876543210' }, [contact]), { statusCode: 409 });
  const full = Array.from({ length: MAX_USER_EMERGENCY_CONTACTS }, (_, i) => ({ phone: `900000000${i}` }));
  assert.throws(() => normalizeEmergencyContactInput({ name: 'C', phone: '9111111111' }, full), { statusCode: 400 });
});

test('rider rating is a 1-5 integer and averages without drift', () => {
  assert.throws(() => normalizeRatingInput({ rating: 6 }), { statusCode: 400 });
  assert.throws(() => normalizeRatingInput({ rating: 3.5 }), { statusCode: 400 });
  let state = { rating: 0, ratingCount: 0 };
  for (const r of [5, 4, 4, 1]) state = nextRunningAverage(state.rating, state.ratingCount, r);
  assert.equal(state.ratingCount, 4);
  assert.equal(state.rating, 3.5);
});

// --- invoice ------------------------------------------------------------------------

test('old rides without a breakdown keep the single Trip Fare line', () => {
  const result = buildInvoiceLineItems({ fare: 240 });
  assert.equal(result.itemised, false);
  assert.deepEqual(result.items.map((i) => i.key), ['trip_fare']);
  assert.equal(result.total, 240);
});

test('itemised invoice lists every component and sums to the fare charged', () => {
  const ride = {
    fare: 330,
    waitingCharge: 20,
    waitingMinutes: 4,
    promo: { code: 'SAVE10', discount_amount: 30 },
    pricingSnapshot: {
      rider_platform_fee: 10,
      fare_breakdown: {
        tariff: 'city',
        distanceKm: 8,
        baseDistanceKm: 2,
        pricePerKm: 20,
        durationMinutes: 20,
        baseFare: 50,
        distanceFare: 120,
        timeFare: 20,
        surgeMultiplier: 1.2,
        surgeAmount: 38,
        nightCharge: 10,
        minimumFareAdjustment: 0,
        serviceTaxPercent: 5,
        tax: 11.9,
        total: 250,
      },
    },
  };
  const result = buildInvoiceLineItems(ride);
  assert.equal(result.itemised, true);
  const keys = result.items.map((i) => i.key);
  for (const key of ['base_fare', 'distance_fare', 'time_fare', 'surge', 'night_charge', 'tax', 'waiting_charge', 'platform_fee', 'promo_discount']) {
    assert.ok(keys.includes(key), `missing ${key}`);
  }
  assert.equal(result.items.find((i) => i.key === 'promo_discount').amount, -30);
  assert.equal(sum(result.items), 330);
});

test('a bid or rounding gap becomes an explicit adjustment line', () => {
  const result = buildInvoiceLineItems({
    fare: 200,
    pricingSnapshot: { fare_breakdown: { baseFare: 100, distanceFare: 80, minimumFareAdjustment: 0, tax: 0 } },
  });
  assert.equal(result.items.at(-1).key, 'fare_adjustment');
  assert.equal(result.items.at(-1).amount, 20);
  assert.equal(sum(result.items), 200);
});

test('package outstation trip shows package and round-trip lines', () => {
  const result = buildInvoiceLineItems({
    fare: 1800,
    pricingSnapshot: { fare_breakdown: { tariff: 'package', baseFare: 1000, roundTripMultiplier: 1.8, subtotal: 1800, tax: 0 } },
  });
  assert.deepEqual(result.items.map((i) => i.key), ['package_fare', 'round_trip']);
  assert.equal(sum(result.items), 1800);
});

test('intercity and parcel details only for those rides', () => {
  assert.equal(buildIntercityDetails({ serviceType: 'ride' }), null);
  const intercity = buildIntercityDetails({ serviceType: 'intercity', intercity: { fromCity: 'Pune', toCity: 'Mumbai', tripType: 'round-trip' } });
  assert.equal(intercity.tripTypeLabel, 'Round trip');
  assert.equal(buildParcelDetails({ serviceType: 'ride' }), null);
  assert.equal(buildParcelDetails({ serviceType: 'parcel', parcel: { category: 'Documents', receiverName: 'R' } }).category, 'Documents');
});

// --- maps -----------------------------------------------------------------------------

test('geocode and places responses are normalised', () => {
  const geo = normalizeGeocodeResults({
    results: [{
      place_id: 'p1',
      formatted_address: 'MG Road, Bengaluru',
      geometry: { location: { lat: 12.9, lng: 77.6 } },
      address_components: [
        { long_name: 'Bengaluru', types: ['locality'] },
        { long_name: 'Karnataka', types: ['administrative_area_level_1'] },
        { long_name: '560001', types: ['postal_code'] },
      ],
    }],
  });
  assert.deepEqual(
    { city: geo.results[0].city, state: geo.results[0].state, zip: geo.results[0].zipCode, lat: geo.results[0].lat },
    { city: 'Bengaluru', state: 'Karnataka', zip: '560001', lat: 12.9 },
  );
  const auto = normalizeAutocomplete({ predictions: [{ place_id: 'p2', description: 'Airport', structured_formatting: { main_text: 'Airport', secondary_text: 'BLR' } }] });
  assert.equal(auto.predictions[0].secondaryText, 'BLR');
  assert.equal(normalizePlaceDetails({}), null);
});

// --- SOS ------------------------------------------------------------------------------

test('SOS SMS fills placeholders and links the location', () => {
  const link = locationLinkFor({ location: { coordinates: [77.5946, 12.9716] } });
  assert.equal(link, 'https://maps.google.com/?q=12.971600,77.594600');
  const text = buildSosSmsText({ template: '{name} needs help at {link}. Trip {trip}, {vehicle}', name: 'Asha', link, trip: 'T1', vehicle: '' });
  assert.equal(text, `Asha needs help at ${link}. Trip T1, -`);
});

// --- call masking ----------------------------------------------------------------

test('call masking: phones to E.164 and Exotel only when fully configured', () => {
  assert.equal(toE164('9876543210'), '+919876543210');
  assert.equal(toE164('09876543210'), '+919876543210');
  assert.equal(toE164('+44 7700 900123'), '+447700900123');
  assert.equal(isExotelConfigured({ enabled: '1', sid: 's', api_key: 'k', api_token: 't' }), false);
  assert.equal(isExotelConfigured({ enabled: '0', sid: 's', api_key: 'k', api_token: 't', caller_id: 'c' }), false);
  assert.equal(isExotelConfigured({ enabled: '1', sid: 's', api_key: 'k', api_token: 't', caller_id: 'c' }), true);
});

test('Exotel connect request targets the Connect API with basic auth', () => {
  const { url, init } = buildExotelConnectRequest({
    settings: { sid: 'acme', api_key: 'key', api_token: 'tok', caller_id: '08012345678', subdomain: 'api.in.exotel.com', time_limit: 600 },
    from: '+919876543210',
    to: '+919123456789',
  });
  assert.equal(url, 'https://api.in.exotel.com/v1/Accounts/acme/Calls/connect.json');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from('key:tok').toString('base64')}`);
  const body = new URLSearchParams(init.body);
  assert.equal(body.get('From'), '+919876543210');
  assert.equal(body.get('To'), '+919123456789');
  assert.equal(body.get('CallerId'), '08012345678');
  assert.equal(body.get('TimeLimit'), '600');
});

// --- earnings -------------------------------------------------------------------------

test('earnings totals shape commission and cash/online split', () => {
  const totals = shapeEarningsTotals({
    trips: 3, grossFare: 900, driverEarnings: 720, commission: 150, platformFee: 30, tips: 20,
    cashTrips: 2, cashFare: 600, onlineTrips: 1, onlineFare: 300, distanceMeters: 15500,
  });
  assert.equal(totals.netEarnings, 740);
  assert.equal(totals.commission.adminCommission, 150);
  assert.equal(totals.paymentSplit.cash.trips, 2);
  assert.equal(totals.distanceKm, 15.5);
  assert.equal(shapeEarningsTotals().trips, 0);
});

test('daily earnings buckets are zero-filled', () => {
  const { from, to } = parseDateRange({ from: '2026-10-01', to: '2026-10-03' });
  const days = fillDailyBuckets([{ _id: '2026-10-02', trips: 2, driverEarnings: 300 }], from, to);
  assert.deepEqual(days.map((d) => d.trips), [0, 2, 0]);
  assert.equal(days[1].netEarnings, 300);
});
