import { ApiError } from '../../../../utils/ApiError.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { markDeliveryFailed } from '../services/deliveryOutcomeService.js';
import { verifyDeliveryOtp } from '../services/deliveryOtpService.js';
import { syncLegWithRide } from '../services/legDispatchService.js';
import { serializeShipment } from '../services/shipmentLifecycle.js';
import { findShipmentByAwb } from '../services/shipmentService.js';

/// Endpoints for a taxi driver running a hub last-mile leg. The driver app
/// sees an ordinary parcel ride whose `parcel.shipmentAwb` is set; before
/// completing it, it collects the receiver's OTP and posts it here.

const requireDriverLeg = async (shipment, driverId) => {
  const legs = await ShipmentLeg.find({
    shipmentId: shipment._id,
    type: { $in: ['last_mile', 'rto_last_mile'] },
    status: { $in: ['pending', 'assigned', 'in_progress'] },
  });
  for (const leg of legs) await syncLegWithRide(leg);
  const mine = legs.find((leg) => String(leg.driverId || '') === String(driverId));
  if (!mine) throw new ApiError(403, 'You are not delivering this parcel');
  return mine;
};

export const verifyOtp = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  await requireDriverLeg(shipment, req.auth.sub);
  if (shipment.status !== 'out_for_delivery') throw new ApiError(409, 'Parcel is not out for delivery; ask the hub to hand it over first');
  res.json({ success: true, data: await verifyDeliveryOtp({ shipmentId: shipment._id, otp: req.body?.otp }) });
};

export const fail = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  await requireDriverLeg(shipment, req.auth.sub);
  const { reasonCode, note, photo } = req.body || {};
  const result = await markDeliveryFailed({
    shipment,
    reasonCode,
    note,
    photo,
    driverId: req.auth.sub,
    actorType: 'driver',
    hubId: shipment.destinationHubId,
  });
  res.json({ success: true, data: { shipment: serializeShipment(result.shipment), autoRto: result.autoRto } });
};
