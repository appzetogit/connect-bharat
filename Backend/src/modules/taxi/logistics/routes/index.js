import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import {
  loginRateLimit,
  otpSendRateLimit,
  otpVerifyRateLimit,
  routeRateLimit,
} from '../../middlewares/rateLimitMiddleware.js';
import * as customer from '../controllers/customerController.js';
import * as driver from '../controllers/driverLogisticsController.js';
import * as hub from '../controllers/hubController.js';
import { requireHubManagerRole, requireHubStaff } from '../middleware/hubAuth.js';

/// Everything under /logistics (mounted at /api/logistics and
/// /api/v1/logistics by routes/index.js). Customer, public, hub-panel and
/// driver endpoints for the hub parcel network; see docs/api/logistics.md.
export const logisticsRouter = Router();

// --- public ---------------------------------------------------------------
logisticsRouter.get('/track/:awb', routeRateLimit, asyncHandler(customer.trackPublic));
logisticsRouter.get('/hubs', asyncHandler(customer.hubs));
logisticsRouter.get('/pickup-slots', asyncHandler(customer.pickupSlots));

// --- customer (rider app) ------------------------------------------------------
// Static paths before /shipments/:awb.
logisticsRouter.post('/shipments/quote', authenticate(['user']), asyncHandler(customer.quote));
logisticsRouter.post('/shipments', authenticate(['user']), asyncHandler(customer.book));
logisticsRouter.get('/shipments', authenticate(['user']), asyncHandler(customer.listMine));
logisticsRouter.get(
  '/shipments/:awb/label.pdf',
  authenticate(['user', 'hub_manager', 'admin']),
  asyncHandler(customer.label),
);
logisticsRouter.get('/shipments/:awb', authenticate(['user']), asyncHandler(customer.getMine));
logisticsRouter.post('/shipments/:awb/cancel', authenticate(['user']), asyncHandler(customer.cancelMine));
logisticsRouter.post('/shipments/:awb/reschedule', authenticate(['user']), asyncHandler(customer.rescheduleMine));

// --- driver (taxi driver on a hub last-mile leg) -----------------------------------
logisticsRouter.post('/driver/shipments/:awb/verify-otp', authenticate(['driver']), asyncHandler(driver.verifyOtp));
logisticsRouter.post('/driver/shipments/:awb/fail', authenticate(['driver']), asyncHandler(driver.fail));

// --- hub panel ------------------------------------------------------------------
logisticsRouter.post('/hub/auth/send-otp', otpSendRateLimit, asyncHandler(hub.sendOtp));
logisticsRouter.post('/hub/auth/verify-otp', otpVerifyRateLimit, asyncHandler(hub.verifyOtp));
logisticsRouter.post('/hub/auth/login', loginRateLimit, asyncHandler(hub.passwordLogin));

const hubRouter = Router();
hubRouter.use(authenticate(['hub_manager']), requireHubStaff);

hubRouter.get('/me', asyncHandler(hub.me));
hubRouter.get('/dashboard', asyncHandler(hub.dashboard));
hubRouter.get('/hubs', asyncHandler(hub.hubDirectory));
hubRouter.get('/shipments', asyncHandler(hub.shipments));
hubRouter.post('/shipments', asyncHandler(hub.counterBooking));
hubRouter.get('/shipments/:awb', asyncHandler(hub.shipmentDetail));
hubRouter.post('/shipments/:awb/assign-leg', asyncHandler(hub.assignLeg));
hubRouter.post('/shipments/:awb/deliver', asyncHandler(hub.deliver));
hubRouter.post('/shipments/:awb/fail', asyncHandler(hub.fail));
hubRouter.post('/shipments/:awb/reschedule', asyncHandler(hub.reschedule));
hubRouter.post('/shipments/:awb/rto', asyncHandler(hub.rto));
hubRouter.post('/shipments/:awb/resend-otp', asyncHandler(hub.resendOtp));
hubRouter.post('/scan', asyncHandler(hub.scan));
hubRouter.post('/out-for-delivery', asyncHandler(hub.outForDelivery));
hubRouter.get('/drivers/nearby', asyncHandler(hub.nearbyDrivers));
hubRouter.get('/legs', asyncHandler(hub.legs));

hubRouter.get('/manifests', asyncHandler(hub.manifestsList));
hubRouter.post('/manifests', asyncHandler(hub.manifestCreate));
hubRouter.get('/manifests/:id', asyncHandler(hub.manifestGet));
hubRouter.post('/manifests/:id/add', asyncHandler(hub.manifestAdd));
hubRouter.post('/manifests/:id/remove', asyncHandler(hub.manifestRemove));
hubRouter.post('/manifests/:id/seal', asyncHandler(hub.manifestSeal));
hubRouter.post('/manifests/:id/dispatch', asyncHandler(hub.manifestDispatch));
hubRouter.post('/manifests/:id/in-transit', asyncHandler(hub.manifestInTransit));
hubRouter.post('/manifests/:id/receive', asyncHandler(hub.manifestReceive));
hubRouter.post('/manifests/:id/close', asyncHandler(hub.manifestClose));
hubRouter.post('/manifests/:id/discrepancies/:index/resolve', asyncHandler(hub.manifestResolve));

hubRouter.get('/reports/revenue', requireHubManagerRole, asyncHandler(hub.revenue));
hubRouter.get('/reports/performance', asyncHandler(hub.performance));

logisticsRouter.use('/hub', hubRouter);
