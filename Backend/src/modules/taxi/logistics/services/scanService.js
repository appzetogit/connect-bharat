import { ApiError } from '../../../../utils/ApiError.js';
import { initiateRto, markDelivered, markDeliveryFailed, markOutForDelivery } from './deliveryOutcomeService.js';
import { inboundShipment } from './inboundService.js';
import { addToManifest, removeFromManifest } from './manifestService.js';
import { logShipmentScan, serializeShipment, transitionShipment } from './shipmentLifecycle.js';
import { findShipmentByAwb } from './shipmentService.js';
import { SCAN_TYPES, getDisplayStatus, resolveHubRole, resolveScanOutcome } from './shipmentStateMachine.js';

/// POST /logistics/hub/scan — the one endpoint a barcode scanner talks to.
///
/// Every scan is validated against the state machine before anything is
/// written, and the response says plainly what happened (fromStatus →
/// toStatus, warnings) so the operator gets an immediate beep/flash rather
/// than finding out at the next hub.

const requireAtHub = (shipment, hub) => {
  if (String(shipment.currentHubId || '') !== String(hub._id)) {
    throw new ApiError(409, 'Parcel is not recorded at this hub; inbound-scan it first');
  }
};

export const scanAtHub = async ({ hub, staff, body = {} }) => {
  const type = String(body.type || 'inbound').trim().toLowerCase();
  if (!SCAN_TYPES.includes(type)) throw new ApiError(400, `type must be one of: ${SCAN_TYPES.join(', ')}`);
  const shipment = await findShipmentByAwb(body.awb);
  const hubRole = resolveHubRole({ hubId: hub._id, originHubId: shipment.originHubId, destinationHubId: shipment.destinationHubId });
  const common = { hubId: hub._id, staffId: staff?._id || null, actorType: 'hub_staff' };
  let result;
  let warnings = [];

  switch (type) {
    case 'inbound': {
      const inbound = await inboundShipment({
        shipment,
        hub,
        staff,
        weightKg: body.weightKg,
        dimensions: body.dimensions,
        note: body.note,
        photo: body.photo,
        coordinates: body.coordinates,
      });
      result = inbound;
      warnings = inbound.warnings;
      break;
    }
    case 'manifest_add':
    case 'manifest_remove': {
      if (!body.manifestId) throw new ApiError(400, 'manifestId is required for manifest scans');
      const fn = type === 'manifest_add' ? addToManifest : removeFromManifest;
      const outcome = await fn({ hub, staff, manifestId: body.manifestId, awb: shipment.awb });
      return {
        awb: shipment.awb,
        type,
        fromStatus: shipment.status,
        toStatus: shipment.status,
        displayStatus: getDisplayStatus(shipment.status),
        warnings: outcome.warnings || [],
        manifest: outcome.manifest || outcome,
      };
    }
    case 'out_for_delivery':
      requireAtHub(shipment, hub);
      result = await markOutForDelivery({ shipment, ...common, assignee: body.assignee, driverId: body.driverId || null, note: body.note });
      break;
    case 'delivered': {
      // At the hub: a receiver collecting at the counter, or an RTO parcel
      // handed back to the sender at the origin hub.
      const isRto = ['rto_initiated', 'rto_in_transit'].includes(shipment.status);
      if (isRto && !['origin', 'both'].includes(hubRole)) throw new ApiError(409, 'Returned parcels are handed back at the origin hub');
      if (isRto) requireAtHub(shipment, hub);
      if (!isRto && !['destination', 'both'].includes(hubRole)) throw new ApiError(403, 'Only the destination hub can deliver this parcel');
      result = await markDelivered({
        shipment,
        otp: body.otp,
        photo: body.photo,
        signature: body.signature,
        receivedBy: body.receivedBy,
        codCollectedAmount: body.codCollectedAmount,
        ...common,
      });
      break;
    }
    case 'failed':
      if (!['destination', 'both'].includes(hubRole)) throw new ApiError(403, 'Only the destination hub can record a failed delivery');
      result = await markDeliveryFailed({ shipment, reasonCode: body.reasonCode, note: body.note, photo: body.photo, ...common });
      warnings = result.autoRto ? ['Maximum attempts reached: return to sender started'] : [];
      break;
    case 'rto':
      if (![shipment.originHubId, shipment.destinationHubId, shipment.currentHubId].map(String).includes(String(hub._id))) {
        throw new ApiError(403, 'Only a hub holding or routing this parcel can return it');
      }
      result = await initiateRto({ shipment, reason: body.note || body.reason, ...common });
      break;
    case 'pickup':
    case 'outbound':
    case 'exception': {
      if (type === 'outbound') requireAtHub(shipment, hub);
      const outcome = resolveScanOutcome({ status: shipment.status, scanType: type, hubRole, exceptionType: body.exceptionType });
      if (!outcome.allowed) throw new ApiError(409, outcome.reason);
      const ctx = {
        ...common,
        scanType: type,
        note: body.note,
        photo: body.photo,
        coordinates: body.coordinates,
        reasonCode: type === 'exception' ? String(body.exceptionType || '') : '',
        discrepancy: type === 'exception',
        ...(type === 'outbound' ? { currentHubId: null } : {}),
      };
      result = outcome.nextStatus ? await transitionShipment(shipment, outcome.nextStatus, ctx) : await logShipmentScan(shipment, type, ctx);
      break;
    }
    default:
      throw new ApiError(400, 'Unsupported scan type');
  }

  const updated = result.shipment;
  return {
    awb: updated.awb,
    type,
    fromStatus: shipment.status,
    toStatus: updated.status,
    displayStatus: getDisplayStatus(updated.status),
    warnings,
    weightCheck: result.weightCheck || null,
    deliveryOtp: result.otp ? { sms: result.otp.sms, debugOtp: result.otp.debugOtp } : undefined,
    shipment: serializeShipment(updated, { audience: 'hub' }),
  };
};
