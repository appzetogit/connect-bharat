import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { normalizePoint } from '../../../../utils/geo.js';
import { GoodsType } from '../../admin/models/GoodsType.js';
import { findZoneByPickup } from '../../services/matchingService.js';
import { Ride } from '../../user/models/Ride.js';
import { Hub } from '../models/Hub.js';
import { ParcelRateCard } from '../models/ParcelRateCard.js';
import { ScanEvent } from '../models/ScanEvent.js';
import { Shipment } from '../models/Shipment.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { extractAwbFromScan } from './awb.js';
import { findNearestHub, generateAwb } from './hubLookupService.js';
import { emitShipmentUpdated } from './logisticsRealtime.js';
import { getLogisticsSettings, settingNumber } from './logisticsSettingsService.js';
import { listPickupSlots, resolvePickupWindow } from './pickupSlots.js';
import { detectShipmentScope, haversineKm, resolveFulfilment } from './scopeDetection.js';
import { recordScanEvent, serializeScanEvent, serializeShipment, transitionShipment } from './shipmentLifecycle.js';
import { computeChargeableWeight, computeShipmentPrice, resolveSizeCategory } from './shipmentPricing.js';
import { SHIPMENT_STATUS, getDisplayStatus, isCustomerCancellable, isCustomerReschedulable } from './shipmentStateMachine.js';

/// Customer-facing shipment operations: quote, book, list, track, cancel,
/// reschedule. Quote and booking share `buildShipmentQuote`, so the price a
/// customer is shown is the price the booking stores.

const PAYMENT_METHODS = ['online', 'cash', 'cod'];

const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const asBool = (value) => value === true || ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());

const normalizeIndianPhone = (phone = '') => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
};

const parseParty = (party = {}, label, { requireContact = true } = {}) => {
  const coordinates = normalizePoint(party.location?.coordinates || party.location || party.coordinates, `${label}.location`);
  const phone = normalizeIndianPhone(party.phone || party.mobile);
  if (requireContact) {
    if (!String(party.name || '').trim()) throw new ApiError(400, `${label}.name is required`);
    if (!/^\d{10}$/.test(phone)) throw new ApiError(400, `${label}.phone must be a 10-digit mobile number`);
  }
  return {
    name: String(party.name || '').trim(),
    phone,
    address: String(party.address || '').trim(),
    landmark: String(party.landmark || '').trim(),
    pincode: String(party.pincode || '').trim(),
    location: { type: 'Point', coordinates },
  };
};

const parseDimensions = (dimensions = {}) => ({
  l: Math.max(0, toNumber(dimensions?.l ?? dimensions?.length)),
  w: Math.max(0, toNumber(dimensions?.w ?? dimensions?.width)),
  h: Math.max(0, toNumber(dimensions?.h ?? dimensions?.height)),
});

/// A city's own card for the scope, else the global card for the scope.
export const resolveRateCard = async ({ serviceLocationId, scope }) => {
  const candidates = await ParcelRateCard.find({
    scope,
    active: true,
    serviceLocationId: { $in: [serviceLocationId || null, null].filter((value, index, list) => list.indexOf(value) === index) },
  })
    .sort({ updatedAt: -1 })
    .lean();
  return (
    candidates.find((card) => serviceLocationId && String(card.serviceLocationId) === String(serviceLocationId)) ||
    candidates.find((card) => !card.serviceLocationId) ||
    null
  );
};

const slaHoursFor = (settings, scope, express) => {
  const base = settingNumber(settings, `sla_hours_${scope}`, scope === 'intracity' ? 24 : scope === 'intercity' ? 72 : 120);
  const factor = express ? settingNumber(settings, 'express_sla_factor', 0.5) : 1;
  return Math.max(1, Math.round(base * (factor > 0 ? factor : 1)));
};

/// Scope, hubs, weights and price for a sender → receiver parcel.
export const buildShipmentQuote = async (input = {}, { requireContact = false, originHubOverride = null } = {}) => {
  const settings = await getLogisticsSettings();
  const sender = parseParty(input.sender || { location: input.pickup }, 'sender', { requireContact });
  const receiver = parseParty(input.receiver || { location: input.drop }, 'receiver', { requireContact });
  const weightKg = toNumber(input.weightKg ?? input.weight, NaN);
  if (!Number.isFinite(weightKg) || weightKg <= 0) throw new ApiError(400, 'weightKg must be a positive number');
  if (weightKg > 100) throw new ApiError(400, 'Parcels above 100kg are not accepted');
  const dimensions = parseDimensions(input.dimensions);
  const express = asBool(input.express);
  const fragile = asBool(input.fragile);
  const declaredValue = Math.max(0, toNumber(input.declaredValue));
  const insuranceOpted = asBool(input.insurance?.opted ?? input.insurance);
  const paymentMethod = PAYMENT_METHODS.includes(String(input.paymentMethod || '').toLowerCase())
    ? String(input.paymentMethod).toLowerCase()
    : 'cash';
  const pickupMode = String(input.pickupMode || 'pickup') === 'drop_at_hub' ? 'drop_at_hub' : 'pickup';
  if (insuranceOpted && !declaredValue) throw new ApiError(400, 'declaredValue is required to insure a parcel');

  const pickupCoords = sender.location.coordinates;
  const dropCoords = receiver.location.coordinates;
  const distanceKm = haversineKm(pickupCoords, dropCoords);
  const [pickupZone, dropZone] = await Promise.all([
    findZoneByPickup(pickupCoords).catch(() => null),
    findZoneByPickup(dropCoords).catch(() => null),
  ]);
  const { scope, reason } = detectShipmentScope({
    pickupZone,
    dropZone,
    distanceKm,
    intracityMaxKm: settingNumber(settings, 'intracity_max_km', 60),
    intercityMaxKm: settingNumber(settings, 'intercity_max_km', 400),
  });
  const fulfilment = resolveFulfilment({
    scope,
    intracityFulfilment: settings.intracity_fulfilment,
    forceHub: asBool(input.forceHub),
  });

  const base = {
    scope,
    scopeReason: reason,
    fulfilment,
    distanceKm: Math.round(distanceKm * 100) / 100,
    pickupZone: pickupZone ? { id: String(pickupZone._id), name: pickupZone.name } : null,
    dropZone: dropZone ? { id: String(dropZone._id), name: dropZone.name } : null,
  };

  if (fulfilment === 'direct') {
    // Same-city work keeps using the single-driver parcel flow. The app
    // should call POST /deliveries/quote and POST /deliveries.
    return {
      ...base,
      directDelivery: { quoteEndpoint: '/deliveries/quote', bookEndpoint: '/deliveries' },
      pricing: null,
    };
  }

  const maxKm = settingNumber(settings, 'hub_search_radius_km', 50);
  const [originHub, destinationHub] = await Promise.all([
    // A hub counter booking starts at the booking hub, whatever is nearest.
    originHubOverride || findNearestHub({ coordinates: pickupCoords, end: 'origin', maxKm }),
    findNearestHub({ coordinates: dropCoords, end: 'destination', maxKm }),
  ]);
  if (!originHub) throw new ApiError(400, 'No parcel hub serves the pickup location yet');
  if (!destinationHub) throw new ApiError(400, 'No parcel hub serves the delivery location yet');

  const serviceLocationId = originHub.serviceLocationId || pickupZone?.service_location_id || null;
  const rateCard = await resolveRateCard({ serviceLocationId, scope });
  if (!rateCard) throw new ApiError(400, `Parcels are not priced for ${scope.replace('_', ' ')} delivery from this city yet`);
  if (express && rateCard.expressAllowed === false) throw new ApiError(400, 'Express is not available on this route');
  if (paymentMethod === 'cod' && rateCard.codAllowed === false) throw new ApiError(400, 'Cash on delivery is not available on this route');

  const weights = computeChargeableWeight({
    weightKg,
    dimensions,
    divisor: rateCard.volumetricDivisor,
    stepKg: rateCard.weightStepKg,
  });
  let pricing;
  try {
    pricing = computeShipmentPrice({
      rateCard,
      chargeableWeightKg: weights.chargeableWeightKg,
      distanceKm,
      express,
      fragile,
      insuranceOpted,
      declaredValue,
      paymentMethod,
      withPickup: pickupMode === 'pickup',
    });
  } catch (error) {
    throw new ApiError(400, error.message);
  }
  if (!(pricing.total > 0)) throw new ApiError(400, 'This rate card prices the parcel at zero; ask the admin to set slab prices');

  const slaHours = slaHoursFor(settings, scope, express);
  return {
    ...base,
    originHub: { id: String(originHub._id), code: originHub.code, name: originHub.name, address: originHub.address },
    destinationHub: { id: String(destinationHub._id), code: destinationHub.code, name: destinationHub.name, address: destinationHub.address },
    serviceLocationId: serviceLocationId ? String(serviceLocationId) : null,
    rateCardId: String(rateCard._id),
    ...weights,
    dimensions,
    sizeCategory: resolveSizeCategory(weights.chargeableWeightKg),
    express,
    fragile,
    declaredValue,
    insuranceOpted,
    paymentMethod,
    pickupMode,
    pricing,
    slaHours,
    estimatedDeliveryBy: new Date(Date.now() + slaHours * 3600000).toISOString(),
    _internal: { sender, receiver, originHub, destinationHub },
  };
};

const stripInternal = ({ _internal, ...quote }) => quote;

export const quoteShipment = async (input) => stripInternal(await buildShipmentQuote(input, { requireContact: false }));

export const getPickupSlots = async ({ date }) => {
  const settings = await getLogisticsSettings();
  return listPickupSlots({
    date,
    slots: settings.pickup_slots,
    offsetMinutes: settingNumber(settings, 'timezone_offset_minutes', 330),
    leadMinutes: settingNumber(settings, 'pickup_lead_minutes', 60),
    daysAhead: settingNumber(settings, 'pickup_booking_days_ahead', 7),
  });
};

export const resolveSlotWindow = async ({ date, slot }) => {
  const settings = await getLogisticsSettings();
  try {
    return resolvePickupWindow({
      date,
      slot,
      slots: settings.pickup_slots,
      offsetMinutes: settingNumber(settings, 'timezone_offset_minutes', 330),
      leadMinutes: settingNumber(settings, 'pickup_lead_minutes', 60),
      daysAhead: settingNumber(settings, 'pickup_booking_days_ahead', 7),
    });
  } catch (error) {
    throw new ApiError(400, error.message);
  }
};

export const createShipment = async ({ userId = null, input = {}, bookedVia = 'app', staff = null, staffHub = null }) => {
  const quote = await buildShipmentQuote(input, { requireContact: true, originHubOverride: staffHub });
  if (quote.fulfilment === 'direct') {
    throw new ApiError(409, 'Same-city parcels are booked through POST /deliveries', {
      code: 'USE_DIRECT_DELIVERY',
      fulfilment: 'direct',
    });
  }

  let pickupWindow = null;
  if (quote.pickupMode === 'pickup' && (input.pickupSlot || input.scheduledPickup)) {
    const requested = input.scheduledPickup || {};
    pickupWindow = await resolveSlotWindow({
      date: requested.date || input.pickupDate,
      slot: requested.slot || input.pickupSlot,
    });
  }

  let goodsTypeId = null;
  if (input.goodsTypeId) {
    if (!mongoose.Types.ObjectId.isValid(input.goodsTypeId)) throw new ApiError(400, 'goodsTypeId is invalid');
    const goodsType = await GoodsType.findById(input.goodsTypeId).select('_id').lean();
    if (!goodsType) throw new ApiError(404, 'Goods type not found');
    goodsTypeId = goodsType._id;
  }

  const settings = await getLogisticsSettings();
  const { originHub, destinationHub, sender, receiver } = quote._internal;
  const { awb, qrPayload } = await generateAwb({
    hub: originHub,
    offsetMinutes: settingNumber(settings, 'timezone_offset_minutes', 330),
    trackingBaseUrl: settings.tracking_base_url,
  });

  const shipment = await Shipment.create({
    awb,
    qrPayload,
    bookingUserId: userId,
    bookedVia,
    sender,
    receiver,
    pickupMode: quote.pickupMode,
    originHubId: originHub._id,
    destinationHubId: destinationHub._id,
    // A counter booking is already in the hub's hands.
    currentHubId: null,
    serviceLocationId: quote.serviceLocationId,
    scope: quote.scope,
    distanceKm: quote.distanceKm,
    weightKg: quote.actualWeightKg,
    dimensions: quote.dimensions,
    volumetricWeight: quote.volumetricWeightKg,
    chargeableWeight: quote.chargeableWeightKg,
    sizeCategory: quote.sizeCategory,
    goodsTypeId,
    description: String(input.description || '').trim().slice(0, 500),
    instructions: String(input.instructions || '').trim().slice(0, 500),
    fragile: quote.fragile,
    express: quote.express,
    declaredValue: quote.declaredValue,
    insurance: {
      opted: quote.insuranceOpted,
      premium: quote.pricing.insurancePremium,
      coverAmount: quote.pricing.insuranceCoverAmount,
    },
    scheduledPickupAt: pickupWindow?.startsAt || null,
    pickupSlot: pickupWindow ? { slot: pickupWindow.slot, startsAt: pickupWindow.startsAt, endsAt: pickupWindow.endsAt } : undefined,
    rateCardId: quote.rateCardId,
    pricing: quote.pricing,
    payment: { method: quote.paymentMethod, status: 'pending', amount: quote.pricing.total },
    status: SHIPMENT_STATUS.BOOKED,
    statusUpdatedAt: new Date(),
    slaDueAt: new Date(Date.now() + quote.slaHours * 3600000),
  });

  await recordScanEvent({
    shipment,
    type: 'booked',
    hubId: staff ? originHub._id : null,
    staffId: staff?._id || null,
    actorType: staff ? 'hub_staff' : userId ? 'customer' : 'admin',
    toStatus: SHIPMENT_STATUS.BOOKED,
    meta: { scope: quote.scope, fulfilment: quote.fulfilment },
  });

  let current = shipment;
  // Booked at the hub counter: the parcel is physically there already.
  if (staff && quote.pickupMode === 'drop_at_hub') {
    ({ shipment: current } = await transitionShipment(shipment, SHIPMENT_STATUS.RECEIVED_AT_ORIGIN_HUB, {
      hubId: originHub._id,
      staffId: staff._id,
      actorType: 'hub_staff',
      currentHubId: originHub._id,
      note: 'Booked at hub counter',
    }));
  } else {
    emitShipmentUpdated(shipment, { displayStatus: getDisplayStatus(shipment.status) });
  }

  return { shipment: serializeShipment(current), quote: stripInternal(quote) };
};

export const findShipmentByAwb = async (rawAwb, { populateHubs = false } = {}) => {
  const awb = extractAwbFromScan(rawAwb);
  if (!awb) throw new ApiError(400, 'awb is required');
  let query = Shipment.findOne({ awb });
  if (populateHubs) {
    query = query
      .populate('originHubId', 'code name address')
      .populate('destinationHubId', 'code name address')
      .populate('currentHubId', 'code name address');
  }
  const shipment = await query;
  if (!shipment) throw new ApiError(404, `No shipment with AWB ${awb}`);
  return shipment;
};

export const getShipmentTimeline = async (shipmentId, audience = 'owner') => {
  const events = await ScanEvent.find({ shipmentId })
    .sort({ at: 1 })
    .populate('hubId', 'code name')
    .lean();
  const visible = audience === 'public'
    ? events.filter((event) => !['manifest_add', 'manifest_remove', 'leg_assigned'].includes(event.type))
    : events;
  return visible.map((event) => serializeScanEvent(event, { audience: audience === 'public' ? 'public' : 'hub' }));
};

const ACTIVE_LEG_STATUSES = ['assigned', 'in_progress'];

/// Where the driver carrying this parcel is, when a first/last-mile ride is
/// running. Only the coordinates and a first name go to the public page.
export const getLiveLegLocation = async (shipmentId) => {
  const leg = await ShipmentLeg.findOne({ shipmentId, status: { $in: ACTIVE_LEG_STATUSES }, rideId: { $ne: null } })
    .sort({ createdAt: -1 })
    .lean();
  if (!leg?.rideId) return null;
  const ride = await Ride.findById(leg.rideId)
    .select('liveStatus lastDriverLocation driverId')
    .populate('driverId', 'name vehicleNumber')
    .lean();
  if (!ride?.lastDriverLocation?.coordinates?.length) return null;
  return {
    legType: leg.type,
    rideStatus: ride.liveStatus,
    coordinates: ride.lastDriverLocation.coordinates,
    heading: ride.lastDriverLocation.heading ?? null,
    updatedAt: ride.lastDriverLocation.updatedAt || null,
    driverFirstName: String(ride.driverId?.name || '').split(/\s+/)[0] || '',
  };
};

export const listMyShipments = async ({ userId, status, page = 1, limit = 20 }) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const query = { bookingUserId: userId };
  if (status) query.status = { $in: String(status).split(',') };
  const [items, total] = await Promise.all([
    Shipment.find(query)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('originHubId', 'code name address')
      .populate('destinationHubId', 'code name address')
      .populate('currentHubId', 'code name address'),
    Shipment.countDocuments(query),
  ]);
  return { results: items.map((item) => serializeShipment(item)), total, page: safePage, limit: safeLimit };
};

export const getMyShipment = async ({ userId, awb }) => {
  const shipment = await findShipmentByAwb(awb, { populateHubs: true });
  if (String(shipment.bookingUserId || '') !== String(userId)) throw new ApiError(404, 'Shipment not found');
  const [timeline, live] = await Promise.all([getShipmentTimeline(shipment._id, 'owner'), getLiveLegLocation(shipment._id)]);
  return { ...serializeShipment(shipment), timeline, liveLocation: live };
};

export const trackShipmentPublic = async (awb) => {
  const shipment = await findShipmentByAwb(awb, { populateHubs: true });
  const [timeline, live] = await Promise.all([getShipmentTimeline(shipment._id, 'public'), getLiveLegLocation(shipment._id)]);
  return { ...serializeShipment(shipment, { audience: 'public' }), timeline, liveLocation: live };
};

/// Cancels any first-mile ride still searching or en route, so a driver is
/// not left driving to a parcel that no longer exists. Lazy import: the
/// dispatch service pulls in the whole ride stack.
export const cancelOpenLegs = async (shipmentId, types = ['first_mile']) => {
  const legs = await ShipmentLeg.find({ shipmentId, type: { $in: types }, status: { $in: ['pending', ...ACTIVE_LEG_STATUSES] } });
  if (!legs.length) return 0;
  const { cancelRideByAdmin } = await import('../../services/dispatchService.js');
  for (const leg of legs) {
    if (leg.rideId) {
      await cancelRideByAdmin(leg.rideId).catch((error) =>
        console.warn('[logistics] could not cancel leg ride', String(leg.rideId), error?.message || error),
      );
    }
    leg.status = 'cancelled';
    leg.cancelledAt = new Date();
    await leg.save();
  }
  return legs.length;
};

export const cancelMyShipment = async ({ userId, awb, reason = '' }) => {
  const shipment = await findShipmentByAwb(awb);
  if (String(shipment.bookingUserId || '') !== String(userId)) throw new ApiError(404, 'Shipment not found');
  if (!isCustomerCancellable(shipment.status)) {
    throw new ApiError(409, 'This shipment has already been picked up and can no longer be cancelled');
  }
  await cancelOpenLegs(shipment._id);
  const { shipment: updated } = await transitionShipment(shipment, SHIPMENT_STATUS.CANCELLED, {
    actorType: 'customer',
    note: String(reason || 'Cancelled by customer').slice(0, 300),
  });
  // No refund is issued here: online payment capture for shipments is not
  // wired yet (payment.status stays 'pending' until it is), so there is
  // nothing to refund. When it is, the refund belongs here.
  return serializeShipment(updated);
};

export const rescheduleDelivery = async ({ shipment, date, slot, actorType, staffId = null, hubId = null, note = '' }) => {
  if (!isCustomerReschedulable(shipment.status)) {
    throw new ApiError(409, 'A delivery can be rescheduled only after a failed attempt');
  }
  const window = await resolveSlotWindow({ date, slot });
  const { shipment: updated } = await transitionShipment(shipment, SHIPMENT_STATUS.REATTEMPT_SCHEDULED, {
    actorType,
    staffId,
    hubId,
    reattemptAt: window.startsAt,
    note: note || `Reattempt on ${window.date} ${window.slot}`,
    meta: { date: window.date, slot: window.slot },
  });
  return serializeShipment(updated);
};

export const rescheduleMyShipment = async ({ userId, awb, date, slot }) => {
  const shipment = await findShipmentByAwb(awb);
  if (String(shipment.bookingUserId || '') !== String(userId)) throw new ApiError(404, 'Shipment not found');
  return rescheduleDelivery({ shipment, date, slot, actorType: 'customer' });
};

export const listActiveHubsPublic = async () =>
  (await Hub.find({ status: 'active' }).select('code name type address location operatingHours').lean()).map((hub) => ({
    id: String(hub._id),
    code: hub.code,
    name: hub.name,
    type: hub.type,
    address: hub.address,
    location: hub.location?.coordinates || null,
    operatingHours: hub.operatingHours || [],
  }));
