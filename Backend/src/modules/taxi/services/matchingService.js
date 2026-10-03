import { ApiError } from '../../../utils/ApiError.js';
import { normalizePoint } from '../../../utils/geo.js';
import { DISPATCH_TOP_DRIVERS } from '../constants/index.js';
import { Vehicle } from '../admin/models/Vehicle.js';
import { Driver } from '../driver/models/Driver.js';
import { Zone } from '../driver/models/Zone.js';
import { DriverSubscription } from '../driver/models/DriverSubscription.js';
import { resolveDriverSubscriptionSettings } from '../driver/services/driverSubscriptionService.js';
import { getDriverIdsBlockedByUpcomingScheduledRides } from './rideService.js';
import { buildVehicleApprovalDispatchFilter } from '../admin/operations/vehicleApprovalService.js';

const EARTH_RADIUS_METERS = 6371000;

const normalizeVehicleKey = (value = '') => String(value || '').trim().toLowerCase();

const normalizeVehicleKeys = (vehicles = []) => {
  const keys = vehicles.flatMap((vehicle) => [
    vehicle?.name,
    vehicle?.vehicle_type,
    vehicle?.icon_types,
    String(vehicle?.name || '').replace(/\s+/g, '_'),
    String(vehicle?.icon_types || '').replace(/\s+/g, '_'),
  ]);

  return [...new Set(keys.map(normalizeVehicleKey).filter(Boolean))];
};

const normalizeVehicleTypeIds = (vehicleTypeIds = [], vehicleTypeId = null) => {
  const values = Array.isArray(vehicleTypeIds) ? vehicleTypeIds : [vehicleTypeIds];

  if (vehicleTypeId) {
    values.push(vehicleTypeId);
  }

  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
};

/**
 * A filter limiting dispatch to drivers holding a paid pass, or {} when the
 * settings do not require one.
 */
const buildSubscriptionDriverFilter = async () => {
  const settings = await resolveDriverSubscriptionSettings();
  const requiresPass =
    settings.mode === 'subscription_only' || (settings.mode === 'both' && settings.onExpiry === 'block');

  if (!requiresPass) return {};

  const subscribed = await DriverSubscription.find(
    { status: 'active', paidAt: { $ne: null }, expiresAt: { $gt: new Date() } },
    { driverId: 1 },
  ).lean();

  return { _id: { $in: subscribed.map((row) => row.driverId) } };
};

const buildDriverMatchFilters = ({ zoneId, serviceLocationId, vehicleTypeId, vehicleTypeIds, vehicleTypeKeys }) => {
  const normalizedVehicleTypeIds = normalizeVehicleTypeIds(vehicleTypeIds, vehicleTypeId);
  const normalizedVehicleTypeKeys = Array.isArray(vehicleTypeKeys)
    ? [...new Set(vehicleTypeKeys.map(normalizeVehicleKey).filter(Boolean))]
    : [];
  const vehicleTypeClauses = normalizedVehicleTypeIds.length
    ? [
        { vehicleTypeId: { $in: normalizedVehicleTypeIds } },
        // A driver enrolled in more than one category at onboarding stores
        // them in vehicleTypeIds; vehicleTypeId (above) only ever holds the
        // first/primary one. Checking both means a driver whose primary
        // type is A but who also enrolled in B still gets offered a B ride.
        { vehicleTypeIds: { $in: normalizedVehicleTypeIds } },
      ]
    : [
        ...(normalizedVehicleTypeKeys.length
          ? [
              { vehicleType: { $in: normalizedVehicleTypeKeys } },
              { vehicleIconType: { $in: normalizedVehicleTypeKeys } },
            ]
          : []),
      ];
  const vehicleTypeFilter =
    vehicleTypeClauses.length > 1
      ? { $or: vehicleTypeClauses }
      : vehicleTypeClauses[0] || {};

  return {
    isOnline: true,
    isOnRide: false,
    $or: [
      { owner_id: { $ne: null } },
      { 'wallet.isBlocked': { $ne: true } },
    ],
    ...(zoneId ? { zoneId } : {}),
    ...(serviceLocationId ? { service_location_id: serviceLocationId } : {}),
    ...vehicleTypeFilter,
  };
};

const buildZoneIntersectionQuery = (coordinates) => ({
  active: { $ne: false },
  status: { $ne: 'inactive' },
  geometry: {
    $geoIntersects: {
      $geometry: {
        type: 'Point',
        coordinates,
      },
    },
  },
});

/// Rough area of a zone's outer ring in km2 - enough to rank zones by size,
/// which is all it is used for. Shoelace on a local equirectangular projection.
const approximateZoneAreaKm2 = (zone) => {
  const ring = zone?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    return Number.POSITIVE_INFINITY;
  }

  const meanLatRadians = (ring.reduce((sum, point) => sum + Number(point[1]), 0) / ring.length) * (Math.PI / 180);
  const kmPerDegreeLng = 111.32 * Math.cos(meanLatRadians);
  const kmPerDegreeLat = 110.57;
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    twiceArea += (ring[i][0] * kmPerDegreeLng) * (ring[i + 1][1] * kmPerDegreeLat)
      - (ring[i + 1][0] * kmPerDegreeLng) * (ring[i][1] * kmPerDegreeLat);
  }
  return Math.abs(twiceArea / 2);
};

/// The most specific zone containing a point: the smallest one.
///
/// Zones can nest - a city inside a state-wide catch-all - and the city is the
/// one whose prices and drivers should apply. The previous rule was "newest
/// wins", which made correctness depend on the order zones were created or
/// last edited: adding a state zone would have taken every city inside it, and
/// merely saving a city zone later would have handed it back. Newest is kept
/// only as the tie-break between zones of the same size.
const pickMostSpecificZone = (zones = []) => {
  if (!zones.length) {
    return null;
  }

  return [...zones].sort((a, b) => {
    const byArea = approximateZoneAreaKm2(a) - approximateZoneAreaKm2(b);
    if (byArea !== 0) {
      return byArea;
    }
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  })[0];
};

export const findZoneByPickup = async (pickupCoords, options = {}) => {
  const coordinates = normalizePoint(pickupCoords, 'pickupCoords');
  const normalizedServiceLocationId = String(options?.serviceLocationId || '').trim();

  if (normalizedServiceLocationId) {
    const preferredZones = await Zone.find({
      ...buildZoneIntersectionQuery(coordinates),
      service_location_id: normalizedServiceLocationId,
    });
    const preferredZone = pickMostSpecificZone(preferredZones);

    if (preferredZone) {
      return preferredZone;
    }
  }

  // Zones are authoritative for dispatch. A point rarely sits in more than two
  // or three, so fetching them all and ranking here costs next to nothing.
  return pickMostSpecificZone(await Zone.find(buildZoneIntersectionQuery(coordinates)));
};

const toLocalMeters = (origin, target) => {
  const [originLng, originLat] = origin;
  const [targetLng, targetLat] = target;
  const originLatRadians = (originLat * Math.PI) / 180;
  const metersPerDegreeLat = (Math.PI * EARTH_RADIUS_METERS) / 180;
  const metersPerDegreeLng = metersPerDegreeLat * Math.cos(originLatRadians);

  return {
    x: (targetLng - originLng) * metersPerDegreeLng,
    y: (targetLat - originLat) * metersPerDegreeLat,
  };
};

const getDistanceToSegmentMeters = (origin, segmentStart, segmentEnd) => {
  const start = toLocalMeters(origin, segmentStart);
  const end = toLocalMeters(origin, segmentEnd);
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSquared = (segmentX * segmentX) + (segmentY * segmentY);

  if (segmentLengthSquared <= 0) {
    return Math.hypot(start.x, start.y);
  }

  const projection = Math.max(
    0,
    Math.min(1, -((start.x * segmentX) + (start.y * segmentY)) / segmentLengthSquared),
  );
  const closestX = start.x + (projection * segmentX);
  const closestY = start.y + (projection * segmentY);

  return Math.hypot(closestX, closestY);
};

const getZoneBoundaryCapMeters = (zone, pickupCoords) => {
  const ring = Array.isArray(zone?.geometry?.coordinates?.[0]) ? zone.geometry.coordinates[0] : [];

  if (ring.length < 3) {
    return null;
  }

  let shortestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const segmentStart = normalizePoint(ring[index], `zone.geometry.coordinates[0][${index}]`);
    const segmentEnd = normalizePoint(ring[index + 1], `zone.geometry.coordinates[0][${index + 1}]`);
    const distanceMeters = getDistanceToSegmentMeters(pickupCoords, segmentStart, segmentEnd);

    if (Number.isFinite(distanceMeters) && distanceMeters < shortestDistance) {
      shortestDistance = distanceMeters;
    }
  }

  return Number.isFinite(shortestDistance) ? Math.max(0, Math.round(shortestDistance)) : null;
};

const getDistanceBetweenMeters = (origin, target) => {
  const [originLng, originLat] = origin;
  const [targetLng, targetLat] = target;

  const dLat = ((targetLat - originLat) * Math.PI) / 180;
  const dLng = ((targetLng - originLng) * Math.PI) / 180;
  const lat1 = (originLat * Math.PI) / 180;
  const lat2 = (targetLat * Math.PI) / 180;

  const a =
    (Math.sin(dLat / 2) ** 2) +
    (Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLng / 2) ** 2));

  return Math.round(2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

const getDriverMatchCoordinates = (driver = {}) => {
  const anchorCoordinates = Array.isArray(driver?.routeBooking?.anchorLocation?.coordinates)
    ? driver.routeBooking.anchorLocation.coordinates
    : [];

  if (driver?.routeBooking?.enabled && anchorCoordinates.length === 2) {
    return normalizePoint(anchorCoordinates, 'driver.routeBooking.anchorLocation.coordinates');
  }

  if (Array.isArray(driver?.location?.coordinates) && driver.location.coordinates.length === 2) {
    return normalizePoint(driver.location.coordinates, 'driver.location.coordinates');
  }

  return null;
};

const isPointInsidePolygonRing = (point, ring = []) => {
  if (!Array.isArray(ring) || ring.length < 3) {
    return false;
  }

  const [pointLng, pointLat] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [lng1, lat1] = normalizePoint(ring[i], `zone.geometry.coordinates[0][${i}]`);
    const [lng2, lat2] = normalizePoint(ring[j], `zone.geometry.coordinates[0][${j}]`);
    const intersects =
      ((lat1 > pointLat) !== (lat2 > pointLat)) &&
      (pointLng < ((lng2 - lng1) * (pointLat - lat1)) / ((lat2 - lat1) || Number.EPSILON) + lng1);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
};

const isDriverWithinMatchedZone = (driver, zone) => {
  if (!zone?._id) {
    return true;
  }

  const coordinates = getDriverMatchCoordinates(driver);
  if (!coordinates) {
    return false;
  }

  const ring = Array.isArray(zone?.geometry?.coordinates?.[0]) ? zone.geometry.coordinates[0] : [];
  if (!ring.length) {
    return String(driver?.zoneId || '') === String(zone._id);
  }

  return isPointInsidePolygonRing(coordinates, ring);
};

const filterDriversForMatchedZone = ({ drivers = [], zone = null, pickupCoords, maxDistance }) =>
  drivers.filter((driver) => {
    const coordinates = getDriverMatchCoordinates(driver);
    if (!coordinates) {
      return false;
    }

    if (!isDriverWithinMatchedZone(driver, zone)) {
      return false;
    }

    if (Number.isFinite(maxDistance) && maxDistance > 0) {
      return getDistanceBetweenMeters(pickupCoords, coordinates) <= maxDistance;
    }

    return true;
  });

const buildGeoNearFilter = (field, coordinates, maxDistance) => ({
  [field]: {
    $near: {
      $geometry: {
        type: 'Point',
        coordinates,
      },
      $maxDistance: maxDistance,
    },
  },
});

const getDispatchAnchorCoordinates = (driver = {}) => {
  const routeCoordinates = Array.isArray(driver?.routeBooking?.anchorLocation?.coordinates)
    ? driver.routeBooking.anchorLocation.coordinates
    : [];

  if (driver?.routeBooking?.enabled && routeCoordinates.length === 2) {
    return routeCoordinates;
  }

  return Array.isArray(driver?.location?.coordinates) ? driver.location.coordinates : [];
};

const sortDriversByDispatchAnchorDistance = (drivers = [], pickupCoords) =>
  [...drivers]
    .map((driver) => {
      const anchorCoordinates = getDispatchAnchorCoordinates(driver);
      return {
        driver,
        distanceMeters:
          anchorCoordinates.length === 2
            ? getDistanceBetweenMeters(pickupCoords, anchorCoordinates)
            : Number.POSITIVE_INFINITY,
      };
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters)
    .map(({ driver }) => driver);

const findDriversForZone = async ({
  zoneId,
  serviceLocationId,
  coordinates,
  effectiveMaxDistance,
  limit,
  normalizedVehicleTypeIds,
  vehicleTypeKeys,
  strictZoneOnly = false,
}) => {
  const commonFilters = {
    ...buildDriverMatchFilters({
      zoneId,
      serviceLocationId,
      vehicleTypeIds: normalizedVehicleTypeIds,
      vehicleTypeKeys,
    }),
    // When a daily pass is required - either as the only model, or because an
    // expired pass is set to stop rides - drivers without one are not offered
    // work. Off entirely unless an admin has switched it on, and the id list
    // is small: it is one day's paying drivers.
    ...(await buildSubscriptionDriverFilter()),
    // Only drivers with an approved vehicle, when require_vehicle_approval is on.
    ...(await buildVehicleApprovalDispatchFilter()),
  };
  const selectedFields =
    'name phone socketId vehicleTypeId vehicleTypeIds vehicleType vehicleIconType vehicleNumber vehicleColor vehicleMake vehicleModel rating location zoneId service_location_id isOnline isOnRide routeBooking';

  const [liveLocationDrivers, routeBookingDrivers] = await Promise.all([
    Driver.find({
      ...commonFilters,
      'routeBooking.enabled': { $ne: true },
      ...(strictZoneOnly ? {} : buildGeoNearFilter('location', coordinates, effectiveMaxDistance)),
    })
      .limit(limit)
      .select(selectedFields),
    Driver.find({
      ...commonFilters,
      'routeBooking.enabled': true,
      'routeBooking.anchorLocation': { $ne: null },
      'routeBooking.anchorLocation.coordinates.1': { $exists: true },
      ...(strictZoneOnly ? {} : buildGeoNearFilter('routeBooking.anchorLocation', coordinates, effectiveMaxDistance)),
    })
      .limit(limit)
      .select(selectedFields),
  ]);

  return sortDriversByDispatchAnchorDistance(
    [...liveLocationDrivers, ...routeBookingDrivers].filter(
      (driver, index, items) => items.findIndex((item) => String(item._id) === String(driver._id)) === index,
    ),
    coordinates,
  ).slice(0, limit);
};

export const matchDrivers = async (pickupCoords, options = {}) => {
  const coordinates = normalizePoint(pickupCoords, 'pickupCoords');
  const {
    maxDistance = 3000,
    limit = DISPATCH_TOP_DRIVERS,
    vehicleTypeId,
    vehicleTypeIds,
    serviceLocationId = null,
    allowCrossZoneFallback = true,
    strictZoneOnly = false,
  } = options;
  const normalizedVehicleTypeIds = normalizeVehicleTypeIds(vehicleTypeIds, vehicleTypeId);
  const allowedVehicles = normalizedVehicleTypeIds.length
    ? await Vehicle.find({ _id: { $in: normalizedVehicleTypeIds } }).select('name vehicle_type icon_types').lean()
    : [];
  const vehicleTypeKeys = normalizeVehicleKeys(allowedVehicles);

  const zone = await findZoneByPickup(coordinates, { serviceLocationId });
  const zoneBoundaryCapMeters = zone ? getZoneBoundaryCapMeters(zone, coordinates) : null;
  const effectiveMaxDistance = Number.isFinite(zoneBoundaryCapMeters) && zoneBoundaryCapMeters >= 0
    ? Math.min(Math.max(1, Math.round(maxDistance)), Math.max(1, zoneBoundaryCapMeters))
    : Math.max(1, Math.round(maxDistance));

  let drivers = await findDriversForZone({
    zoneId: zone?._id || null,
    serviceLocationId,
    coordinates,
    effectiveMaxDistance,
    limit,
    normalizedVehicleTypeIds,
    vehicleTypeKeys,
    strictZoneOnly,
  });
  drivers = filterDriversForMatchedZone({
    drivers,
    zone,
    pickupCoords: coordinates,
    maxDistance: effectiveMaxDistance,
  });

  const blockedDriverIds = await getDriverIdsBlockedByUpcomingScheduledRides(
    drivers.map((driver) => String(driver?._id || '')),
  );
  drivers = drivers.filter((driver) => !blockedDriverIds.has(String(driver?._id || '')));

  if (allowCrossZoneFallback && drivers.length === 0 && zone?._id) {
    drivers = await findDriversForZone({
      zoneId: null,
      serviceLocationId,
      coordinates,
      effectiveMaxDistance,
      limit,
      normalizedVehicleTypeIds,
      vehicleTypeKeys,
      strictZoneOnly,
    });
    drivers = filterDriversForMatchedZone({
      drivers,
      zone: null,
      pickupCoords: coordinates,
      maxDistance: effectiveMaxDistance,
    });

    const fallbackBlockedDriverIds = await getDriverIdsBlockedByUpcomingScheduledRides(
      drivers.map((driver) => String(driver?._id || '')),
    );
    drivers = drivers.filter((driver) => !fallbackBlockedDriverIds.has(String(driver?._id || '')));
  }

  return {
    zone,
    drivers,
    searchRadiusMeters: effectiveMaxDistance,
    zoneBoundaryCapMeters,
  };
};
