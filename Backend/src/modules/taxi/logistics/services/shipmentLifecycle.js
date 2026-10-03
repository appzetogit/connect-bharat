import { ApiError } from '../../../../utils/ApiError.js';
import { ScanEvent } from '../models/ScanEvent.js';
import { Shipment } from '../models/Shipment.js';
import { issueDeliveryOtp } from './deliveryOtpService.js';
import { emitShipmentUpdated } from './logisticsRealtime.js';
import { getLogisticsSettings, settingFlag } from './logisticsSettingsService.js';
import {
  SHIPMENT_STATUS,
  ShipmentTransitionError,
  assertTransition,
  getDisplayStatus,
} from './shipmentStateMachine.js';

/// The one place a shipment's status changes.
///
/// Every caller (hub scan, manifest dispatch, ride-completion hook,
/// customer cancel) passes through `transitionShipment`, which checks the
/// state machine, writes the change conditionally on the status it read (so
/// two scanners racing on one parcel cannot both win), appends the custody
/// log row, and fans the update out over sockets.

const toObjectIdOrNull = (value) => (value ? value : null);

export const recordScanEvent = async ({
  shipment,
  type,
  hubId = null,
  staffId = null,
  driverId = null,
  actorType = 'system',
  fromStatus = '',
  toStatus = '',
  manifestId = null,
  coordinates = null,
  note = '',
  reasonCode = '',
  photo = '',
  discrepancy = false,
  meta = null,
}) =>
  ScanEvent.create({
    shipmentId: shipment._id,
    awb: shipment.awb,
    hubId: toObjectIdOrNull(hubId),
    staffId: toObjectIdOrNull(staffId),
    driverId: toObjectIdOrNull(driverId),
    actorType,
    type,
    fromStatus,
    toStatus,
    manifestId: toObjectIdOrNull(manifestId),
    ...(Array.isArray(coordinates) && coordinates.length === 2
      ? { location: { type: 'Point', coordinates: coordinates.map(Number) } }
      : {}),
    note: String(note || '').slice(0, 500),
    reasonCode: String(reasonCode || ''),
    photo: String(photo || ''),
    discrepancy: Boolean(discrepancy),
    meta,
    at: new Date(),
  });

/// Moves [shipment] to [toStatus]. `ctx.scanType` names the custody-log row
/// (defaults to a sensible type for the status). `ctx.currentHubId`:
/// undefined leaves it, null clears it (parcel left the hub), an id sets it.
export const transitionShipment = async (shipment, toStatus, ctx = {}) => {
  const fromStatus = shipment.status;
  try {
    assertTransition(fromStatus, toStatus);
  } catch (error) {
    if (error instanceof ShipmentTransitionError) throw new ApiError(409, error.message);
    throw error;
  }

  const now = new Date();
  const set = { status: toStatus, statusUpdatedAt: now };
  if (ctx.currentHubId !== undefined) set.currentHubId = ctx.currentHubId || null;
  if (ctx.currentManifestId !== undefined) set.currentManifestId = ctx.currentManifestId || null;

  const attempts = Array.isArray(shipment.attempts) ? shipment.attempts.map((item) => (item.toObject ? item.toObject() : { ...item })) : [];
  const lastPending = [...attempts].reverse().find((item) => item.result === 'pending');

  if (toStatus === SHIPMENT_STATUS.OUT_FOR_DELIVERY) {
    attempts.push({
      number: attempts.length + 1,
      legId: ctx.legId || null,
      driverId: ctx.driverId || null,
      outAt: now,
      result: 'pending',
    });
    set.attempts = attempts;
    set.reattemptAt = null;
  }
  if (toStatus === SHIPMENT_STATUS.DELIVERED) {
    set.deliveredAt = now;
    if (lastPending) Object.assign(lastPending, { result: 'delivered', at: now });
    set.attempts = attempts;
    set['proofOfDelivery.at'] = now;
    if (ctx.photo) set['proofOfDelivery.photo'] = String(ctx.photo);
    if (ctx.signature) set['proofOfDelivery.signature'] = String(ctx.signature);
    if (ctx.receivedBy) set['proofOfDelivery.receivedBy'] = String(ctx.receivedBy);
    if (shipment.payment?.method === 'cod') {
      set['payment.codCollectedAmount'] = Number(ctx.codCollectedAmount ?? shipment.pricing?.total ?? 0);
      set['payment.codCollectedAt'] = now;
      set['payment.codCollectedByHubId'] = ctx.hubId || shipment.destinationHubId || null;
      set['payment.status'] = 'paid';
      set['payment.paidAt'] = now;
    }
  }
  if (toStatus === SHIPMENT_STATUS.RTO_DELIVERED) {
    set.deliveredAt = now;
  }
  if (toStatus === SHIPMENT_STATUS.DELIVERY_FAILED) {
    if (lastPending) {
      Object.assign(lastPending, { result: 'failed', reasonCode: ctx.reasonCode || '', note: ctx.note || '', at: now });
    }
    set.attempts = attempts;
  }
  if (toStatus === SHIPMENT_STATUS.REATTEMPT_SCHEDULED && ctx.reattemptAt) {
    set.reattemptAt = ctx.reattemptAt;
  }
  if (toStatus === SHIPMENT_STATUS.CANCELLED) {
    set.cancelledAt = now;
    set.cancelReason = String(ctx.note || ctx.reasonCode || '');
  }
  if (toStatus === SHIPMENT_STATUS.RTO_INITIATED) {
    set.rtoReason = String(ctx.note || ctx.reasonCode || '');
  }
  // Cash collected by the pickup driver / hub counter counts as paid once
  // the parcel is in the network's hands.
  if (
    [SHIPMENT_STATUS.PICKED_UP, SHIPMENT_STATUS.RECEIVED_AT_ORIGIN_HUB].includes(toStatus) &&
    shipment.payment?.method === 'cash' &&
    shipment.payment?.status === 'pending'
  ) {
    set['payment.status'] = 'paid';
    set['payment.paidAt'] = now;
  }
  Object.assign(set, ctx.extraSet || {});

  const updated = await Shipment.findOneAndUpdate(
    { _id: shipment._id, status: fromStatus },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw new ApiError(409, 'Shipment was updated by someone else a moment ago. Scan it again.');
  }

  await recordScanEvent({
    shipment: updated,
    type: ctx.scanType || defaultScanTypeFor(toStatus),
    hubId: ctx.hubId,
    staffId: ctx.staffId,
    driverId: ctx.driverId,
    actorType: ctx.actorType || 'system',
    fromStatus,
    toStatus,
    manifestId: ctx.manifestId,
    coordinates: ctx.coordinates,
    note: ctx.note,
    reasonCode: ctx.reasonCode,
    photo: ctx.photo,
    discrepancy: ctx.discrepancy,
    meta: ctx.meta,
  });

  let otp = null;
  if (toStatus === SHIPMENT_STATUS.OUT_FOR_DELIVERY) {
    const settings = await getLogisticsSettings();
    if (settingFlag(settings, 'require_delivery_otp')) {
      otp = await issueDeliveryOtp(updated);
    }
  }

  emitShipmentUpdated(updated, { displayStatus: getDisplayStatus(updated.status), fromStatus, hubId: ctx.hubId || null });
  return { shipment: updated, fromStatus, otp };
};

/// A custody-log row with no status change (inbound at a transit hub,
/// manifest add/remove), optionally moving `currentHubId`.
export const logShipmentScan = async (shipment, type, ctx = {}) => {
  let current = shipment;
  const set = {};
  if (ctx.currentHubId !== undefined) set.currentHubId = ctx.currentHubId || null;
  if (ctx.currentManifestId !== undefined) set.currentManifestId = ctx.currentManifestId || null;
  Object.assign(set, ctx.extraSet || {});
  if (Object.keys(set).length) {
    current = (await Shipment.findByIdAndUpdate(shipment._id, { $set: set }, { returnDocument: 'after' })) || shipment;
  }
  await recordScanEvent({
    shipment: current,
    type,
    hubId: ctx.hubId,
    staffId: ctx.staffId,
    driverId: ctx.driverId,
    actorType: ctx.actorType || 'system',
    fromStatus: shipment.status,
    toStatus: shipment.status,
    manifestId: ctx.manifestId,
    coordinates: ctx.coordinates,
    note: ctx.note,
    reasonCode: ctx.reasonCode,
    photo: ctx.photo,
    discrepancy: ctx.discrepancy,
    meta: ctx.meta,
  });
  emitShipmentUpdated(current, { displayStatus: getDisplayStatus(current.status), hubId: ctx.hubId || null, scanType: type });
  return { shipment: current, fromStatus: shipment.status, otp: null };
};

const defaultScanTypeFor = (status) => {
  switch (status) {
    case SHIPMENT_STATUS.PICKED_UP:
      return 'pickup';
    case SHIPMENT_STATUS.RECEIVED_AT_ORIGIN_HUB:
    case SHIPMENT_STATUS.RECEIVED_AT_DESTINATION_HUB:
      return 'inbound';
    case SHIPMENT_STATUS.IN_TRANSIT:
    case SHIPMENT_STATUS.RTO_IN_TRANSIT:
      return 'outbound';
    case SHIPMENT_STATUS.OUT_FOR_DELIVERY:
      return 'out_for_delivery';
    case SHIPMENT_STATUS.DELIVERED:
    case SHIPMENT_STATUS.RTO_DELIVERED:
      return 'delivered';
    case SHIPMENT_STATUS.DELIVERY_FAILED:
      return 'failed';
    case SHIPMENT_STATUS.RTO_INITIATED:
      return 'rto';
    case SHIPMENT_STATUS.CANCELLED:
      return 'cancelled';
    case SHIPMENT_STATUS.REATTEMPT_SCHEDULED:
      return 'rescheduled';
    case SHIPMENT_STATUS.PICKUP_SCHEDULED:
    case SHIPMENT_STATUS.BOOKED:
      return 'leg_assigned';
    default:
      return 'exception';
  }
};

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export const maskPhone = (phone = '') => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return digits ? '*'.repeat(digits.length) : '';
  return `${digits.slice(0, 2)}${'*'.repeat(Math.max(digits.length - 4, 0))}${digits.slice(-2)}`;
};

export const maskName = (name = '') =>
  String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]}${'*'.repeat(Math.max(part.length - 1, 2))}`)
    .join(' ');

/// Only the last two comma-separated parts (typically city, state) of an
/// address are shown on the public tracking page.
export const maskAddress = (address = '') => {
  const parts = String(address || '').split(',').map((part) => part.trim()).filter(Boolean);
  return parts.slice(-2).join(', ');
};

const idString = (value) => (value?._id ? String(value._id) : value ? String(value) : null);

const serializeHubRef = (hub) =>
  hub && typeof hub === 'object' && hub.code
    ? { id: String(hub._id), code: hub.code, name: hub.name, address: hub.address || '' }
    : idString(hub);

const serializeParty = (party = {}, masked = false) => ({
  name: masked ? maskName(party.name) : party.name || '',
  phone: masked ? maskPhone(party.phone) : party.phone || '',
  address: masked ? maskAddress(party.address) : party.address || '',
  ...(masked
    ? {}
    : {
        landmark: party.landmark || '',
        pincode: party.pincode || '',
        location: party.location?.coordinates || null,
      }),
});

/// [audience]: 'owner' (booking user), 'hub' (hub staff, admin) or
/// 'public' (the open tracking page — masked, no money, no OTP state).
export const serializeShipment = (shipment, { audience = 'owner' } = {}) => {
  if (!shipment) return null;
  const s = shipment.toObject ? shipment.toObject() : shipment;
  const masked = audience === 'public';
  const base = {
    id: String(s._id),
    awb: s.awb,
    status: s.status,
    displayStatus: getDisplayStatus(s.status),
    scope: s.scope,
    sender: serializeParty(s.sender, masked),
    receiver: serializeParty(s.receiver, masked),
    originHub: serializeHubRef(s.originHubId),
    destinationHub: serializeHubRef(s.destinationHubId),
    currentHub: serializeHubRef(s.currentHubId),
    express: Boolean(s.express),
    fragile: Boolean(s.fragile),
    chargeableWeight: s.chargeableWeight,
    sizeCategory: s.sizeCategory,
    slaDueAt: s.slaDueAt,
    deliveredAt: s.deliveredAt,
    reattemptAt: s.reattemptAt,
    attemptsCount: (s.attempts || []).length,
    createdAt: s.createdAt,
    statusUpdatedAt: s.statusUpdatedAt,
  };
  if (masked) return base;
  return {
    ...base,
    qrPayload: s.qrPayload,
    bookingUserId: idString(s.bookingUserId),
    pickupMode: s.pickupMode,
    distanceKm: s.distanceKm,
    weightKg: s.weightKg,
    dimensions: s.dimensions,
    volumetricWeight: s.volumetricWeight,
    goodsTypeId: idString(s.goodsTypeId),
    description: s.description,
    instructions: s.instructions,
    declaredValue: s.declaredValue,
    insurance: s.insurance,
    scheduledPickupAt: s.scheduledPickupAt,
    pickupSlot: s.pickupSlot,
    pricing: s.pricing,
    payment: s.payment,
    attempts: s.attempts || [],
    legs: (s.legs || []).map(idString),
    rideIds: (s.rideIds || []).map(idString),
    currentManifestId: idString(s.currentManifestId),
    weightDiscrepancy: s.weightDiscrepancy,
    deliveryOtp: {
      sentAt: s.deliveryOtp?.sentAt || null,
      verified: Boolean(s.deliveryOtp?.verifiedAt),
    },
    proofOfDelivery: s.proofOfDelivery,
    cancelReason: s.cancelReason,
    rtoReason: s.rtoReason,
    ...(audience === 'hub' ? { bookedVia: s.bookedVia } : {}),
  };
};

export const serializeScanEvent = (event, { audience = 'hub' } = {}) => {
  const e = event.toObject ? event.toObject() : event;
  const hub = e.hubId && typeof e.hubId === 'object' && e.hubId.code ? e.hubId : null;
  const base = {
    type: e.type,
    status: e.toStatus || e.fromStatus,
    displayStatus: getDisplayStatus(e.toStatus || e.fromStatus),
    hub: hub ? { code: hub.code, name: hub.name } : null,
    note: audience === 'public' ? '' : e.note,
    reasonCode: e.reasonCode || '',
    at: e.at,
  };
  if (audience === 'public') return base;
  return {
    ...base,
    id: String(e._id),
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    hubId: idString(e.hubId),
    staffId: idString(e.staffId),
    driverId: idString(e.driverId),
    actorType: e.actorType,
    manifestId: idString(e.manifestId),
    photo: e.photo,
    discrepancy: e.discrepancy,
    meta: e.meta,
  };
};
