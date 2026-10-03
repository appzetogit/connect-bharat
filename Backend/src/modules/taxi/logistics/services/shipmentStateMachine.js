/// The shipment status machine, as a pure transition table.
///
/// Everything that moves a shipment (a hub scan, a manifest dispatch, a
/// driver completing a leg ride, a customer cancelling) goes through
/// `assertTransition`, so an illegal jump such as booked → delivered is
/// refused in one place rather than being re-checked ad hoc in every
/// controller. Nothing here touches the database, which is what lets the
/// table be unit-tested exhaustively.
///
/// Happy path:
///   booked → pickup_scheduled → picked_up → received_at_origin_hub
///     → in_transit → received_at_destination_hub → out_for_delivery → delivered
/// Failure branches:
///   out_for_delivery → delivery_failed → reattempt_scheduled → out_for_delivery
///   … → rto_initiated → rto_in_transit → rto_delivered
/// Plus cancelled (before pickup only) and the lost / damaged exceptions.

export const SHIPMENT_STATUS = Object.freeze({
  BOOKED: 'booked',
  PICKUP_SCHEDULED: 'pickup_scheduled',
  PICKED_UP: 'picked_up',
  RECEIVED_AT_ORIGIN_HUB: 'received_at_origin_hub',
  IN_TRANSIT: 'in_transit',
  RECEIVED_AT_DESTINATION_HUB: 'received_at_destination_hub',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  DELIVERY_FAILED: 'delivery_failed',
  REATTEMPT_SCHEDULED: 'reattempt_scheduled',
  RTO_INITIATED: 'rto_initiated',
  RTO_IN_TRANSIT: 'rto_in_transit',
  RTO_DELIVERED: 'rto_delivered',
  CANCELLED: 'cancelled',
  LOST: 'lost',
  DAMAGED: 'damaged',
});

const S = SHIPMENT_STATUS;

export const SHIPMENT_STATUSES = Object.freeze(Object.values(S));

/// Lost and damaged are reachable from any state where the parcel is in the
/// network's custody. Kept as a list so the table below stays readable.
const CUSTODY_EXCEPTIONS = [S.LOST, S.DAMAGED];

export const SHIPMENT_TRANSITIONS = Object.freeze({
  // A walk-in sender who drops the parcel at the hub skips the pickup legs,
  // hence booked → received_at_origin_hub.
  [S.BOOKED]: [S.PICKUP_SCHEDULED, S.PICKED_UP, S.RECEIVED_AT_ORIGIN_HUB, S.CANCELLED],
  // Back to booked when the first-mile ride is cancelled or no driver is
  // found, so the hub can re-assign instead of the shipment being stuck.
  [S.PICKUP_SCHEDULED]: [S.PICKED_UP, S.RECEIVED_AT_ORIGIN_HUB, S.BOOKED, S.CANCELLED],
  [S.PICKED_UP]: [S.RECEIVED_AT_ORIGIN_HUB, ...CUSTODY_EXCEPTIONS],
  // out_for_delivery directly when origin and destination hub are the same
  // (an intracity parcel routed through one hub). rto_initiated when the
  // sender asks for it back before it leaves.
  [S.RECEIVED_AT_ORIGIN_HUB]: [S.IN_TRANSIT, S.OUT_FOR_DELIVERY, S.RTO_INITIATED, ...CUSTODY_EXCEPTIONS],
  [S.IN_TRANSIT]: [S.RECEIVED_AT_DESTINATION_HUB, ...CUSTODY_EXCEPTIONS],
  [S.RECEIVED_AT_DESTINATION_HUB]: [S.OUT_FOR_DELIVERY, S.RTO_INITIATED, ...CUSTODY_EXCEPTIONS],
  [S.OUT_FOR_DELIVERY]: [S.DELIVERED, S.DELIVERY_FAILED, ...CUSTODY_EXCEPTIONS],
  [S.DELIVERY_FAILED]: [S.REATTEMPT_SCHEDULED, S.RTO_INITIATED, ...CUSTODY_EXCEPTIONS],
  [S.REATTEMPT_SCHEDULED]: [S.OUT_FOR_DELIVERY, S.RTO_INITIATED, ...CUSTODY_EXCEPTIONS],
  // rto_initiated → rto_delivered covers an RTO raised at the origin hub
  // itself, where there is nothing to carry back.
  [S.RTO_INITIATED]: [S.RTO_IN_TRANSIT, S.RTO_DELIVERED, ...CUSTODY_EXCEPTIONS],
  [S.RTO_IN_TRANSIT]: [S.RTO_DELIVERED, ...CUSTODY_EXCEPTIONS],
  // A damaged parcel is either still delivered (receiver accepts it) or
  // returned. Lost is final: a found parcel is handled by admin as a new
  // shipment, so custody history stays honest.
  [S.DAMAGED]: [S.OUT_FOR_DELIVERY, S.RTO_INITIATED, S.LOST],
  [S.DELIVERED]: [],
  [S.RTO_DELIVERED]: [],
  [S.CANCELLED]: [],
  [S.LOST]: [],
});

export const TERMINAL_STATUSES = Object.freeze([S.DELIVERED, S.RTO_DELIVERED, S.CANCELLED, S.LOST]);

/// The four labels the SOW names (Received / In Transit / Out for Delivery /
/// Delivered) plus readable labels for the rest. Apps show this; they
/// should still branch on `status`.
const DISPLAY_STATUS = Object.freeze({
  [S.BOOKED]: 'Booked',
  [S.PICKUP_SCHEDULED]: 'Pickup Scheduled',
  [S.PICKED_UP]: 'Picked Up',
  [S.RECEIVED_AT_ORIGIN_HUB]: 'Received',
  [S.IN_TRANSIT]: 'In Transit',
  [S.RECEIVED_AT_DESTINATION_HUB]: 'Received',
  [S.OUT_FOR_DELIVERY]: 'Out for Delivery',
  [S.DELIVERED]: 'Delivered',
  [S.DELIVERY_FAILED]: 'Delivery Failed',
  [S.REATTEMPT_SCHEDULED]: 'Rescheduled',
  [S.RTO_INITIATED]: 'Returning to Sender',
  [S.RTO_IN_TRANSIT]: 'Returning to Sender',
  [S.RTO_DELIVERED]: 'Returned to Sender',
  [S.CANCELLED]: 'Cancelled',
  [S.LOST]: 'Lost',
  [S.DAMAGED]: 'Damaged',
});

export const getDisplayStatus = (status) => DISPLAY_STATUS[status] || 'Unknown';

export const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);

export const canTransition = (from, to) =>
  Array.isArray(SHIPMENT_TRANSITIONS[from]) && SHIPMENT_TRANSITIONS[from].includes(to);

export class ShipmentTransitionError extends Error {
  constructor(from, to, reason = '') {
    super(reason || `Shipment cannot move from ${from} to ${to}`);
    this.name = 'ShipmentTransitionError';
    this.statusCode = 409;
    this.from = from;
    this.to = to;
  }
}

export const assertTransition = (from, to) => {
  if (!SHIPMENT_STATUSES.includes(to)) {
    throw new ShipmentTransitionError(from, to, `Unknown shipment status ${to}`);
  }
  if (!canTransition(from, to)) {
    throw new ShipmentTransitionError(from, to);
  }
  return to;
};

/// A customer may cancel only while nobody has touched the parcel.
export const isCustomerCancellable = (status) => [S.BOOKED, S.PICKUP_SCHEDULED].includes(status);

/// The customer may pick a new delivery date only after a failed attempt.
export const isCustomerReschedulable = (status) => status === S.DELIVERY_FAILED;

export const SCAN_TYPES = Object.freeze([
  'pickup',
  'inbound',
  'outbound',
  'manifest_add',
  'manifest_remove',
  'out_for_delivery',
  'delivered',
  'failed',
  'rto',
  'exception',
]);

/// Which role the scanning hub plays for this shipment. A hub can be both
/// origin and destination (single-hub routing), reported as 'both'.
export const resolveHubRole = ({ hubId, originHubId, destinationHubId }) => {
  const hub = String(hubId || '');
  const isOrigin = hub && hub === String(originHubId || '');
  const isDestination = hub && hub === String(destinationHubId || '');
  if (isOrigin && isDestination) return 'both';
  if (isOrigin) return 'origin';
  if (isDestination) return 'destination';
  return 'transit';
};

/// What a scan at a hub does to a shipment's status.
///
/// Returns `{ allowed: true, nextStatus }`, where nextStatus may be null for
/// a scan that is recorded in the custody log without changing the status
/// (an inbound scan at a transit hub, a manifest add). Returns
/// `{ allowed: false, reason }` for a scan that does not make sense in the
/// current state, which the scan endpoint turns into a 409 so the operator
/// sees it immediately at the scanner.
export const resolveScanOutcome = ({ status, scanType, hubRole = 'transit', exceptionType = '' }) => {
  const deny = (reason) => ({ allowed: false, nextStatus: null, reason });
  const move = (nextStatus) =>
    canTransition(status, nextStatus)
      ? { allowed: true, nextStatus }
      : deny(`A ${scanType} scan cannot move a ${status} shipment to ${nextStatus}`);
  const stay = () => ({ allowed: true, nextStatus: null });
  const atOrigin = hubRole === 'origin' || hubRole === 'both';
  const atDestination = hubRole === 'destination' || hubRole === 'both';

  if (isTerminalStatus(status)) {
    return deny(`Shipment is already ${status}`);
  }

  switch (scanType) {
    case 'pickup':
      return move(S.PICKED_UP);

    case 'inbound':
      if ([S.BOOKED, S.PICKUP_SCHEDULED, S.PICKED_UP].includes(status)) {
        return atOrigin ? move(S.RECEIVED_AT_ORIGIN_HUB) : deny('This parcel must first be received at its origin hub');
      }
      if (status === S.IN_TRANSIT) {
        return atDestination ? move(S.RECEIVED_AT_DESTINATION_HUB) : stay();
      }
      // Coming back to a hub shelf after a failed run, or an RTO parcel
      // arriving at a hub on the way home: logged, no status change.
      if ([S.DELIVERY_FAILED, S.REATTEMPT_SCHEDULED, S.RTO_INITIATED, S.RTO_IN_TRANSIT, S.DAMAGED].includes(status)) {
        return stay();
      }
      if ([S.RECEIVED_AT_ORIGIN_HUB, S.RECEIVED_AT_DESTINATION_HUB].includes(status)) {
        return deny('Parcel was already received at a hub');
      }
      return deny(`An inbound scan is not valid for a ${status} shipment`);

    case 'outbound':
      if (status === S.RECEIVED_AT_ORIGIN_HUB) return move(S.IN_TRANSIT);
      if (status === S.IN_TRANSIT) return stay(); // leaving a transit hub
      if (status === S.RTO_INITIATED) return move(S.RTO_IN_TRANSIT);
      if (status === S.RTO_IN_TRANSIT) return stay();
      return deny(`An outbound scan is not valid for a ${status} shipment`);

    case 'manifest_add':
    case 'manifest_remove':
      if ([S.RECEIVED_AT_ORIGIN_HUB, S.IN_TRANSIT, S.RTO_INITIATED, S.RTO_IN_TRANSIT].includes(status)) {
        return stay();
      }
      return deny(`A ${status} shipment cannot be put on a manifest`);

    case 'out_for_delivery':
      if (status === S.RECEIVED_AT_ORIGIN_HUB && !atDestination) {
        return deny('This parcel has to travel to its destination hub first');
      }
      return move(S.OUT_FOR_DELIVERY);

    case 'delivered':
      if ([S.RTO_INITIATED, S.RTO_IN_TRANSIT].includes(status)) {
        return atOrigin || hubRole === 'none' ? move(S.RTO_DELIVERED) : deny('Returned parcels are handed back at the origin hub');
      }
      return move(S.DELIVERED);

    case 'failed':
      return move(S.DELIVERY_FAILED);

    case 'rto':
      return move(S.RTO_INITIATED);

    case 'exception': {
      const target = String(exceptionType || '').toLowerCase();
      if (![S.LOST, S.DAMAGED].includes(target)) {
        return deny('exceptionType must be lost or damaged');
      }
      return move(target);
    }

    default:
      return deny(`Unknown scan type ${scanType}`);
  }
};
