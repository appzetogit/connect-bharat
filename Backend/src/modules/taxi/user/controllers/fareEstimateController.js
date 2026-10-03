import { estimateRideFares } from '../../services/fareEstimateService.js';

/// POST /rides/estimate. The rider may be signed in or not; a signed-in rider
/// gets user-specific promo checks (per-user limits, user-only codes).
export const estimateRide = async (req, res) => {
  const body = req.body || {};
  const data = await estimateRideFares({
    userId: req.auth?.role === 'user' ? req.auth.sub : null,
    pickup: body.pickup,
    drop: body.drop,
    vehicleTypeIds: body.vehicleTypeIds,
    vehicleTypeId: body.vehicleTypeId,
    zone_id: body.zone_id,
    service_location_id: body.service_location_id,
    transport_type: body.transport_type,
    serviceType: body.serviceType,
    scheduledAt: body.scheduledAt,
    intercity: body.intercity || null,
    promo_code: body.promo_code,
    estimatedDistanceMeters: body.estimatedDistanceMeters,
    estimatedDurationMinutes: body.estimatedDurationMinutes,
  });

  res.json({ success: true, data });
};
