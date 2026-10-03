import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../../driver/models/Driver.js';
import { FleetVehicle } from '../models/FleetVehicle.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { emitToDriverRoom } from './adminFeedService.js';
import { assertObjectId, assertServiceLocationScope } from './operationsAccess.js';
import { getOperationsGates } from './operationsSettings.js';

/// Vehicle approval, for both kinds of vehicle a driver can drive:
///   - company vehicles (FleetVehicle, owned by a fleet owner), which already
///     had a pending/approved/rejected status set through generic CRUD;
///   - self-owned vehicles, which live inline on the Driver (vehicleNumber,
///     vehicleMake...) and are reviewed through Driver.vehicleApproval.
///
/// Imported by matchingService for the dispatch gate, so it must not import
/// rideService or dispatchService (both are above matchingService in the
/// import graph). Socket emits go through adminFeedService's lazy path.

export const VEHICLE_REVIEW_STATUSES = Object.freeze(['approved', 'rejected']);

const normalizeReason = (reason) => String(reason || '').trim().slice(0, 1000);

const assertReviewInput = (status, reason) => {
  if (!VEHICLE_REVIEW_STATUSES.includes(status)) {
    throw new ApiError(400, 'status must be approved or rejected');
  }
  if (status === 'rejected' && !reason) {
    throw new ApiError(400, 'A reason is required to reject a vehicle');
  }
};

const serializeFleetVehicleReview = (vehicle) => ({
  id: String(vehicle._id),
  owner_id: vehicle.owner_id ? String(vehicle.owner_id) : null,
  license_plate_number: vehicle.license_plate_number || '',
  status: vehicle.status,
  reason: vehicle.reason || '',
  reviewedBy: vehicle.reviewedBy ? String(vehicle.reviewedBy) : null,
  reviewedAt: vehicle.reviewedAt || null,
});

export const reviewFleetVehicle = async ({ vehicleId, status, reason = '', admin = null, adminId = null }) => {
  assertObjectId(vehicleId, 'vehicleId');
  const trimmedReason = normalizeReason(reason);
  assertReviewInput(status, trimmedReason);

  const vehicle = await FleetVehicle.findById(vehicleId);
  if (!vehicle) throw new ApiError(404, 'Fleet vehicle not found');
  assertServiceLocationScope(admin, vehicle.service_location_id);

  vehicle.status = status;
  vehicle.reason = status === 'rejected' ? trimmedReason : '';
  vehicle.reviewedBy = adminId || null;
  vehicle.reviewedAt = new Date();
  await vehicle.save();

  // The drivers who drive this vehicle are the ones whose work changes.
  const drivers = await Driver.find({ assignedFleetVehicleId: vehicle._id }).select('_id').lean();
  const driverIds = drivers.map((driver) => String(driver._id));
  const payload = { fleetVehicleId: String(vehicle._id), status, reason: vehicle.reason };
  driverIds.forEach((driverId) => emitToDriverRoom(driverId, 'driver:vehicle:reviewed', payload));
  if (driverIds.length && status === 'rejected') {
    sendPushNotificationToEntities({
      driverIds,
      title: 'Vehicle not approved',
      body: `${vehicle.license_plate_number}: ${trimmedReason}`,
      data: { type: 'fleet_vehicle_rejected', fleetVehicleId: String(vehicle._id), reason: trimmedReason },
    }).catch((error) => console.error('Failed to send fleet-vehicle-rejected push', error?.message || error));
  }

  return serializeFleetVehicleReview(vehicle);
};

export const reviewDriverOwnVehicle = async ({ driverId, status, reason = '', admin = null, adminId = null }) => {
  assertObjectId(driverId, 'driverId');
  const trimmedReason = normalizeReason(reason);
  assertReviewInput(status, trimmedReason);

  const existing = await Driver.findById(driverId).select('service_location_id vehicleNumber').lean();
  if (!existing) throw new ApiError(404, 'Driver not found');
  assertServiceLocationScope(admin, existing.service_location_id);

  const vehicleApproval = {
    status,
    reason: status === 'rejected' ? trimmedReason : '',
    reviewedBy: adminId || null,
    reviewedAt: new Date(),
  };
  await Driver.updateOne({ _id: driverId }, { $set: { vehicleApproval } });

  const payload = { driverId: String(driverId), ...vehicleApproval, reviewedBy: adminId ? String(adminId) : null };
  emitToDriverRoom(driverId, 'driver:vehicle:reviewed', payload);
  sendPushNotificationToEntities({
    driverIds: [String(driverId)],
    title: status === 'approved' ? 'Vehicle approved' : 'Vehicle not approved',
    body: status === 'approved'
      ? `${existing.vehicleNumber || 'Your vehicle'} is approved for trips.`
      : trimmedReason,
    data: { type: `driver_vehicle_${status}`, reason: vehicleApproval.reason },
  }).catch((error) => console.error('Failed to send driver-vehicle push', error?.message || error));

  return payload;
};

/// Is this driver's vehicle cleared to take trips? Pure; used by manual
/// assignment and the candidate list. A fleet driver is judged by their
/// assigned company vehicle, an independent driver by vehicleApproval.
export const isDriverVehicleApproved = (driver = {}, fleetVehicle = null) => {
  if (driver?.assignedFleetVehicleId) {
    return String(fleetVehicle?.status || '') === 'approved';
  }
  return String(driver?.vehicleApproval?.status || '') === 'approved';
};

/// Mongo filter for dispatch: only drivers with an approved vehicle. Returns {}
/// unless customization.require_vehicle_approval is '1', so dispatch is
/// unchanged by default. Wrapped in $and so it never collides with the $or
/// clauses the match filter already uses.
export const buildVehicleApprovalDispatchFilter = async () => {
  const gates = await getOperationsGates();
  if (!gates.requireVehicleApproval) return {};

  const approvedFleetVehicleIds = await FleetVehicle.find({ status: 'approved', active: { $ne: false } }).distinct('_id');

  return {
    $and: [
      {
        $or: [
          { assignedFleetVehicleId: null, 'vehicleApproval.status': 'approved' },
          { assignedFleetVehicleId: { $in: approvedFleetVehicleIds } },
        ],
      },
    ],
  };
};
