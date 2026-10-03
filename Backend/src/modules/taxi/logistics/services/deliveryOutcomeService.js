import { ApiError } from '../../../../utils/ApiError.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { verifyDeliveryOtp } from './deliveryOtpService.js';
import { getLogisticsSettings, settingFlag, settingNumber } from './logisticsSettingsService.js';
import { transitionShipment } from './shipmentLifecycle.js';
import { SHIPMENT_STATUS, resolveHubRole } from './shipmentStateMachine.js';

/// Delivered, failed, and returned: the outcomes of a delivery run, shared
/// by the hub panel, the driver endpoints and the ride-completion hook so
/// the attempt counting and auto-RTO rule live in one place.

export const FAILURE_REASON_CODES = Object.freeze({
  customer_unavailable: 'Customer not available',
  wrong_address: 'Wrong or incomplete address',
  refused: 'Customer refused the parcel',
  premises_closed: 'Premises closed',
  cod_not_ready: 'Cash on delivery amount not ready',
  out_of_delivery_area: 'Address outside the delivery area',
  rescheduled_by_customer: 'Customer asked for another day',
  damaged_in_transit: 'Parcel found damaged',
  other: 'Other',
});

const activeLastMileLeg = (shipmentId) =>
  ShipmentLeg.findOne({
    shipmentId,
    type: { $in: ['last_mile', 'rto_last_mile'] },
    status: { $in: ['pending', 'assigned', 'in_progress'] },
  }).sort({ createdAt: -1 });

const closeLeg = async (shipmentId, status) => {
  const leg = await activeLastMileLeg(shipmentId);
  if (!leg) return null;
  leg.status = status;
  if (status === 'completed') leg.completedAt = new Date();
  await leg.save();
  return leg;
};

/// Hands the parcel to whoever is delivering it. `assignee` is a hub runner
/// ({name, phone}) or a taxi driver (driverId) already set on a last-mile leg.
export const markOutForDelivery = async ({ shipment, hubId, staffId = null, actorType = 'hub_staff', assignee = null, driverId = null, legId = null, note = '' }) => {
  const role = resolveHubRole({ hubId, originHubId: shipment.originHubId, destinationHubId: shipment.destinationHubId });
  if (shipment.status === SHIPMENT_STATUS.RECEIVED_AT_ORIGIN_HUB && role !== 'both') {
    throw new ApiError(409, 'This parcel has to travel to its destination hub first');
  }
  let leg = legId ? await ShipmentLeg.findById(legId) : await activeLastMileLeg(shipment._id);
  if (!leg) {
    leg = await ShipmentLeg.create({
      shipmentId: shipment._id,
      awb: shipment.awb,
      type: 'last_mile',
      fromHubId: hubId,
      toAddress: { address: shipment.receiver?.address || '', coordinates: shipment.receiver?.location?.coordinates },
      assignmentMode: driverId ? 'manual_driver' : 'hub_staff',
      driverId: driverId || null,
      assignee: assignee ? { name: String(assignee.name || ''), phone: String(assignee.phone || '') } : undefined,
      status: 'in_progress',
      assignedAt: new Date(),
      startedAt: new Date(),
      createdBy: staffId,
    });
  } else if (leg.status !== 'in_progress') {
    leg.status = 'in_progress';
    leg.startedAt = new Date();
    if (assignee) leg.assignee = { name: String(assignee.name || ''), phone: String(assignee.phone || '') };
    await leg.save();
  }

  const result = await transitionShipment(shipment, SHIPMENT_STATUS.OUT_FOR_DELIVERY, {
    hubId,
    staffId,
    actorType,
    driverId: leg.driverId || driverId || null,
    legId: leg._id,
    currentHubId: null,
    note: note || (leg.assignee?.name ? `Out with ${leg.assignee.name}` : ''),
    extraSet: { legs: [...new Set([...(shipment.legs || []).map(String), String(leg._id)])] },
  });
  return { ...result, leg };
};

/// Delivered to the receiver (or, for an RTO parcel, back to the sender).
///
/// The receiver's OTP is required when `logistics.require_delivery_otp` is
/// on, unless it was already verified (a taxi driver verifies it through the
/// driver endpoint before completing the ride).
export const markDelivered = async ({
  shipment,
  otp,
  photo = '',
  signature = '',
  receivedBy = '',
  codCollectedAmount,
  hubId = null,
  staffId = null,
  driverId = null,
  actorType = 'hub_staff',
  skipOtp = false,
}) => {
  const isRto = [SHIPMENT_STATUS.RTO_INITIATED, SHIPMENT_STATUS.RTO_IN_TRANSIT].includes(shipment.status);
  if (!isRto && shipment.status !== SHIPMENT_STATUS.OUT_FOR_DELIVERY) {
    throw new ApiError(409, 'Only a parcel that is out for delivery can be marked delivered');
  }
  if (!isRto && !skipOtp) {
    const settings = await getLogisticsSettings();
    if (settingFlag(settings, 'require_delivery_otp') && !shipment.deliveryOtp?.verifiedAt) {
      if (!otp) throw new ApiError(400, 'The receiver’s delivery OTP is required');
      await verifyDeliveryOtp({ shipmentId: shipment._id, otp });
    }
  }
  const result = await transitionShipment(shipment, isRto ? SHIPMENT_STATUS.RTO_DELIVERED : SHIPMENT_STATUS.DELIVERED, {
    hubId,
    staffId,
    driverId,
    actorType,
    photo,
    signature,
    receivedBy,
    codCollectedAmount,
    currentHubId: null,
  });
  await closeLeg(shipment._id, 'completed');
  return result;
};

/// A failed attempt. Counts toward `max_delivery_attempts`; reaching it (or
/// a refusal, when `rto_on_refusal` is on) starts the return automatically.
export const markDeliveryFailed = async ({ shipment, reasonCode, note = '', photo = '', hubId = null, staffId = null, driverId = null, actorType = 'hub_staff' }) => {
  const code = String(reasonCode || '').trim().toLowerCase();
  if (!FAILURE_REASON_CODES[code]) {
    throw new ApiError(400, `reasonCode must be one of: ${Object.keys(FAILURE_REASON_CODES).join(', ')}`);
  }
  if (code === 'other' && !String(note || '').trim()) {
    throw new ApiError(400, 'A note is required when the reason is "other"');
  }
  const failed = await transitionShipment(shipment, SHIPMENT_STATUS.DELIVERY_FAILED, {
    hubId,
    staffId,
    driverId,
    actorType,
    reasonCode: code,
    note: note || FAILURE_REASON_CODES[code],
    photo,
    // Back on the destination hub's shelf until it goes out again.
    currentHubId: shipment.destinationHubId,
  });
  await closeLeg(shipment._id, 'failed');

  const settings = await getLogisticsSettings();
  const attemptsMade = failed.shipment.attempts.filter((item) => item.result === 'failed').length;
  const maxAttempts = Math.max(1, settingNumber(settings, 'max_delivery_attempts', 3));
  const refusedRto = code === 'refused' && settingFlag(settings, 'rto_on_refusal');
  const exhausted = settingFlag(settings, 'auto_rto_on_max_attempts') && attemptsMade >= maxAttempts;

  if (refusedRto || exhausted) {
    const rto = await transitionShipment(failed.shipment, SHIPMENT_STATUS.RTO_INITIATED, {
      hubId: hubId || shipment.destinationHubId,
      actorType: 'system',
      reasonCode: refusedRto ? 'refused' : 'max_attempts',
      note: refusedRto ? 'Refused by receiver: returning to sender' : `No delivery after ${attemptsMade} attempts: returning to sender`,
    });
    return { ...rto, autoRto: true, attemptsMade, maxAttempts };
  }
  return { ...failed, autoRto: false, attemptsMade, maxAttempts };
};

export const initiateRto = async ({ shipment, reason = '', hubId = null, staffId = null, actorType = 'hub_staff' }) =>
  transitionShipment(shipment, SHIPMENT_STATUS.RTO_INITIATED, {
    hubId,
    staffId,
    actorType,
    note: String(reason || 'Return to sender').slice(0, 300),
  });
