import mongoose from 'mongoose';
import { Router } from 'express';
import { ApiError } from '../../../../utils/ApiError.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { Ride } from '../../user/models/Ride.js';
import { serializeRideRealtime, getRideDetails } from '../../services/rideService.js';
import { acceptRideOffer, rejectRideOffer } from '../services/rideOfferActionService.js';
import { getDriverEarnings, listDriverEarningRides } from '../services/driverEarningsService.js';

/**
 * Driver-app endpoints added for the SOW: REST accept/reject for ride offers
 * and the earnings history. Mounted under /drivers ahead of the existing
 * driver router, from driver/routes/index.js.
 */

export const driverExtrasRouter = Router();

const driverOnly = authenticate(['driver']);

const assertRideId = (value) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new ApiError(400, 'rideId is not a valid id');
  }
};

/// REST twin of the socket `acceptRide` event, for when the socket is down.
/// Same service call and the same emits (see rideOfferActionService), and it
/// answers with the full ride so the app can open the trip screen directly.
driverExtrasRouter.post('/ride-offers/:rideId/accept', driverOnly, asyncHandler(async (req, res) => {
  assertRideId(req.params.rideId);
  const { acceptedPayload } = await acceptRideOffer({ rideId: req.params.rideId, driverId: req.auth.sub });
  const ride = await getRideDetails(req.params.rideId);

  res.json({
    success: true,
    data: { ...acceptedPayload, ride: serializeRideRealtime(ride) },
  });
}));

/// REST twin of the socket `rejectRide` event.
driverExtrasRouter.post('/ride-offers/:rideId/reject', driverOnly, asyncHandler(async (req, res) => {
  assertRideId(req.params.rideId);
  const exists = await Ride.exists({ _id: req.params.rideId });
  if (!exists) {
    throw new ApiError(404, 'Ride not found');
  }

  const payload = await rejectRideOffer({ rideId: req.params.rideId, driverId: req.auth.sub });
  res.json({ success: true, data: { ...payload, rejected: true } });
}));

driverExtrasRouter.get('/earnings', driverOnly, asyncHandler(async (req, res) => {
  const data = await getDriverEarnings({
    driverId: req.auth.sub,
    range: req.query.range || 'day',
    from: req.query.from,
    to: req.query.to,
  });
  res.json({ success: true, data });
}));

driverExtrasRouter.get('/earnings/rides', driverOnly, asyncHandler(async (req, res) => {
  const data = await listDriverEarningRides({
    driverId: req.auth.sub,
    range: req.query.range,
    from: req.query.from,
    to: req.query.to,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.json({ success: true, data });
}));
