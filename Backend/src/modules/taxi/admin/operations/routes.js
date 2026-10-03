import { Router } from 'express';
import {
  getCandidateDrivers,
  getDriverDocuments,
  getDriversAnalytics,
  getLocationHistory,
  getOverview,
  patchDriverDocument,
  patchUserBlock,
  patchUserVerify,
  postApproveDriver,
  postApproveDriverVehicle,
  postApproveFleetVehicle,
  postAssignDriver,
  postRejectDriver,
  postRejectDriverVehicle,
  postRejectFleetVehicle,
} from './controller.js';
import { requireAdminPermission } from './operationsAccess.js';

/// Admin operations routes (manual assignment, live tracking, dashboard and
/// analytics, user/driver/vehicle approval). Mounted from adminRoutes.js after
/// `adminRouter.use('/admin', authenticate(['admin']))`, so every route here is
/// already admin-only; each one also checks the matching panel permission.
///
/// All paths are new and none shadows an existing one: Express matches
/// /admin/users/:id exactly, so /admin/users/:id/verify never reached it.
export const adminOperationsRouter = Router();

const ongoing = requireAdminPermission('ongoing.view', 'ongoing rides');
const geo = requireAdminPermission('geofencing.view', 'live tracking');
const dashboard = requireAdminPermission('dashboard.view', 'the dashboard');
const drivers = requireAdminPermission('drivers.view', 'drivers');
const users = requireAdminPermission('users.view', 'users');
const owners = requireAdminPermission('owners.view', 'fleet vehicles');

// 2.10 Manual driver assignment
adminOperationsRouter.get('/admin/rides/:rideId/candidate-drivers', ongoing, getCandidateDrivers);
adminOperationsRouter.post('/admin/rides/:rideId/assign-driver', ongoing, postAssignDriver);

// 2.3 Live tracking trail / replay
adminOperationsRouter.get('/admin/drivers/:driverId/location-history', geo, getLocationHistory);

// 2.1 / 2.2 / 2.17 Dashboard and analytics
adminOperationsRouter.get('/admin/dashboard/overview', dashboard, getOverview);
adminOperationsRouter.get('/admin/analytics/drivers', dashboard, getDriversAnalytics);

// 2.4 User verify / block with reason
adminOperationsRouter.patch('/admin/users/:id/verify', users, patchUserVerify);
adminOperationsRouter.patch('/admin/users/:id/block', users, patchUserBlock);

// 2.5 Driver document approval
adminOperationsRouter.get('/admin/drivers/:id/documents/review', drivers, getDriverDocuments);
adminOperationsRouter.patch('/admin/drivers/:id/documents/:documentKey', drivers, patchDriverDocument);
adminOperationsRouter.post('/admin/drivers/:id/approve', drivers, postApproveDriver);
adminOperationsRouter.post('/admin/drivers/:id/reject', drivers, postRejectDriver);

// 2.6 Vehicle approval
adminOperationsRouter.post('/admin/drivers/:id/vehicle/approve', drivers, postApproveDriverVehicle);
adminOperationsRouter.post('/admin/drivers/:id/vehicle/reject', drivers, postRejectDriverVehicle);
adminOperationsRouter.post('/admin/fleet-vehicles/:id/approve', owners, postApproveFleetVehicle);
adminOperationsRouter.post('/admin/fleet-vehicles/:id/reject', owners, postRejectFleetVehicle);
