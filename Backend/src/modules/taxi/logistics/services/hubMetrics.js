/// Hub performance arithmetic over plain arrays of scan events and
/// shipments. Pure, so the definitions of "dwell time" and "scan compliance"
/// are pinned down by tests rather than by whatever an aggregation pipeline
/// happened to do.

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : 0);
const ts = (value) => new Date(value).getTime();

/// Scans that take a parcel out of a hub's hands.
const DEPARTURE_TYPES = ['outbound', 'out_for_delivery', 'delivered'];

const groupByShipment = (events) => {
  const map = new Map();
  for (const event of events) {
    const key = String(event.shipmentId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  for (const list of map.values()) list.sort((a, b) => ts(a.at) - ts(b.at));
  return map;
};

/// Dwell: hours between a parcel's first inbound scan at this hub and the
/// first departure scan after it. Parcels still on the shelf are counted
/// separately as `onShelf`, not as zero dwell.
export const computeDwell = (events = [], hubId) => {
  const hub = String(hubId);
  const byShipment = groupByShipment(events.filter((event) => String(event.hubId) === hub));
  const dwellHours = [];
  let onShelf = 0;

  for (const list of byShipment.values()) {
    const inbound = list.find((event) => event.type === 'inbound');
    if (!inbound) continue;
    const departure = list.find((event) => DEPARTURE_TYPES.includes(event.type) && ts(event.at) >= ts(inbound.at));
    if (departure) {
      dwellHours.push((ts(departure.at) - ts(inbound.at)) / 3600000);
    } else {
      onShelf += 1;
    }
  }

  const sorted = [...dwellHours].sort((a, b) => a - b);
  const average = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0;
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  return { averageHours: round2(average), medianHours: round2(median), measured: sorted.length, onShelf };
};

/// Scan compliance: of the parcels that left this hub, the share that were
/// inbound-scanned before they left. A parcel dispatched without ever being
/// received is a hole in the custody chain.
export const computeScanCompliance = (events = [], hubId) => {
  const hub = String(hubId);
  const byShipment = groupByShipment(events.filter((event) => String(event.hubId) === hub));
  let departed = 0;
  let compliant = 0;
  for (const list of byShipment.values()) {
    const departure = list.find((event) => DEPARTURE_TYPES.includes(event.type));
    if (!departure) continue;
    departed += 1;
    if (list.some((event) => event.type === 'inbound' && ts(event.at) <= ts(departure.at))) {
      compliant += 1;
    }
  }
  return { departed, compliant, percent: departed ? pct(compliant, departed) : 100 };
};

/// SLA breach: delivered after the due time, or still undelivered past it.
/// Shipments with no due time, and cancelled ones, are not counted.
export const computeSlaBreach = (shipments = [], now = new Date()) => {
  let measured = 0;
  let breached = 0;
  for (const shipment of shipments) {
    if (!shipment?.slaDueAt || shipment.status === 'cancelled') continue;
    const due = ts(shipment.slaDueAt);
    const deliveredAt = shipment.deliveredAt ? ts(shipment.deliveredAt) : null;
    if (deliveredAt === null && due > ts(now)) continue; // still within SLA
    measured += 1;
    if ((deliveredAt ?? ts(now)) > due) breached += 1;
  }
  return { measured, breached, percent: pct(breached, measured) };
};

export const summarizeHubPerformance = ({ hubId, events = [], shipments = [], now = new Date() }) => {
  const hub = String(hubId);
  const atHub = events.filter((event) => String(event.hubId) === hub);
  const count = (type) => atHub.filter((event) => event.type === type).length;
  const delivered = count('delivered');
  const failed = count('failed');
  return {
    hubId: hub,
    throughput: {
      inbound: count('inbound'),
      outbound: count('outbound'),
      outForDelivery: count('out_for_delivery'),
      delivered,
      failed,
    },
    dwell: computeDwell(events, hub),
    sla: computeSlaBreach(shipments, now),
    failedDeliveryPercent: pct(failed, delivered + failed),
    scanCompliance: computeScanCompliance(events, hub),
  };
};

/// Ranks hubs for the admin league table: lowest SLA breach, then lowest
/// failed-delivery rate, then highest throughput.
export const rankHubs = (summaries = []) =>
  [...summaries]
    .sort(
      (a, b) =>
        a.sla.percent - b.sla.percent ||
        a.failedDeliveryPercent - b.failedDeliveryPercent ||
        (b.throughput.inbound + b.throughput.delivered) - (a.throughput.inbound + a.throughput.delivered),
    )
    .map((summary, index) => ({ rank: index + 1, ...summary }));
