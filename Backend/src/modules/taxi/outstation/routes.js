import { Router } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { authenticate } from '../middlewares/authMiddleware.js';
import { paymentOrderRateLimit } from '../middlewares/rateLimitMiddleware.js';
import {
  createAdvanceOrder,
  createTripExpense,
  getRideFareSummary,
  listOutstationRidesForAdmin,
  payAdvanceFromWallet,
  saveOdometerReading,
  verifyAdvancePayment,
  waiveOutstationAdvance,
} from './controllers/outstationController.js';

/// Outstation endpoints (docs/api/outstation.md). Mounted on the taxi router
/// with one line in routes/index.js; the paths sit under /rides and /admin
/// alongside the existing ones but none of them collides with an existing
/// route.
export const outstationRouter = Router();

// Rider: the mandatory advance.
outstationRouter.post('/rides/:rideId/advance/razorpay/order', authenticate(['user']), paymentOrderRateLimit, asyncHandler(createAdvanceOrder));
outstationRouter.post('/rides/:rideId/advance/razorpay/verify', authenticate(['user']), asyncHandler(verifyAdvancePayment));
outstationRouter.post('/rides/:rideId/advance/wallet', authenticate(['user']), asyncHandler(payAdvanceFromWallet));

// Driver: odometer readings and trip expenses.
outstationRouter.post('/rides/:rideId/odometer', authenticate(['driver']), asyncHandler(saveOdometerReading));
outstationRouter.post('/rides/:rideId/expenses', authenticate(['driver']), asyncHandler(createTripExpense));

// Everyone on the ride, and admin.
outstationRouter.get('/rides/:rideId/fare-summary', authenticate(['user', 'driver', 'admin']), asyncHandler(getRideFareSummary));

// Admin.
outstationRouter.get('/admin/outstation/rides', authenticate(['admin']), asyncHandler(listOutstationRidesForAdmin));
outstationRouter.get('/admin/outstation/rides/:rideId/fare-summary', authenticate(['admin']), asyncHandler(getRideFareSummary));
outstationRouter.post('/admin/outstation/rides/:rideId/advance/waive', authenticate(['admin']), asyncHandler(waiveOutstationAdvance));
