import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { updateDriver } from '../services/adminService.js';
import { getDashboardOverview, getDriverAnalytics } from './dashboardAnalyticsService.js';
import {
  getDriverDocumentReview,
  rejectDriverApplication,
  reviewDriverDocument,
} from './driverDocumentReviewService.js';
import { getDriverLocationHistory } from './locationHistoryService.js';
import { assignDriverToRide, listCandidateDrivers } from './manualAssignmentService.js';
import { getAdminActorId } from './operationsAccess.js';
import { setUserBlocked, setUserVerified } from './userModerationService.js';
import { reviewDriverOwnVehicle, reviewFleetVehicle } from './vehicleApprovalService.js';
import { Driver } from '../../driver/models/Driver.js';

/// Same envelope as adminController's ok(): { success, data }.
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const postAssignDriver = asyncHandler(async (req, res) =>
  ok(
    res,
    await assignDriverToRide({
      rideId: req.params.rideId,
      driverId: req.body?.driverId ?? req.body?.driver_id,
      force: req.body?.force,
      admin: req.auth?.admin,
      adminId: getAdminActorId(req),
    }),
  ),
);

export const getCandidateDrivers = asyncHandler(async (req, res) =>
  ok(res, await listCandidateDrivers({ rideId: req.params.rideId, query: req.query, admin: req.auth?.admin })),
);

export const getLocationHistory = asyncHandler(async (req, res) =>
  ok(res, await getDriverLocationHistory({ driverId: req.params.driverId, query: req.query, admin: req.auth?.admin })),
);

export const getOverview = asyncHandler(async (req, res) =>
  ok(res, await getDashboardOverview({ query: req.query, admin: req.auth?.admin })),
);

export const getDriversAnalytics = asyncHandler(async (req, res) =>
  ok(res, await getDriverAnalytics({ query: req.query, admin: req.auth?.admin })),
);

export const patchUserVerify = asyncHandler(async (req, res) =>
  ok(
    res,
    await setUserVerified({
      userId: req.params.id,
      verified: req.body?.verified,
      note: req.body?.note,
      adminId: getAdminActorId(req),
    }),
  ),
);

export const patchUserBlock = asyncHandler(async (req, res) =>
  ok(
    res,
    await setUserBlocked({
      userId: req.params.id,
      blocked: req.body?.blocked,
      reason: req.body?.reason,
      adminId: getAdminActorId(req),
    }),
  ),
);

export const getDriverDocuments = asyncHandler(async (req, res) =>
  ok(res, await getDriverDocumentReview(req.params.id, req.auth?.admin)),
);

export const patchDriverDocument = asyncHandler(async (req, res) =>
  ok(
    res,
    await reviewDriverDocument({
      driverId: req.params.id,
      documentKey: req.params.documentKey,
      status: req.body?.status,
      reason: req.body?.reason,
      admin: req.auth?.admin,
      adminId: getAdminActorId(req),
    }),
  ),
);

/// Approve through the existing updateDriver path, so the joining bonus, the
/// auto-subscription and the document guard all run exactly as they do for
/// PATCH /admin/drivers/:id {approve:true}. Also clears an earlier rejection.
export const postApproveDriver = asyncHandler(async (req, res) => {
  const driver = await updateDriver(req.params.id, { approve: true }, req.auth?.admin);
  await Driver.updateOne({ _id: req.params.id }, { $set: { rejectionReason: '', rejectedAt: null } });
  ok(res, { ...driver, rejectionReason: '', rejectedAt: null });
});

export const postRejectDriver = asyncHandler(async (req, res) =>
  ok(res, await rejectDriverApplication({ driverId: req.params.id, reason: req.body?.reason, admin: req.auth?.admin })),
);

const reviewOwnVehicle = (status) => asyncHandler(async (req, res) =>
  ok(
    res,
    await reviewDriverOwnVehicle({
      driverId: req.params.id,
      status,
      reason: req.body?.reason,
      admin: req.auth?.admin,
      adminId: getAdminActorId(req),
    }),
  ),
);

export const postApproveDriverVehicle = reviewOwnVehicle('approved');
export const postRejectDriverVehicle = reviewOwnVehicle('rejected');

const reviewFleet = (status) => asyncHandler(async (req, res) =>
  ok(
    res,
    await reviewFleetVehicle({
      vehicleId: req.params.id,
      status,
      reason: req.body?.reason,
      admin: req.auth?.admin,
      adminId: getAdminActorId(req),
    }),
  ),
);

export const postApproveFleetVehicle = reviewFleet('approved');
export const postRejectFleetVehicle = reviewFleet('rejected');
