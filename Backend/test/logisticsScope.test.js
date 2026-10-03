import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeDwell, computeScanCompliance, computeSlaBreach, rankHubs, summarizeHubPerformance } from '../src/modules/taxi/logistics/services/hubMetrics.js';
import { listPickupSlots, localToUtc, parseSlot, resolvePickupWindow } from '../src/modules/taxi/logistics/services/pickupSlots.js';
import { detectShipmentScope, haversineKm, resolveFulfilment } from '../src/modules/taxi/logistics/services/scopeDetection.js';

const BLR = [77.5946, 12.9716];
const MYS = [76.6394, 12.2958]; // Mysuru, ~125km
const DEL = [77.209, 28.6139]; // Delhi, ~1740km

const zone = (id, city) => ({ _id: id, service_location_id: city });

describe('haversineKm', () => {
  it('is roughly right for known city pairs', () => {
    const blrMys = haversineKm(BLR, MYS);
    assert.ok(blrMys > 120 && blrMys < 135, String(blrMys));
    const blrDel = haversineKm(BLR, DEL);
    assert.ok(blrDel > 1700 && blrDel < 1780, String(blrDel));
    assert.equal(haversineKm([], BLR), 0);
  });
});

describe('detectShipmentScope', () => {
  it('same zone → intracity', () => {
    assert.equal(detectShipmentScope({ pickupZone: zone('z1', 'c1'), dropZone: zone('z1', 'c1'), distanceKm: 8 }).scope, 'intracity');
  });

  it('different zones in one city → intracity', () => {
    assert.deepEqual(detectShipmentScope({ pickupZone: zone('z1', 'c1'), dropZone: zone('z2', 'c1'), distanceKm: 18 }), {
      scope: 'intracity',
      reason: 'same_city',
    });
  });

  it('different cities within the intercity cap → intercity, even when close', () => {
    assert.equal(detectShipmentScope({ pickupZone: zone('z1', 'c1'), dropZone: zone('z9', 'c2'), distanceKm: 40 }).scope, 'intercity');
    assert.equal(detectShipmentScope({ pickupZone: zone('z1', 'c1'), dropZone: zone('z9', 'c2'), distanceKm: 400 }).scope, 'intercity');
  });

  it('beyond the intercity cap → long_distance', () => {
    assert.equal(detectShipmentScope({ pickupZone: zone('z1', 'c1'), dropZone: zone('z9', 'c3'), distanceKm: 401 }).scope, 'long_distance');
    assert.equal(detectShipmentScope({ distanceKm: 1740 }).scope, 'long_distance');
  });

  it('a zoneless end is judged on distance, like the direct parcel flow', () => {
    assert.equal(detectShipmentScope({ pickupZone: zone('z1', 'c1'), dropZone: null, distanceKm: 35 }).scope, 'intracity');
    assert.equal(detectShipmentScope({ pickupZone: null, dropZone: null, distanceKm: 60 }).scope, 'intracity');
    assert.equal(detectShipmentScope({ pickupZone: null, dropZone: null, distanceKm: 61 }).scope, 'intercity');
  });

  it('honours configured caps', () => {
    assert.equal(detectShipmentScope({ distanceKm: 30, intracityMaxKm: 25 }).scope, 'intercity');
    assert.equal(detectShipmentScope({ distanceKm: 300, intracityMaxKm: 25, intercityMaxKm: 250 }).scope, 'long_distance');
  });

  it('accepts populated or bare zone ids', () => {
    assert.equal(detectShipmentScope({ pickupZone: { _id: { _id: 'z1' } }, dropZone: { _id: 'z1' }, distanceKm: 3 }).scope, 'intracity');
  });
});

describe('resolveFulfilment', () => {
  it('intracity goes direct unless the admin or the app chooses hubs', () => {
    assert.equal(resolveFulfilment({ scope: 'intracity' }), 'direct');
    assert.equal(resolveFulfilment({ scope: 'intracity', intracityFulfilment: 'hub' }), 'hub');
    assert.equal(resolveFulfilment({ scope: 'intracity', forceHub: true }), 'hub');
  });
  it('everything else goes through hubs', () => {
    assert.equal(resolveFulfilment({ scope: 'intercity' }), 'hub');
    assert.equal(resolveFulfilment({ scope: 'long_distance', intracityFulfilment: 'direct' }), 'hub');
  });
});

describe('pickup slots', () => {
  const slots = ['09:00-12:00', '12:00-15:00', 'bad', '18:00-17:00'];
  const now = new Date('2026-10-03T05:00:00Z'); // 10:30 IST

  it('parses only well-formed forward slots', () => {
    assert.deepEqual(parseSlot('09:00-12:00'), { label: '09:00-12:00', startMinutes: 540, endMinutes: 720 });
    assert.equal(parseSlot('bad'), null);
    assert.equal(parseSlot('18:00-17:00'), null);
  });

  it('converts local slot times to UTC', () => {
    assert.equal(localToUtc('2026-10-03', 540, 330).toISOString(), '2026-10-03T03:30:00.000Z');
  });

  it('marks slots inside the lead time unavailable', () => {
    const today = listPickupSlots({ date: '2026-10-03', slots, now, leadMinutes: 60 });
    assert.equal(today.length, 2);
    assert.equal(today[0].available, false, '09:00 already started');
    assert.equal(today[1].available, true, '12:00 is 90 minutes away');
  });

  it('returns nothing outside the bookable window', () => {
    assert.deepEqual(listPickupSlots({ date: '2026-10-02', slots, now }), []);
    assert.deepEqual(listPickupSlots({ date: '2026-10-20', slots, now, daysAhead: 7 }), []);
  });

  it('resolvePickupWindow validates and returns UTC bounds', () => {
    const window = resolvePickupWindow({ date: '2026-10-04', slot: '09:00-12:00', slots, now });
    assert.equal(window.startsAt.toISOString(), '2026-10-04T03:30:00.000Z');
    assert.equal(window.endsAt.toISOString(), '2026-10-04T06:30:00.000Z');
    assert.throws(() => resolvePickupWindow({ date: '2026-10-03', slot: '09:00-12:00', slots, now }), /no longer available/);
    assert.throws(() => resolvePickupWindow({ date: '2026-10-04', slot: '07:00-08:00', slots, now }), /Unknown pickup slot/);
  });
});

describe('hub metrics', () => {
  const t = (hours) => new Date(Date.UTC(2026, 9, 1, hours)).toISOString();
  const events = [
    { shipmentId: 's1', hubId: 'h1', type: 'inbound', at: t(0) },
    { shipmentId: 's1', hubId: 'h1', type: 'outbound', at: t(4) },
    { shipmentId: 's2', hubId: 'h1', type: 'inbound', at: t(1) },
    { shipmentId: 's2', hubId: 'h1', type: 'out_for_delivery', at: t(11) },
    { shipmentId: 's2', hubId: 'h1', type: 'delivered', at: t(13) },
    { shipmentId: 's3', hubId: 'h1', type: 'inbound', at: t(2) }, // still on the shelf
    { shipmentId: 's4', hubId: 'h1', type: 'outbound', at: t(3) }, // never inbound-scanned
    { shipmentId: 's5', hubId: 'h1', type: 'failed', at: t(5) },
    { shipmentId: 's1', hubId: 'h2', type: 'inbound', at: t(9) }, // other hub, ignored
  ];

  it('dwell is first inbound to first departure, shelf parcels counted apart', () => {
    assert.deepEqual(computeDwell(events, 'h1'), { averageHours: 7, medianHours: 4, measured: 2, onShelf: 1 });
  });

  it('scan compliance counts departures that had an inbound first', () => {
    assert.deepEqual(computeScanCompliance(events, 'h1'), { departed: 3, compliant: 2, percent: 66.67 });
    assert.equal(computeScanCompliance([], 'h1').percent, 100);
  });

  it('SLA breach counts late deliveries and overdue undelivered parcels', () => {
    const now = new Date(t(48));
    const shipments = [
      { status: 'delivered', slaDueAt: t(24), deliveredAt: t(20) }, // on time
      { status: 'delivered', slaDueAt: t(24), deliveredAt: t(30) }, // late
      { status: 'in_transit', slaDueAt: t(40) }, // overdue
      { status: 'in_transit', slaDueAt: t(60) }, // not due yet: not measured
      { status: 'cancelled', slaDueAt: t(10) }, // not measured
      { status: 'booked' }, // no SLA: not measured
    ];
    assert.deepEqual(computeSlaBreach(shipments, now), { measured: 3, breached: 2, percent: 66.67 });
  });

  it('summary and ranking', () => {
    const summary = summarizeHubPerformance({ hubId: 'h1', events, shipments: [], now: new Date(t(48)) });
    assert.equal(summary.throughput.inbound, 3);
    assert.equal(summary.throughput.delivered, 1);
    assert.equal(summary.failedDeliveryPercent, 50);
    const ranked = rankHubs([
      { hubId: 'a', sla: { percent: 10 }, failedDeliveryPercent: 5, throughput: { inbound: 1, delivered: 1 } },
      { hubId: 'b', sla: { percent: 2 }, failedDeliveryPercent: 50, throughput: { inbound: 1, delivered: 1 } },
      { hubId: 'c', sla: { percent: 2 }, failedDeliveryPercent: 5, throughput: { inbound: 9, delivered: 9 } },
    ]);
    assert.deepEqual(ranked.map((row) => [row.rank, row.hubId]), [[1, 'c'], [2, 'b'], [3, 'a']]);
  });
});
