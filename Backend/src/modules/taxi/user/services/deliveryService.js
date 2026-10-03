import { ApiError } from '../../../../utils/ApiError.js';
import { normalizePoint } from '../../../../utils/geo.js';
import { GoodsType } from '../../admin/models/GoodsType.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { startDispatchFlow } from '../../services/dispatchService.js';
import { findZoneByPickup } from '../../services/matchingService.js';
import { Delivery } from '../models/Delivery.js';
import { Ride } from '../models/Ride.js';
import { resolveDeliveryTariff } from '../../services/deliveryTariffService.js';
import { resolveRouteCached } from '../../services/routeService.js';
import {
  createRideRecord,
  ensureRideParticipantAccess,
  getActiveRideForIdentity,
  getRideDetails,
  getRideRoom,
  listRideHistoryForIdentity,
  serializeRideRealtime,
} from '../../services/rideService.js';

const ensureParcelRide = (ride) => {
  if (!ride || String(ride.serviceType || ride.type || 'ride').toLowerCase() !== 'parcel') {
    throw new ApiError(404, 'Delivery not found');
  }

  return ride;
};

const normalizeVehicleLabel = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const getVehicleTokens = (vehicle = {}) =>
  [
    vehicle?.name,
    vehicle?.vehicle_type,
    vehicle?.icon_types,
    String(vehicle?.name || '').replace(/\s+/g, '_'),
  ]
    .map(normalizeVehicleLabel)
    .filter(Boolean);

const goodsTypeAllowsVehicle = (goodsType, vehicle) => {
  const allowedLabels = String(goodsType?.goods_types_for || goodsType?.goods_type_for || 'both')
    .split(',')
    .map(normalizeVehicleLabel)
    .filter(Boolean);

  if (!allowedLabels.length || allowedLabels.includes('both') || allowedLabels.includes('all')) {
    return true;
  }

  const tokens = getVehicleTokens(vehicle);
  return allowedLabels.some((label) => tokens.some((token) => token.includes(label) || label.includes(token)));
};

const ensureDeliveryVehicleAllowed = async ({ vehicleTypeId, parcel }) => {
  const category = String(parcel?.category || '').trim();

  if (!vehicleTypeId || !category) {
    return;
  }

  const [goodsType, vehicle] = await Promise.all([
    GoodsType.findOne({
      goods_type_name: { $regex: `^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      active: 1,
    })
      .select('goods_type_name goods_types_for goods_type_for')
      .lean(),
    Vehicle.findById(vehicleTypeId).select('name vehicle_type icon_types').lean(),
  ]);

  if (!goodsType || !vehicle) {
    return;
  }

  if (!goodsTypeAllowsVehicle(goodsType, vehicle)) {
    throw new ApiError(400, `${goodsType.goods_type_name || category} is not allowed for the selected vehicle type`);
  }
};

const roundCurrency = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const toRadians = (value) => (Number(value) * Math.PI) / 180;

const calculateDistanceKm = (fromCoords = [], toCoords = []) => {
  if (!Array.isArray(fromCoords) || !Array.isArray(toCoords) || fromCoords.length < 2 || toCoords.length < 2) {
    return 0;
  }

  const [fromLng, fromLat] = fromCoords.map(Number);
  const [toLng, toLat] = toCoords.map(Number);
  if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) {
    return 0;
  }

  const earthRadiusKm = 6371;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  return earthRadiusKm * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

/// Parcels are an intracity service, so a booking that crosses between cities is
/// refused.
///
/// Only one thing is unambiguous: both ends resolving to *different* operating
/// zones. Everything else is judged on distance, because a point having no zone
/// does not mean it is far away — the polygons are drawn tight, and the airport,
/// Devanahalli and Hoskote all fall outside the 23km Bangalore circle while
/// being ordinary city jobs. An earlier version of this refused any pickup that
/// matched no zone, which blocked exactly those.
///
/// The distance limit comes from whichever end we could place, using that zone's
/// own configured maximum where one is set.
const DEFAULT_INTRACITY_MAX_KM = 60;

const assertIntracityDelivery = async (pickupCoords, dropCoords) => {
  const [pickupZone, dropZone] = await Promise.all([
    findZoneByPickup(pickupCoords),
    findZoneByPickup(dropCoords),
  ]);

  // Both ends inside known, different cities: intercity by definition.
  if (pickupZone && dropZone && String(pickupZone._id) !== String(dropZone._id)) {
    throw new ApiError(
      400,
      `Parcels are available within one city only. This pickup is in ${pickupZone.name} and the drop is in ${dropZone.name}.`,
    );
  }

  if (pickupZone && dropZone) {
    return pickupZone;
  }

  // At least one end sits outside every polygon. Judge it on distance instead of
  // refusing, so city work near the boundary still books while a long-distance
  // hop does not slip through at intracity rates.
  const knownZone = pickupZone || dropZone;
  const limitKm = Number(knownZone?.maximum_distance_for_regular_rides) > 0
    ? Number(knownZone.maximum_distance_for_regular_rides)
    : DEFAULT_INTRACITY_MAX_KM;
  const distanceKm = calculateDistanceKm(pickupCoords, dropCoords);

  if (distanceKm > limitKm) {
    throw new ApiError(
      400,
      `This trip is too far for a parcel delivery. Parcels are available within one city, up to ${limitKm}km.`,
    );
  }

  return knownZone || null;
};

/// Road distance for a parcel fare, or straight-line when no route resolves.
///
/// Parcels used to be priced on straight-line distance, which under-charged
/// every trip by however far the roads wind. The route comes from the same
/// server-side cache as the map's route line, so the parallel quotes the
/// vehicle picker makes for one trip cost a single Directions call, and a
/// booking made soon after reads the same distance it was quoted on.
///
/// Falls back rather than refusing: a routing outage should cost accuracy,
/// never the ability to send a parcel.
const resolveDeliveryDistance = async (pickupCoords, dropCoords) => {
  const route = await resolveRouteCached({ origin: pickupCoords, destination: dropCoords })
    .catch(() => null);

  if (route?.distanceMeters > 0) {
    return {
      distanceKm: route.distanceMeters / 1000,
      durationMinutes: Number(route.durationMinutes) || 0,
      source: 'road',
    };
  }

  return {
    distanceKm: calculateDistanceKm(pickupCoords, dropCoords),
    durationMinutes: 0,
    source: 'straight_line',
  };
};

/// The fare for one parcel: the tariff for the zone it is picked up in, over
/// the distance resolveDeliveryDistance found.
const computeDeliveryFareBreakdown = ({ tariff = {}, distanceKm: tripKm = 0 }) => {
  // Reported by both branches — priced and unpriced — since the quote screen
  // shows the distance even when the vehicle has no fare configured.
  const distanceKm = Math.max(0, Number(tripKm) || 0);
  const baseDistance = Math.max(0, Number(tariff.baseDistanceKm || 0));
  const serviceTaxPercentage = Math.max(0, Number(tariff.serviceTaxPercentage || 0));

  if (!tariff.enabled) {
    return {
      total: 0,
      subtotal: 0,
      serviceTaxPercentage: roundCurrency(serviceTaxPercentage),
      serviceTaxAmount: 0,
      distanceKm: roundCurrency(distanceKm),
      baseDistanceKm: roundCurrency(baseDistance),
    };
  }

  const basePrice = Math.max(0, Number(tariff.basePrice || 0));
  const distancePrice = Math.max(0, Number(tariff.pricePerKm || 0));
  const extraDistanceKm = Math.max(distanceKm - baseDistance, 0);
  const subtotal = basePrice + extraDistanceKm * distancePrice;
  const serviceTaxAmount = (subtotal * serviceTaxPercentage) / 100;

  return {
    total: roundCurrency(subtotal + serviceTaxAmount),
    subtotal: roundCurrency(subtotal),
    serviceTaxPercentage: roundCurrency(serviceTaxPercentage),
    serviceTaxAmount: roundCurrency(serviceTaxAmount),
    distanceKm: roundCurrency(distanceKm),
    baseDistanceKm: roundCurrency(baseDistance),
  };
};

export const serializeDeliveryRealtime = (ride) => {
  const serializedRide = serializeRideRealtime(ride);

  return {
    ...serializedRide,
    deliveryId: ride.deliveryId?._id ? String(ride.deliveryId._id) : ride.deliveryId ? String(ride.deliveryId) : null,
    rideId: String(ride._id),
    room: getRideRoom(ride._id),
    type: 'parcel',
    serviceType: 'parcel',
  };
};

export const createDeliveryRecord = async ({
  userId,
  pickup,
  drop,
  pickupAddress,
  dropAddress,
  vehicleTypeId,
  vehicleTypeIds,
  vehicleIconType,
  vehicleIconUrl,
  paymentMethod,
  parcel,
}) => {
  await ensureDeliveryVehicleAllowed({ vehicleTypeId, parcel });
  const pickupCoords = normalizePoint(pickup, 'pickup');
  const dropCoords = normalizePoint(drop, 'drop');
  const pricingZone = await assertIntracityDelivery(pickupCoords, dropCoords);
  const vehicle = vehicleTypeId
    ? await Vehicle.findById(vehicleTypeId).select('delivery_distance_pricing service_tax').lean()
    : null;
  const [tariff, distance] = await Promise.all([
    resolveDeliveryTariff({ vehicle, zone: pricingZone }),
    resolveDeliveryDistance(pickupCoords, dropCoords),
  ]);
  const fareBreakdown = computeDeliveryFareBreakdown({ tariff, distanceKm: distance.distanceKm });

  // The server's price is the only one a parcel books at. This used to fall
  // back to whatever `fare` the app sent whenever the server could not price
  // the vehicle, so an unpriced vehicle booked at a number the client chose.
  if (!(fareBreakdown.total > 0)) {
    throw new ApiError(400, 'Delivery is not priced for this vehicle in this area yet.');
  }

  const ride = await createRideRecord({
    userId,
    pickupCoords,
    dropCoords,
    pickupAddress,
    dropAddress,
    fare: fareBreakdown.total,
    // A fallback only: createRideRecord routes the trip itself and prefers its
    // own figures, but if that lookup fails the ride still records these.
    estimatedDistanceMeters: distance.source === 'road'
      ? Math.round(distance.distanceKm * 1000)
      : undefined,
    estimatedDurationMinutes: distance.durationMinutes || undefined,
    // Lets the ride's commission and payment rules find this zone's row too;
    // until now every parcel resolved them with no zone at all.
    zone_id: pricingZone?._id ? String(pricingZone._id) : undefined,
    vehicleTypeId,
    vehicleTypeIds,
    vehicleIconType,
    vehicleIconUrl,
    paymentMethod,
    transport_type: 'delivery',
    serviceType: 'parcel',
    parcel,
    serverPricedFareSource: 'delivery_tariff',
  });

  // Waiting at the pickup is charged on the same tariff as the fare, and locked
  // now, so an admin edit mid-trip cannot change what this parcel pays.
  await Ride.updateOne(
    { _id: ride._id },
    {
      $set: {
        'pricingSnapshot.waiting_charge': tariff.waitingChargePerMinute,
        'pricingSnapshot.free_waiting_before': tariff.freeWaitingMinutes,
        'pricingSnapshot.delivery_tariff_source': tariff.source,
      },
    },
  );

  await startDispatchFlow(ride);

  const detailedRide = await getRideDetails(ride._id);
  return serializeDeliveryRealtime(ensureParcelRide(detailedRide));
};

/// The fare the app shows on the address/details screen before booking.
///
/// Runs the exact same `computeDeliveryFareBreakdown` that `createDeliveryRecord`
/// uses to set the charged fare, so what the rider is quoted here is always
/// what the booking actually charges — nothing here is recomputed differently
/// between the two call sites.
export const getDeliveryQuote = async ({ vehicleTypeId, pickup, drop, parcel }) => {
  if (!vehicleTypeId) {
    throw new ApiError(400, 'vehicleTypeId is required');
  }

  await ensureDeliveryVehicleAllowed({ vehicleTypeId, parcel });

  const pickupCoords = normalizePoint(pickup, 'pickup');
  const dropCoords = normalizePoint(drop, 'drop');
  // Checked here as well as at booking: a quote that a booking then refuses is
  // worse than refusing up front. It also names the zone the tariff comes from.
  const pricingZone = await assertIntracityDelivery(pickupCoords, dropCoords);
  const vehicle = await Vehicle.findById(vehicleTypeId)
    .select('name delivery_distance_pricing service_tax')
    .lean();

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle type not found');
  }

  const [tariff, distance] = await Promise.all([
    resolveDeliveryTariff({ vehicle, zone: pricingZone }),
    resolveDeliveryDistance(pickupCoords, dropCoords),
  ]);
  const fareBreakdown = computeDeliveryFareBreakdown({ tariff, distanceKm: distance.distanceKm });

  return {
    vehicleTypeId: String(vehicleTypeId),
    vehicleName: vehicle.name || '',
    ...fareBreakdown,
    // Which tariff and which distance priced this, and where. The app ignores
    // them; they are what make a wrong price diagnosable.
    tariffSource: tariff.source,
    distanceSource: distance.source,
    zoneName: pricingZone?.name || null,
  };
};

export const getActiveDeliveryForIdentity = async ({ role, entityId }) => {
  const ride = await getActiveRideForIdentity({ role, entityId });

  if (!ride) {
    return null;
  }

  if (String(ride.serviceType || ride.type || 'ride').toLowerCase() !== 'parcel') {
    return null;
  }

  return serializeDeliveryRealtime(ride);
};

export const getDeliveryById = async ({ deliveryId, role, entityId }) => {
  const delivery = await Delivery.findById(deliveryId).select('rideId');

  if (!delivery?.rideId) {
    throw new ApiError(404, 'Delivery not found');
  }

  await ensureRideParticipantAccess({ rideId: delivery.rideId, role, entityId });
  const ride = await getRideDetails(delivery.rideId);
  return serializeDeliveryRealtime(ensureParcelRide(ride));
};

export const listDeliveriesForIdentity = async ({ role, entityId, limit }) => {
  const rides = await listRideHistoryForIdentity({ role, entityId, limit });
  return rides
    .filter((ride) => String(ride.serviceType || ride.type || 'ride').toLowerCase() === 'parcel')
    .map((ride) => ({
      ...ride,
      type: 'parcel',
      serviceType: 'parcel',
    }));
};
