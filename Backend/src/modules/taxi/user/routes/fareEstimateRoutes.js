import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { createRateLimitMiddleware } from '../../middlewares/rateLimitMiddleware.js';
import { estimateRide } from '../controllers/fareEstimateController.js';

export const fareEstimateRouter = Router();

/// Signed-in riders are authenticated as usual (a bad token is still a 401);
/// a request with no token at all is quoted anonymously, so the app can show
/// fares before login.
const optionalUserAuth = (req, res, next) => {
  if (!req.headers.authorization) {
    next();
    return;
  }
  authenticate(['user'])(req, res, next);
};

/// Each estimate may cost a Directions call (shared through the route cache)
/// and a few queries per vehicle; keyed on the rider when signed in, else the
/// IP.
const fareEstimateRateLimit = createRateLimitMiddleware({
  scope: 'ride_fare_estimate',
  max: 60,
  windowMs: 60 * 1000,
  mode: 'auth_or_ip',
  message: 'Too many fare estimates. Please wait a moment and try again.',
});

fareEstimateRouter.post('/estimate', optionalUserAuth, fareEstimateRateLimit, asyncHandler(estimateRide));
