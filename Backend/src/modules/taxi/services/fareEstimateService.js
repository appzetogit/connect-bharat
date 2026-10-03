import mongoose from 'mongoose';
import { ApiError } from '../../../utils/ApiError.js';
import { normalizePoint } from '../../../utils/geo.js';
import { SetPrice } from '../admin/models/SetPrice.js';
import { Vehicle } from '../admin/models/Vehicle.js';
import { findZoneByPickup } from './matchingService.js';
import { validatePromoForContext } from './promoService.js';
import { resolveRouteCached } from './routeService.js';
import {
  normalizeAllowedRidePaymentMethods,
  resolveBookingFare,
  resolveSetPriceForRide,
} from './rideService.js';

/// Fare estimate before booking: `POST /rides/estimate`.
///
/// The apps used to price the trip themselves from the published Set Price
/// rows, which is why the server could not enforce minimum fare, night charge
/// or surge. Now that the server prices the booking, the apps need the
/// server's number before the rider taps "Book" - otherwise the screen shows
/// one fare and the ride is booked at another.
///
/// Every step here is the one `createRideRecord` takes, called through the same
/// functions: zone from the pickup (`findZoneByPickup`), Set Price row by zone
/// -> city -> global (`resolveSetPriceForRide`), road route through the shared
/// route cache, and the fare through `resolveBookingFare` itself. So an estimate
/// and a booking made from it, for the same trip within the route cache's five
/// minutes and the same night/surge window, come out at the same fare.

const MAX_VEHICLES_PER_ESTIMATE = 30;

/// Accepts every shape the apps send a point in: GeoJSON [lng, lat] (what
/// createRide takes), { lat, lng }, { latitude, longitude }, or a GeoJSON Point.
export const toLngLat = (value, fieldName) => {
  if (Array.isArray(value)) {
    return normalizePoint(value, fieldName);
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.coordinates)) {
      return normalizePoint(value.coordinates, fieldName);
    }
    const lat = value.lat ?? value.latitude;
    const lng = value.lng ?? value.lon ?? value.long ?? value.longitude;
    if (lat !== undefined && lng !== undefined) {
      return normalizePoint([lng, lat], fieldName);
    }
  }
  throw new ApiError(400, `${fieldName} must be [longitude, latitude] or { lat, lng }`);
};

const normalizeServiceType = (value) => {
  const normalized = String(value || 'ride').trim().toLowerCase();
  return normalized === 'intercity' ? 'intercity' : normalized === 'parcel' ? 'parcel' : 'ride';
};

/// Same rule as rideService: 'both'/'all' book as taxi.
const normalizeTransportType = (value = 'taxi') => {
  const normalized = String(value || 'taxi').trim().toLowerCase() || 'taxi';
  return normalized === 'both' || normalized === 'all' ? 'taxi' : normalized;
};

const toObjectIdOrNull = (value) => (
  value && mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null
);

const normalizeVehicleTypeIds = (vehicleTypeIds, vehicleTypeId) => {
  const values = Array.isArray(vehicleTypeIds) ? [...vehicleTypeIds] : (vehicleTypeIds ? [vehicleTypeIds] : []);
  if (vehicleTypeId) values.push(vehicleTypeId);
  const ids = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new ApiError(400, 'vehicleTypeIds contains an invalid id');
  }
  return ids;
};

/// Every vehicle with an active ride-scope Set Price row that could apply to
/// this booking - in the zone, in the city, or global - for this transport
/// type. Which row wins for each vehicle is left to resolveSetPriceForRide, so
/// the precedence stays in one place.
const listPricedVehicleIds = async ({ zoneId, serviceLocationId, transportType }) => {
  // `null` also matches rows saved without the field.
  const placeFilters = [{ zone_id: null, service_location_id: null }];
  if (zoneId) placeFilters.push({ zone_id: zoneId });
  if (serviceLocationId) placeFilters.push({ service_location_id: serviceLocationId });

  const ids = await SetPrice.distinct('vehicle_type', {
    active: 1,
    status: 'active',
    pricing_scope: { $in: ['ride', null] },
    transport_type: { $in: [transportType, 'both'] },
    vehicle_type: { $ne: null },
    $or: placeFilters,
  });
  return ids.map(String);
};

/// The vehicles of an intercity package: the package's own price list decides
/// which vehicles it can be booked in.
const loadPackageRow = async (packageId) => {
  const id = String(packageId || '').trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return SetPrice.findOne({ _id: id, pricing_scope: 'package', active: 1, status: 'active' }).lean();
};

/// The per-ride platform fee createRideRecord will accept for this fare: a
/// percentage or flat `admin_commision` on the Set Price row. Shown so the app
/// adds the same fee it sends as `platformFee`.
const computePlatformFee = (pricingRule, fare) => {
  if (!pricingRule || !(Number(fare) > 0)) return 0;
  const value = Math.max(0, Number(pricingRule.admin_commision) || 0);
  const fee = Number(pricingRule.admin_commision_type ?? 1) === 1 ? (Number(fare) * value) / 100 : value;
  return Math.round(fee * 100) / 100;
};

const serializeVehicle = (vehicle, id) => ({
  id: String(vehicle?._id || id),
  name: vehicle?.name || '',
  icon_types: vehicle?.icon_types || '',
  image: vehicle?.image || '',
  icon: vehicle?.icon || '',
  map_icon: vehicle?.map_icon || '',
  capacity: vehicle?.capacity ?? null,
});

const serializeZone = (zone) => (zone
  ? {
      id: String(zone._id),
      name: zone.name || '',
      service_location_id: zone.service_location_id ? String(zone.service_location_id) : null,
    }
  : null);

/// Promo preview for one quote: the same validation createRideRecord runs at
/// booking, without redeeming anything.
const previewPromo = async ({ code, userId, fare, serviceLocationId, transportType }) => {
  if (!(Number(fare) > 0)) {
    return { eligible: false, reason: 'NO_SERVER_FARE', message: 'This vehicle has no server fare to discount' };
  }
  const result = await validatePromoForContext({
    code,
    userId,
    fare,
    service_location_id: serviceLocationId,
    transport_type: transportType,
  });
  if (!result.eligible) {
    return { eligible: false, reason: result.reason, message: result.message };
  }
  return {
    eligible: true,
    code: result.promo.code,
    discount_type: result.breakdown.discount_type,
    discount_amount: result.breakdown.discount_amount,
    fare_before_discount: result.breakdown.fare_before_discount,
    fare_after_discount: result.breakdown.fare_after_discount,
  };
};

export const estimateRideFares = async ({
  userId = null,
  pickup,
  drop,
  vehicleTypeIds,
  vehicleTypeId,
  zone_id,
  service_location_id,
  transport_type,
  serviceType,
  scheduledAt,
  intercity = null,
  promo_code,
  estimatedDistanceMeters,
  estimatedDurationMinutes,
} = {}) => {
  if (!pickup || !drop) {
    throw new ApiError(400, 'pickup and drop are required');
  }
  const pickupCoords = toLngLat(pickup, 'pickup');
  const dropCoords = toLngLat(drop, 'drop');

  const normalizedServiceType = normalizeServiceType(serviceType);
  if (normalizedServiceType === 'parcel') {
    throw new ApiError(400, 'Parcel fares are quoted by the delivery quote endpoint');
  }

  let at = new Date();
  if (scheduledAt) {
    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new ApiError(400, 'scheduledAt is invalid');
    }
    at = parsed;
  }

  const transportType = normalizeTransportType(transport_type);

  // Zone and city exactly as createRideRecord resolves them.
  const explicitZoneId = toObjectIdOrNull(zone_id);
  const pickupZone = explicitZoneId
    ? null
    : await findZoneByPickup(pickupCoords, { serviceLocationId: service_location_id }).catch(() => null);
  const resolvedZoneId = explicitZoneId || pickupZone?._id || null;
  const resolvedServiceLocationId = toObjectIdOrNull(service_location_id) || pickupZone?.service_location_id || null;

  const route = await resolveRouteCached({ origin: pickupCoords, destination: dropCoords }).catch(() => null);
  // With no route, createRideRecord falls back to the app's own estimate, so
  // the estimate does the same with the same fields.
  const distanceMeters = route?.distanceMeters > 0
    ? route.distanceMeters
    : Math.max(0, Number(estimatedDistanceMeters || 0));
  const durationMinutes = route?.durationMinutes > 0
    ? route.durationMinutes
    : Math.max(0, Number(estimatedDurationMinutes || 0));

  const packageRow = normalizedServiceType === 'intercity' && intercity?.packageId
    ? await loadPackageRow(intercity.packageId)
    : null;

  let ids = normalizeVehicleTypeIds(vehicleTypeIds, vehicleTypeId);
  if (ids.length === 0) {
    ids = packageRow
      ? [...new Set((packageRow.package_vehicle_prices || [])
          .filter((row) => row?.vehicle_type && Number(row.active ?? 1) === 1)
          .map((row) => String(row.vehicle_type)))]
      : await listPricedVehicleIds({ zoneId: resolvedZoneId, serviceLocationId: resolvedServiceLocationId, transportType });
  }
  ids = ids.slice(0, MAX_VEHICLES_PER_ESTIMATE);

  const vehicles = ids.length
    ? await Vehicle.find({ _id: { $in: ids } }).select('name icon_types image icon map_icon capacity active status').lean()
    : [];
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
  const promoCode = typeof promo_code === 'string' ? promo_code.trim() : '';
  const promoServiceLocationId = service_location_id || resolvedServiceLocationId;

  const quotes = [];
  for (const id of ids) {
    const vehicle = vehicleById.get(id);
    // An explicitly requested but switched-off vehicle is still reported, so
    // the app can tell "not priced" from "not available".
    if (!vehicle || vehicle.active === false) {
      if (vehicleTypeIds || vehicleTypeId) {
        quotes.push({ vehicle: serializeVehicle(vehicle, id), available: false, reason: 'VEHICLE_UNAVAILABLE', fare: null });
      }
      continue;
    }

    const pricingRule = await resolveSetPriceForRide({
      zoneId: resolvedZoneId,
      serviceLocationId: resolvedServiceLocationId,
      transportType,
      vehicleTypeId: id,
    });

    const { fare, fareSource, fareBreakdown } = await resolveBookingFare({
      clientFare: null,
      serverPricedFareSource: null,
      pricingRule,
      serviceType: normalizedServiceType,
      distanceMeters,
      durationMinutes,
      zone: pickupZone,
      zoneId: resolvedZoneId,
      serviceLocationId: resolvedServiceLocationId,
      at,
      intercity,
      vehicleTypeId: id,
    });
    const serverFare = fareSource === 'server' && Number(fare) > 0 ? Number(fare) : null;

    quotes.push({
      vehicle: serializeVehicle(vehicle, id),
      available: serverFare !== null,
      // 'server': this is the fare createRide will book at. 'client': the
      // server cannot price this vehicle (no Set Price row, outstation without
      // outstation rates, or fare_source=client) and will book the app's fare.
      fare_source: fareSource,
      fare: serverFare,
      fare_breakdown: fareBreakdown,
      set_price_id: pricingRule?._id ? String(pricingRule._id) : null,
      allowed_payment_methods: normalizeAllowedRidePaymentMethods(pricingRule?.payment_type),
      platform_fee: computePlatformFee(pricingRule, serverFare),
      waiting: pricingRule
        ? {
            waiting_charge: Number(pricingRule.waiting_charge ?? 0),
            free_waiting_before: Number(pricingRule.free_waiting_before ?? 0),
          }
        : null,
      promo: promoCode
        ? await previewPromo({
            code: promoCode,
            userId,
            fare: serverFare,
            serviceLocationId: promoServiceLocationId,
            transportType: transport_type || 'taxi',
          })
        : null,
    });
  }

  return {
    service_type: normalizedServiceType,
    transport_type: transportType,
    priced_at: at.toISOString(),
    zone: serializeZone(pickupZone) || (resolvedZoneId ? { id: String(resolvedZoneId), name: '', service_location_id: resolvedServiceLocationId ? String(resolvedServiceLocationId) : null } : null),
    zone_id: resolvedZoneId ? String(resolvedZoneId) : null,
    service_location_id: resolvedServiceLocationId ? String(resolvedServiceLocationId) : null,
    route: route
      ? {
          distance_meters: route.distanceMeters,
          duration_minutes: route.durationMinutes,
          polyline: route.polyline,
          provider: route.provider,
        }
      : null,
    distance_meters: distanceMeters,
    duration_minutes: durationMinutes,
    promo_code: promoCode || null,
    quotes,
  };
};
