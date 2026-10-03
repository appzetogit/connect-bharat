import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RIDE_LIVE_STATUS, RIDE_STATUS } from '../../constants/index.js';
import { User } from '../../user/models/User.js';
import { Ride } from '../../user/models/Ride.js';
import { Hub } from '../models/Hub.js';
import { Shipment } from '../models/Shipment.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { getLogisticsSettings, settingFlag, settingNumber } from './logisticsSettingsService.js';
import { markDelivered, markOutForDelivery } from './deliveryOutcomeService.js';
import { haversineKm } from './scopeDetection.js';
import { logShipmentScan, transitionShipment } from './shipmentLifecycle.js';
import { SHIPMENT_STATUS, resolveHubRole } from './shipmentStateMachine.js';

/// First-mile, last-mile and return legs done by taxi drivers.
///
/// A leg is dispatched as an ordinary parcel `Ride` (createRideRecord with
/// serviceType 'parcel' and serverPricedFareSource 'hub_leg'), so the driver
/// app needs nothing new to run it: it shows up as a parcel job, the driver
/// photographs pickup and delivery as usual, and settlement pays them like
/// any online-paid parcel. The ride carries `parcel.shipmentLegId`, which is
/// how its completion finds its way back here (onParcelRideCompleted).
///
/// The ride stack is imported lazily: rideService → (completion hook) →
/// this module → rideService would otherwise be a load-time cycle.
const rideStack = async () => {
  const [rideService, dispatchService, deliveryService] = await Promise.all([
    import('../../services/rideService.js'),
    import('../../services/dispatchService.js'),
    import('../../user/services/deliveryService.js'),
  ]);
  return { ...rideService, ...dispatchService, getDeliveryQuote: deliveryService.getDeliveryQuote };
};

const OPEN_LEG_STATUSES = ['pending', 'assigned', 'in_progress'];

const LEG_RULES = {
  first_mile: {
    allowedStatuses: [SHIPMENT_STATUS.BOOKED],
    hubField: 'originHubId',
    direction: 'to_hub',
  },
  last_mile: {
    allowedStatuses: [
      SHIPMENT_STATUS.RECEIVED_AT_DESTINATION_HUB,
      SHIPMENT_STATUS.REATTEMPT_SCHEDULED,
      SHIPMENT_STATUS.RECEIVED_AT_ORIGIN_HUB,
    ],
    hubField: 'destinationHubId',
    direction: 'from_hub',
  },
  rto_last_mile: {
    allowedStatuses: [SHIPMENT_STATUS.RTO_INITIATED, SHIPMENT_STATUS.RTO_IN_TRANSIT],
    hubField: 'originHubId',
    direction: 'from_hub',
  },
};

/// Online drivers near a hub for the manual-assignment picker, via the
/// same matcher the dispatcher uses (so a driver listed here is one the
/// dispatcher would also have offered the job to).
export const listNearbyDriversForHub = async ({ hub, vehicleTypeId = null, radiusKm = 5, limit = 20 }) => {
  const { matchDrivers } = await import('../../services/matchingService.js');
  const hubCoords = hub.location?.coordinates;
  const { drivers } = await matchDrivers(hubCoords, {
    maxDistance: Math.max(500, Number(radiusKm) * 1000),
    limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
    ...(vehicleTypeId ? { vehicleTypeId } : {}),
    serviceLocationId: hub.serviceLocationId || null,
  });
  return drivers.map((driver) => ({
    id: String(driver._id),
    name: driver.name || '',
    phone: driver.phone || '',
    vehicleType: driver.vehicleType || '',
    vehicleNumber: driver.vehicleNumber || '',
    rating: driver.rating ?? null,
    isOnRide: Boolean(driver.isOnRide),
    distanceKm: driver.location?.coordinates
      ? Math.round(haversineKm(hubCoords, driver.location.coordinates) * 100) / 100
      : null,
  }));
};

/// Creates the parcel ride for a leg without disturbing the booking user's
/// own trips. createRideRecord would otherwise (a) cancel whatever ride the
/// user has open and (b) make this leg their "current ride", which would
/// pull the rider app into a tracking screen for a hub driver. So the
/// user's pointer is set aside for the call and put back after.
const createLegRide = async ({ shipment, pickupCoords, dropCoords, pickupAddress, dropAddress, vehicleTypeId, fare, scheduledAt, parcel }) => {
  const { createRideRecord } = await rideStack();
  const user = await User.findById(shipment.bookingUserId).select('currentRideId');
  if (!user) throw new ApiError(409, 'Taxi dispatch needs the booking customer’s account; assign a hub runner instead');
  const previousRideId = user.currentRideId || null;
  if (previousRideId) await User.updateOne({ _id: user._id }, { $set: { currentRideId: null } });
  try {
    return await createRideRecord({
      userId: shipment.bookingUserId,
      pickupCoords,
      dropCoords,
      pickupAddress,
      dropAddress,
      fare,
      vehicleTypeId: vehicleTypeId || undefined,
      paymentMethod: 'online',
      serviceType: 'parcel',
      transport_type: 'delivery',
      parcel,
      scheduledAt: scheduledAt || undefined,
      serverPricedFareSource: 'hub_leg',
    });
  } finally {
    await User.updateOne({ _id: user._id }, { $set: { currentRideId: previousRideId } }).catch(() => null);
  }
};

const resolveLegFare = async ({ vehicleTypeId, pickupCoords, dropCoords, settings }) => {
  const fallback = Math.max(0, settingNumber(settings, 'leg_fallback_fare', 80));
  if (!vehicleTypeId) return { fare: fallback, source: 'fallback' };
  try {
    const { getDeliveryQuote } = await rideStack();
    const quote = await getDeliveryQuote({ vehicleTypeId, pickup: pickupCoords, drop: dropCoords });
    if (quote?.total > 0) return { fare: quote.total, source: 'delivery_tariff' };
  } catch {
    // An unpriced vehicle or an out-of-zone hub: pay the flat leg fare.
  }
  return { fare: fallback, source: 'fallback' };
};

/// Dispatches a taxi leg. mode 'auto' searches like any parcel booking;
/// mode 'manual' assigns [driverId] directly (they must be online and free).
export const assignTaxiLeg = async ({ shipment, legType, mode = 'auto', driverId = null, vehicleTypeId = null, hub, staff, scheduledAt = null }) => {
  const rule = LEG_RULES[legType];
  if (!rule) throw new ApiError(400, 'legType must be first_mile, last_mile or rto_last_mile');
  if (!rule.allowedStatuses.includes(shipment.status)) {
    throw new ApiError(409, `A ${legType.replace(/_/g, ' ')} leg cannot be assigned to a ${shipment.status} shipment`);
  }
  if (String(shipment[rule.hubField]) !== String(hub._id)) {
    throw new ApiError(403, `Only the ${rule.hubField === 'originHubId' ? 'origin' : 'destination'} hub can assign this leg`);
  }
  if (legType === 'last_mile' && shipment.status === SHIPMENT_STATUS.RECEIVED_AT_ORIGIN_HUB) {
    const role = resolveHubRole({ hubId: hub._id, originHubId: shipment.originHubId, destinationHubId: shipment.destinationHubId });
    if (role !== 'both') throw new ApiError(409, 'This parcel has to travel to its destination hub first');
  }
  if (mode === 'manual' && !mongoose.Types.ObjectId.isValid(String(driverId || ''))) {
    throw new ApiError(400, 'driverId is required for manual assignment');
  }
  const existing = await ShipmentLeg.findOne({ shipmentId: shipment._id, type: legType, status: { $in: OPEN_LEG_STATUSES } });
  if (existing) throw new ApiError(409, 'This shipment already has an open leg of that type');

  const settings = await getLogisticsSettings();
  const vehicle = vehicleTypeId || settings.leg_vehicle_type_id || null;
  if (vehicle && !mongoose.Types.ObjectId.isValid(String(vehicle))) throw new ApiError(400, 'vehicleTypeId is invalid');
  const hubCoords = hub.location.coordinates;
  const party = legType === 'rto_last_mile' ? shipment.sender : legType === 'last_mile' ? shipment.receiver : shipment.sender;
  const partyCoords = party.location.coordinates;
  const toHub = rule.direction === 'to_hub';
  const pickupCoords = toHub ? partyCoords : hubCoords;
  const dropCoords = toHub ? hubCoords : partyCoords;
  const { fare, source: fareSource } = await resolveLegFare({ vehicleTypeId: vehicle, pickupCoords, dropCoords, settings });

  const leg = await ShipmentLeg.create({
    shipmentId: shipment._id,
    awb: shipment.awb,
    type: legType,
    fromHubId: toHub ? null : hub._id,
    fromAddress: toHub ? { address: party.address, coordinates: partyCoords } : null,
    toHubId: toHub ? hub._id : null,
    toAddress: toHub ? null : { address: party.address, coordinates: partyCoords },
    assignmentMode: mode === 'manual' ? 'manual_driver' : 'taxi_dispatch',
    vehicle: { vehicleTypeId: vehicle || null },
    fare,
    status: 'pending',
    scheduledAt: scheduledAt || null,
    createdBy: staff?._id || null,
  });

  const counterparty = toHub
    ? { name: hub.name, phone: hub.contactPhone || '' }
    : { name: party.name, phone: party.phone };
  const parcel = {
    category: 'Hub parcel',
    description: `AWB ${shipment.awb}${shipment.description ? ` - ${shipment.description}` : ''}`,
    weight: `${shipment.chargeableWeight || shipment.weightKg} kg`,
    senderName: toHub ? shipment.sender.name : hub.name,
    senderMobile: toHub ? shipment.sender.phone : hub.contactPhone || '',
    receiverName: counterparty.name,
    receiverMobile: counterparty.phone,
    instructions: [shipment.fragile ? 'FRAGILE' : '', shipment.instructions || ''].filter(Boolean).join(' · '),
    weightKg: shipment.weightKg,
    fragile: shipment.fragile,
    express: shipment.express,
    shipmentAwb: shipment.awb,
    shipmentId: String(shipment._id),
    shipmentLegId: String(leg._id),
    hubLegType: legType,
  };

  let ride;
  try {
    ride = await createLegRide({
      shipment,
      pickupCoords,
      dropCoords,
      pickupAddress: toHub ? party.address : `${hub.name}, ${hub.address}`,
      dropAddress: toHub ? `${hub.name}, ${hub.address}` : party.address,
      vehicleTypeId: vehicle,
      fare,
      scheduledAt: scheduledAt && new Date(scheduledAt).getTime() > Date.now() ? scheduledAt : null,
      parcel,
    });
  } catch (error) {
    leg.status = 'cancelled';
    leg.cancelledAt = new Date();
    await leg.save();
    throw error;
  }

  const stack = await rideStack();
  if (mode === 'manual') {
    try {
      await stack.acceptRideAssignment({ rideId: ride._id, driverId });
    } catch (error) {
      await stack.cancelRideByAdmin(ride._id).catch(() => null);
      leg.status = 'cancelled';
      leg.cancelledAt = new Date();
      await leg.save();
      throw error;
    }
    await stack.notifyRideAccepted(ride).catch((error) => console.warn('[logistics] notifyRideAccepted failed', error?.message || error));
    stack.emitToDriver(String(driverId), 'logistics:leg:assigned', {
      rideId: String(ride._id),
      awb: shipment.awb,
      legType,
      legId: String(leg._id),
    });
    leg.status = 'assigned';
    leg.driverId = driverId;
    leg.assignedAt = new Date();
  } else {
    await stack.startDispatchFlow(ride);
  }
  leg.rideId = ride._id;
  await leg.save();

  await Shipment.updateOne({ _id: shipment._id }, { $addToSet: { legs: leg._id, rideIds: ride._id } });
  const fresh = await Shipment.findById(shipment._id);
  if (legType === 'first_mile') {
    await transitionShipment(fresh, SHIPMENT_STATUS.PICKUP_SCHEDULED, {
      scanType: 'leg_assigned',
      hubId: hub._id,
      staffId: staff?._id || null,
      actorType: 'hub_staff',
      driverId: mode === 'manual' ? driverId : null,
      note: mode === 'manual' ? 'Pickup driver assigned' : 'Searching for a pickup driver',
      meta: { legId: String(leg._id), rideId: String(ride._id), fare, fareSource },
    });
  } else {
    await logShipmentScan(fresh, 'leg_assigned', {
      hubId: hub._id,
      staffId: staff?._id || null,
      actorType: 'hub_staff',
      driverId: mode === 'manual' ? driverId : null,
      note: `${legType === 'rto_last_mile' ? 'Return' : 'Delivery'} driver ${mode === 'manual' ? 'assigned' : 'requested'}`,
      meta: { legId: String(leg._id), rideId: String(ride._id), fare, fareSource },
    });
  }

  return { leg: leg.toObject(), rideId: String(ride._id), otp: ride.otp || '', fare, fareSource };
};

/// Brings a leg in line with its ride: driver accepted, started, or the
/// ride was cancelled / found nobody. Called when hub screens read legs and
/// from the completion hook; cheap when nothing changed.
export const syncLegWithRide = async (leg) => {
  if (!leg?.rideId || !OPEN_LEG_STATUSES.includes(leg.status)) return leg;
  const ride = await Ride.findById(leg.rideId).select('status liveStatus driverId startedAt completedAt').lean();
  if (!ride) return leg;
  let changed = false;

  if (ride.status === RIDE_STATUS.CANCELLED) {
    leg.status = 'cancelled';
    leg.cancelledAt = new Date();
    changed = true;
    if (leg.type === 'first_mile') {
      const shipment = await Shipment.findById(leg.shipmentId);
      if (shipment?.status === SHIPMENT_STATUS.PICKUP_SCHEDULED) {
        await transitionShipment(shipment, SHIPMENT_STATUS.BOOKED, {
          scanType: 'leg_assigned',
          actorType: 'system',
          note: 'Pickup ride was cancelled; waiting for the hub to reassign',
        }).catch(() => null);
      }
    }
  } else {
    if (ride.driverId && String(leg.driverId || '') !== String(ride.driverId)) {
      leg.driverId = ride.driverId;
      leg.assignedAt = leg.assignedAt || new Date();
      if (leg.status === 'pending') leg.status = 'assigned';
      changed = true;
    }
    if ([RIDE_LIVE_STATUS.STARTED, RIDE_LIVE_STATUS.ARRIVED].includes(ride.liveStatus) && leg.status !== 'in_progress') {
      leg.status = 'in_progress';
      leg.startedAt = ride.startedAt || new Date();
      changed = true;
      // Ride started = driver has the parcel (the app made them photograph it).
      if (leg.type === 'first_mile') {
        const shipment = await Shipment.findById(leg.shipmentId);
        if (shipment?.status === SHIPMENT_STATUS.PICKUP_SCHEDULED) {
          await transitionShipment(shipment, SHIPMENT_STATUS.PICKED_UP, {
            actorType: 'driver',
            driverId: ride.driverId,
            note: 'Collected from sender',
          }).catch(() => null);
        }
      }
    }
  }
  if (changed) await leg.save();
  return leg;
};

/// Called once from rideService when a driver completes a parcel ride.
/// A no-op for rides that are not hub legs.
export const handleLegRideCompleted = async (ride) => {
  const legId = ride?.parcel?.shipmentLegId;
  const leg = legId && mongoose.Types.ObjectId.isValid(String(legId))
    ? await ShipmentLeg.findById(legId)
    : await ShipmentLeg.findOne({ rideId: ride?._id });
  if (!leg) return null;
  // The leg id on a ride comes from the parcel payload, which any booking
  // client can fill in. Only the ride this module dispatched may move it.
  if (String(leg.rideId || '') !== String(ride?._id || '')) return null;
  if (['completed', 'cancelled'].includes(leg.status)) return leg;

  // Pick up a missed "started" transition first (picked_up for first mile).
  await syncLegWithRide(leg);
  if (leg.status === 'cancelled') return leg;
  const driverId = ride.driverId?._id || ride.driverId || null;
  const proofPhoto = ride.parcel?.deliveryProof?.url || '';
  let shipment = await Shipment.findById(leg.shipmentId);
  if (!shipment) return leg;

  if (leg.type === 'first_mile') {
    if (shipment.status === SHIPMENT_STATUS.PICKUP_SCHEDULED) {
      ({ shipment } = await transitionShipment(shipment, SHIPMENT_STATUS.PICKED_UP, {
        actorType: 'driver',
        driverId,
        note: 'Collected from sender',
      }));
    }
    leg.status = 'completed';
    leg.completedAt = ride.completedAt || new Date();
    await leg.save();
    await logShipmentScan(shipment, 'pickup', {
      hubId: leg.toHubId,
      driverId,
      actorType: 'driver',
      photo: proofPhoto,
      note: 'Dropped at origin hub by pickup driver; awaiting inbound scan',
    });
    return leg;
  }

  // last_mile / rto_last_mile
  const hubId = leg.fromHubId;
  if (leg.type === 'last_mile' && shipment.status !== SHIPMENT_STATUS.OUT_FOR_DELIVERY) {
    try {
      ({ shipment } = await markOutForDelivery({ shipment, hubId, actorType: 'system', driverId, legId: leg._id, note: 'Handed to delivery driver (no hub scan)' }));
    } catch (error) {
      await logShipmentScan(shipment, 'exception', { hubId, driverId, actorType: 'system', note: `Delivery ride completed but parcel could not go out for delivery: ${error.message}` });
      return leg;
    }
  }

  const settings = await getLogisticsSettings();
  const needsOtp = leg.type === 'last_mile' && settingFlag(settings, 'require_delivery_otp');
  const fresh = await Shipment.findById(shipment._id);
  if (needsOtp && !fresh.deliveryOtp?.verifiedAt) {
    // Without the receiver's OTP the hub has to confirm delivery itself.
    await logShipmentScan(fresh, 'exception', {
      hubId,
      driverId,
      actorType: 'system',
      photo: proofPhoto,
      note: 'Driver completed the delivery ride without the receiver OTP; confirm delivery or mark failed',
    });
    return leg;
  }
  await markDelivered({ shipment: fresh, photo: proofPhoto, driverId, actorType: 'driver', hubId, skipOtp: true });
  return leg;
};

export const listHubLegs = async ({ hubId, status, type, limit = 100 }) => {
  const query = { $or: [{ fromHubId: hubId }, { toHubId: hubId }] };
  if (status) query.status = { $in: String(status).split(',') };
  else query.status = { $in: OPEN_LEG_STATUSES };
  if (type) query.type = { $in: String(type).split(',') };
  const legs = await ShipmentLeg.find(query).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 100, 500));
  for (const leg of legs) await syncLegWithRide(leg);
  const rides = await Ride.find({ _id: { $in: legs.map((leg) => leg.rideId).filter(Boolean) } })
    .select('otp liveStatus status lastDriverLocation driverId')
    .populate('driverId', 'name phone vehicleNumber')
    .lean();
  const rideById = new Map(rides.map((ride) => [String(ride._id), ride]));
  return legs.map((leg) => {
    const ride = leg.rideId ? rideById.get(String(leg.rideId)) : null;
    return {
      ...leg.toObject(),
      ride: ride
        ? {
            id: String(ride._id),
            status: ride.status,
            liveStatus: ride.liveStatus,
            // The pickup/handover OTP the driver must be given at the hub.
            otp: ride.otp || '',
            driver: ride.driverId ? { name: ride.driverId.name, phone: ride.driverId.phone, vehicleNumber: ride.driverId.vehicleNumber } : null,
            location: ride.lastDriverLocation?.coordinates || null,
          }
        : null,
    };
  });
};

export const getHubById = (hubId) => Hub.findById(hubId).lean();
