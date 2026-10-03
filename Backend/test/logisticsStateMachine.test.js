import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SHIPMENT_STATUS as S,
  SHIPMENT_STATUSES,
  SHIPMENT_TRANSITIONS,
  ShipmentTransitionError,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  getDisplayStatus,
  isCustomerCancellable,
  isCustomerReschedulable,
  resolveHubRole,
  resolveScanOutcome,
} from '../src/modules/taxi/logistics/services/shipmentStateMachine.js';

/// Walks a list of statuses, asserting each hop is legal.
const walk = (path) => {
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(assertTransition(path[index - 1], path[index]), path[index], `${path[index - 1]} → ${path[index]}`);
  }
};

describe('shipment state machine: table shape', () => {
  it('has an entry for every status and only targets known statuses', () => {
    for (const status of SHIPMENT_STATUSES) {
      assert.ok(Array.isArray(SHIPMENT_TRANSITIONS[status]), `missing row for ${status}`);
      for (const target of SHIPMENT_TRANSITIONS[status]) {
        assert.ok(SHIPMENT_STATUSES.includes(target), `${status} → unknown ${target}`);
        assert.notEqual(target, status, `${status} has a self transition`);
      }
    }
  });

  it('terminal statuses have no way out', () => {
    for (const status of TERMINAL_STATUSES) {
      assert.deepEqual(SHIPMENT_TRANSITIONS[status], []);
      for (const target of SHIPMENT_STATUSES) assert.equal(canTransition(status, target), false);
    }
  });

  it('every non-terminal status can eventually reach a terminal status', () => {
    for (const start of SHIPMENT_STATUSES) {
      const seen = new Set([start]);
      const queue = [start];
      let reachesEnd = TERMINAL_STATUSES.includes(start);
      while (queue.length && !reachesEnd) {
        for (const next of SHIPMENT_TRANSITIONS[queue.shift()]) {
          if (TERMINAL_STATUSES.includes(next)) reachesEnd = true;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      assert.ok(reachesEnd, `${start} can never finish`);
    }
  });

  it('every status is reachable from booked', () => {
    const seen = new Set([S.BOOKED]);
    const queue = [S.BOOKED];
    while (queue.length) {
      for (const next of SHIPMENT_TRANSITIONS[queue.shift()]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...SHIPMENT_STATUSES].sort());
  });
});

describe('shipment state machine: paths', () => {
  it('allows the full happy path', () => {
    walk([
      S.BOOKED,
      S.PICKUP_SCHEDULED,
      S.PICKED_UP,
      S.RECEIVED_AT_ORIGIN_HUB,
      S.IN_TRANSIT,
      S.RECEIVED_AT_DESTINATION_HUB,
      S.OUT_FOR_DELIVERY,
      S.DELIVERED,
    ]);
  });

  it('allows a walk-in drop at the hub and single-hub delivery', () => {
    walk([S.BOOKED, S.RECEIVED_AT_ORIGIN_HUB, S.OUT_FOR_DELIVERY, S.DELIVERED]);
  });

  it('allows failed → reattempt → out for delivery, repeatedly', () => {
    walk([
      S.OUT_FOR_DELIVERY,
      S.DELIVERY_FAILED,
      S.REATTEMPT_SCHEDULED,
      S.OUT_FOR_DELIVERY,
      S.DELIVERY_FAILED,
      S.REATTEMPT_SCHEDULED,
      S.OUT_FOR_DELIVERY,
      S.DELIVERED,
    ]);
  });

  it('allows the RTO branch', () => {
    walk([S.OUT_FOR_DELIVERY, S.DELIVERY_FAILED, S.RTO_INITIATED, S.RTO_IN_TRANSIT, S.RTO_DELIVERED]);
    walk([S.RECEIVED_AT_DESTINATION_HUB, S.RTO_INITIATED]);
    walk([S.RECEIVED_AT_ORIGIN_HUB, S.RTO_INITIATED, S.RTO_DELIVERED]);
  });

  it('lets a cancelled pickup ride put the shipment back to booked', () => {
    walk([S.BOOKED, S.PICKUP_SCHEDULED, S.BOOKED, S.PICKUP_SCHEDULED, S.PICKED_UP]);
  });

  it('allows cancellation only before pickup', () => {
    assert.ok(canTransition(S.BOOKED, S.CANCELLED));
    assert.ok(canTransition(S.PICKUP_SCHEDULED, S.CANCELLED));
    for (const status of [S.PICKED_UP, S.RECEIVED_AT_ORIGIN_HUB, S.IN_TRANSIT, S.OUT_FOR_DELIVERY, S.DELIVERY_FAILED]) {
      assert.equal(canTransition(status, S.CANCELLED), false, status);
    }
    assert.ok(isCustomerCancellable(S.BOOKED));
    assert.ok(isCustomerCancellable(S.PICKUP_SCHEDULED));
    assert.equal(isCustomerCancellable(S.PICKED_UP), false);
  });

  it('lets lost/damaged happen anywhere the parcel is in custody', () => {
    for (const status of [S.PICKED_UP, S.RECEIVED_AT_ORIGIN_HUB, S.IN_TRANSIT, S.RECEIVED_AT_DESTINATION_HUB, S.OUT_FOR_DELIVERY, S.RTO_IN_TRANSIT]) {
      assert.ok(canTransition(status, S.LOST), `${status} → lost`);
      assert.ok(canTransition(status, S.DAMAGED), `${status} → damaged`);
    }
    // Not in custody yet: nothing to lose.
    assert.equal(canTransition(S.BOOKED, S.LOST), false);
    walk([S.IN_TRANSIT, S.DAMAGED, S.OUT_FOR_DELIVERY, S.DELIVERED]);
    walk([S.IN_TRANSIT, S.DAMAGED, S.RTO_INITIATED]);
  });

  it('refuses skips and reversals', () => {
    const illegal = [
      [S.BOOKED, S.DELIVERED],
      [S.BOOKED, S.IN_TRANSIT],
      [S.PICKED_UP, S.IN_TRANSIT],
      [S.IN_TRANSIT, S.OUT_FOR_DELIVERY],
      [S.IN_TRANSIT, S.RECEIVED_AT_ORIGIN_HUB],
      [S.DELIVERY_FAILED, S.OUT_FOR_DELIVERY],
      [S.DELIVERY_FAILED, S.DELIVERED],
      [S.RTO_IN_TRANSIT, S.DELIVERED],
      [S.DELIVERED, S.DELIVERY_FAILED],
      [S.CANCELLED, S.BOOKED],
    ];
    for (const [from, to] of illegal) {
      assert.equal(canTransition(from, to), false, `${from} → ${to}`);
      assert.throws(() => assertTransition(from, to), ShipmentTransitionError);
    }
  });

  it('rejects unknown statuses with a 409-style error', () => {
    assert.throws(() => assertTransition(S.BOOKED, 'teleported'), (error) => error instanceof ShipmentTransitionError && error.statusCode === 409);
    assert.equal(canTransition('nonsense', S.BOOKED), false);
  });

  it('allows customer reschedule only after a failed attempt', () => {
    assert.ok(isCustomerReschedulable(S.DELIVERY_FAILED));
    assert.equal(isCustomerReschedulable(S.OUT_FOR_DELIVERY), false);
  });
});

describe('shipment state machine: display status', () => {
  it('maps onto the SOW labels', () => {
    assert.equal(getDisplayStatus(S.RECEIVED_AT_ORIGIN_HUB), 'Received');
    assert.equal(getDisplayStatus(S.RECEIVED_AT_DESTINATION_HUB), 'Received');
    assert.equal(getDisplayStatus(S.IN_TRANSIT), 'In Transit');
    assert.equal(getDisplayStatus(S.OUT_FOR_DELIVERY), 'Out for Delivery');
    assert.equal(getDisplayStatus(S.DELIVERED), 'Delivered');
    assert.equal(getDisplayStatus(S.REATTEMPT_SCHEDULED), 'Rescheduled');
  });

  it('has a label for every status', () => {
    for (const status of SHIPMENT_STATUSES) assert.notEqual(getDisplayStatus(status), 'Unknown', status);
    assert.equal(getDisplayStatus('nope'), 'Unknown');
  });
});

describe('resolveHubRole', () => {
  it('identifies origin, destination, both and transit', () => {
    assert.equal(resolveHubRole({ hubId: 'a', originHubId: 'a', destinationHubId: 'b' }), 'origin');
    assert.equal(resolveHubRole({ hubId: 'b', originHubId: 'a', destinationHubId: 'b' }), 'destination');
    assert.equal(resolveHubRole({ hubId: 'a', originHubId: 'a', destinationHubId: 'a' }), 'both');
    assert.equal(resolveHubRole({ hubId: 'c', originHubId: 'a', destinationHubId: 'b' }), 'transit');
  });
});

describe('resolveScanOutcome', () => {
  const scan = (status, scanType, hubRole = 'transit', exceptionType) => resolveScanOutcome({ status, scanType, hubRole, exceptionType });

  it('inbound at the origin receives a picked-up or walk-in parcel', () => {
    assert.deepEqual(scan(S.PICKED_UP, 'inbound', 'origin'), { allowed: true, nextStatus: S.RECEIVED_AT_ORIGIN_HUB });
    assert.deepEqual(scan(S.BOOKED, 'inbound', 'origin'), { allowed: true, nextStatus: S.RECEIVED_AT_ORIGIN_HUB });
    assert.equal(scan(S.PICKED_UP, 'inbound', 'destination').allowed, false);
  });

  it('inbound of an in-transit parcel: destination receives, transit only logs', () => {
    assert.deepEqual(scan(S.IN_TRANSIT, 'inbound', 'destination'), { allowed: true, nextStatus: S.RECEIVED_AT_DESTINATION_HUB });
    assert.deepEqual(scan(S.IN_TRANSIT, 'inbound', 'transit'), { allowed: true, nextStatus: null });
  });

  it('inbound twice is refused', () => {
    assert.equal(scan(S.RECEIVED_AT_ORIGIN_HUB, 'inbound', 'origin').allowed, false);
    assert.equal(scan(S.RECEIVED_AT_DESTINATION_HUB, 'inbound', 'destination').allowed, false);
  });

  it('inbound of a returning or failed parcel logs without a status change', () => {
    for (const status of [S.DELIVERY_FAILED, S.RTO_IN_TRANSIT, S.RTO_INITIATED]) {
      assert.deepEqual(scan(status, 'inbound', 'origin'), { allowed: true, nextStatus: null });
    }
  });

  it('outbound sends origin parcels in transit and RTO parcels home', () => {
    assert.deepEqual(scan(S.RECEIVED_AT_ORIGIN_HUB, 'outbound', 'origin'), { allowed: true, nextStatus: S.IN_TRANSIT });
    assert.deepEqual(scan(S.IN_TRANSIT, 'outbound', 'transit'), { allowed: true, nextStatus: null });
    assert.deepEqual(scan(S.RTO_INITIATED, 'outbound', 'destination'), { allowed: true, nextStatus: S.RTO_IN_TRANSIT });
    assert.equal(scan(S.RECEIVED_AT_DESTINATION_HUB, 'outbound', 'destination').allowed, false);
  });

  it('manifest scans never change status and need a hub-held parcel', () => {
    assert.deepEqual(scan(S.RECEIVED_AT_ORIGIN_HUB, 'manifest_add', 'origin'), { allowed: true, nextStatus: null });
    assert.deepEqual(scan(S.IN_TRANSIT, 'manifest_remove', 'transit'), { allowed: true, nextStatus: null });
    assert.equal(scan(S.OUT_FOR_DELIVERY, 'manifest_add', 'destination').allowed, false);
    assert.equal(scan(S.BOOKED, 'manifest_add', 'origin').allowed, false);
  });

  it('out for delivery from the destination, or from origin only for single-hub routing', () => {
    assert.deepEqual(scan(S.RECEIVED_AT_DESTINATION_HUB, 'out_for_delivery', 'destination'), { allowed: true, nextStatus: S.OUT_FOR_DELIVERY });
    assert.deepEqual(scan(S.REATTEMPT_SCHEDULED, 'out_for_delivery', 'destination'), { allowed: true, nextStatus: S.OUT_FOR_DELIVERY });
    assert.deepEqual(scan(S.RECEIVED_AT_ORIGIN_HUB, 'out_for_delivery', 'both'), { allowed: true, nextStatus: S.OUT_FOR_DELIVERY });
    assert.equal(scan(S.RECEIVED_AT_ORIGIN_HUB, 'out_for_delivery', 'origin').allowed, false);
    assert.equal(scan(S.IN_TRANSIT, 'out_for_delivery', 'destination').allowed, false);
  });

  it('delivered: receiver for a delivery run, sender (at origin) for an RTO', () => {
    assert.deepEqual(scan(S.OUT_FOR_DELIVERY, 'delivered', 'destination'), { allowed: true, nextStatus: S.DELIVERED });
    assert.deepEqual(scan(S.RTO_IN_TRANSIT, 'delivered', 'origin'), { allowed: true, nextStatus: S.RTO_DELIVERED });
    assert.equal(scan(S.RTO_IN_TRANSIT, 'delivered', 'destination').allowed, false);
    assert.equal(scan(S.RECEIVED_AT_DESTINATION_HUB, 'delivered', 'destination').allowed, false);
  });

  it('failed and rto follow the table', () => {
    assert.deepEqual(scan(S.OUT_FOR_DELIVERY, 'failed', 'destination'), { allowed: true, nextStatus: S.DELIVERY_FAILED });
    assert.equal(scan(S.RECEIVED_AT_DESTINATION_HUB, 'failed', 'destination').allowed, false);
    assert.deepEqual(scan(S.DELIVERY_FAILED, 'rto', 'destination'), { allowed: true, nextStatus: S.RTO_INITIATED });
    assert.equal(scan(S.IN_TRANSIT, 'rto', 'transit').allowed, false);
  });

  it('exception needs lost or damaged', () => {
    assert.deepEqual(scan(S.IN_TRANSIT, 'exception', 'transit', 'damaged'), { allowed: true, nextStatus: S.DAMAGED });
    assert.deepEqual(scan(S.IN_TRANSIT, 'exception', 'transit', 'LOST'), { allowed: true, nextStatus: S.LOST });
    assert.equal(scan(S.IN_TRANSIT, 'exception', 'transit', 'stolen').allowed, false);
    assert.equal(scan(S.BOOKED, 'exception', 'origin', 'lost').allowed, false);
  });

  it('refuses anything on a finished shipment and unknown scan types', () => {
    for (const status of TERMINAL_STATUSES) assert.equal(scan(status, 'inbound', 'origin').allowed, false);
    assert.equal(scan(S.BOOKED, 'teleport', 'origin').allowed, false);
  });
});
