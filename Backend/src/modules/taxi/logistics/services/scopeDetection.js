/// Which kind of shipment a sender → receiver pair is, and therefore which
/// API books it. Pure, so the boundaries are unit-tested.
///
///   intracity      both ends in one city (same zone, or same service
///                  location, or no zone on one end but within the
///                  intracity distance cap, mirroring assertIntracityDelivery)
///   intercity      different cities, within intercityMaxKm
///   long_distance  further than that
///
/// fulfilment says which flow carries it: 'direct' means a single-driver
/// parcel ride via the existing POST /deliveries (unchanged), 'hub' means
/// the hub network via POST /logistics/shipments.

export const DEFAULT_INTRACITY_MAX_KM = 60;
export const DEFAULT_INTERCITY_MAX_KM = 400;

const toRadians = (value) => (Number(value) * Math.PI) / 180;

export const haversineKm = (from = [], to = []) => {
  if (!Array.isArray(from) || !Array.isArray(to) || from.length < 2 || to.length < 2) return 0;
  const [fromLng, fromLat] = from.map(Number);
  const [toLng, toLat] = to.map(Number);
  if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) return 0;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat));
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const idOf = (value) => (value && typeof value === 'object' && value._id ? String(value._id) : value ? String(value) : '');

export const detectShipmentScope = ({
  pickupZone = null,
  dropZone = null,
  distanceKm = 0,
  intracityMaxKm = DEFAULT_INTRACITY_MAX_KM,
  intercityMaxKm = DEFAULT_INTERCITY_MAX_KM,
}) => {
  const km = Math.max(0, Number(distanceKm) || 0);
  const pickupZoneId = idOf(pickupZone?._id || pickupZone);
  const dropZoneId = idOf(dropZone?._id || dropZone);
  const pickupCity = idOf(pickupZone?.service_location_id);
  const dropCity = idOf(dropZone?.service_location_id);

  if (pickupZoneId && dropZoneId) {
    if (pickupZoneId === dropZoneId) return { scope: 'intracity', reason: 'same_zone' };
    if (pickupCity && dropCity && pickupCity === dropCity) return { scope: 'intracity', reason: 'same_city' };
  } else if (km <= intracityMaxKm) {
    // One end has no zone: judge on distance, as the direct parcel flow does.
    return { scope: 'intracity', reason: 'within_intracity_distance' };
  }

  if (km <= intercityMaxKm) return { scope: 'intercity', reason: 'within_intercity_distance' };
  return { scope: 'long_distance', reason: 'beyond_intercity_distance' };
};

/// 'direct' only for intracity work, and only when the admin has not routed
/// intracity parcels through hubs too.
export const resolveFulfilment = ({ scope, intracityFulfilment = 'direct', forceHub = false }) => {
  if (scope !== 'intracity') return 'hub';
  if (forceHub) return 'hub';
  return String(intracityFulfilment || 'direct').toLowerCase() === 'hub' ? 'hub' : 'direct';
};
