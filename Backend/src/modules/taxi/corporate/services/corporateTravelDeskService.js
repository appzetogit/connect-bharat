import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { normalizePoint } from '../../../../utils/geo.js';
import { RIDE_STATUS } from '../../constants/index.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { Ride } from '../../user/models/Ride.js';
import { User } from '../../user/models/User.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { notifyRider } from './corporateNotifyService.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';
import { round2 } from './corporatePolicyEngine.js';

/// Travel desk (contract §3.1 /bookings): panel users book a trip for an
/// employee, in the employee's own rider account, through the same
/// createRideRecord + startDispatchFlow path the rider app uses, so pricing,
/// policy, boundary, allowance and dispatch behave identically.
///
/// The ride services are imported lazily: they import the corporate booking
/// service, and this file is only needed by the panel controller.

const ACTIVE_STATUSES = [RIDE_STATUS.SEARCHING, RIDE_STATUS.ACCEPTED, RIDE_STATUS.ONGOING];
const isId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const assertTravelDeskOn = async () => {
  const settings = await getCorporateSettings();
  if (!isFlagOn(settings.travel_desk_enabled)) throw new ApiError(403, 'Travel desk bookings are not available right now');
};

const loadEmployee = async (corporateId, employeeId) => {
  if (!isId(employeeId)) throw new ApiError(400, 'employeeId is required');
  const employee = await CorporateEmployee.findOne({ _id: employeeId, corporateId }).lean();
  if (!employee) throw new ApiError(404, 'Employee not found');
  if (!employee.active) throw new ApiError(409, 'Employee is deactivated');
  if (!employee.userId) throw new ApiError(409, 'Employee has no rider account');
  return employee;
};

/// { lat, lng } / [lng, lat] / GeoJSON -> [lng, lat]
const toCoords = (value, field) => {
  if (Array.isArray(value)) return normalizePoint(value, field);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.coordinates)) return normalizePoint(value.coordinates, field);
    const lat = value.lat ?? value.latitude;
    const lng = value.lng ?? value.longitude;
    if (lat !== undefined && lng !== undefined) return normalizePoint([Number(lng), Number(lat)], field);
  }
  throw new ApiError(400, `${field} must be { lat, lng, address }`);
};

const serviceTypeOf = (value) => {
  const normalized = String(value || 'ride').trim().toLowerCase();
  return normalized === 'intercity' ? 'intercity' : 'ride';
};

export const quoteTravelDeskBooking = async ({ corporate, body = {} }) => {
  await assertTravelDeskOn();
  const employee = await loadEmployee(corporate._id, body.employeeId);
  const { estimateRideFares } = await import('../../services/fareEstimateService.js');
  const estimate = await estimateRideFares({
    userId: employee.userId,
    pickup: toCoords(body.pickup, 'pickup'),
    drop: toCoords(body.drop, 'drop'),
    vehicleTypeId: body.vehicleTypeId || undefined,
    serviceType: serviceTypeOf(body.serviceType),
    scheduledAt: body.scheduledAt || undefined,
    intercity: body.intercity || null,
    paymentMethod: 'corporate',
    corporateId: corporate._id,
  });
  return {
    employee: { id: String(employee._id), name: employee.name, employeeCode: employee.employeeCode },
    distanceMeters: estimate.distance_meters,
    durationMinutes: estimate.duration_minutes,
    quotes: (estimate.quotes || []).map((quote) => ({
      vehicleTypeId: quote.vehicle?.id,
      vehicleName: quote.vehicle?.name || '',
      available: Boolean(quote.corporate?.eligible),
      reason: quote.corporate?.eligible ? '' : quote.corporate?.reason || quote.reason || 'This vehicle cannot be priced',
      fare: quote.corporate?.fare ?? null,
      pricing: quote.corporate?.pricing || 'standard',
      breakdown: quote.corporate?.breakdown || null,
      allowance: quote.corporate?.allowance || null,
      split: quote.corporate?.split || null,
      allowedMethods: quote.corporate?.allowedMethods || [],
      employeePaymentRequired: Boolean(quote.corporate?.employeePaymentRequired),
      withinBoundary: quote.corporate?.withinBoundary ?? true,
    })),
  };
};

export const createTravelDeskBooking = async ({ corporate, admin, body = {} }) => {
  await assertTravelDeskOn();
  const employee = await loadEmployee(corporate._id, body.employeeId);
  if (!isId(body.vehicleTypeId)) throw new ApiError(400, 'vehicleTypeId is required');
  const pickupCoords = toCoords(body.pickup, 'pickup');
  const dropCoords = toCoords(body.drop, 'drop');

  // createRideRecord would cancel a rider's running ride to make room; a
  // booking made on someone's behalf must never do that.
  const user = await User.findById(employee.userId).select('currentRideId').lean();
  if (!user) throw new ApiError(409, 'Employee has no rider account');
  const active = await Ride.exists({ userId: employee.userId, status: { $in: ACTIVE_STATUSES } });
  if (active) throw new ApiError(409, 'This employee already has a trip in progress or booked');

  const { createRideRecord } = await import('../../services/rideService.js');
  const { startDispatchFlow } = await import('../../services/dispatchService.js');
  const ride = await createRideRecord({
    userId: employee.userId,
    pickupCoords,
    dropCoords,
    pickupAddress: String(body.pickup?.address || '').trim(),
    dropAddress: String(body.drop?.address || '').trim(),
    fare: 0,
    estimatedDistanceMeters: 0,
    estimatedDurationMinutes: 0,
    vehicleTypeId: body.vehicleTypeId,
    paymentMethod: 'corporate',
    serviceType: serviceTypeOf(body.serviceType),
    intercity: body.intercity || undefined,
    scheduledAt: body.scheduledAt || undefined,
    corporateId: corporate._id,
    employeePaymentMethod: body.employeePaymentMethod || '',
    corporateBooker: { adminId: admin._id, role: admin.role, note: body.note },
  });
  await startDispatchFlow(ride);

  notifyRider({
    userId: employee.userId,
    title: 'A trip was booked for you',
    body: `${corporate.name} booked a trip for you${ride.pickupAddress ? ` from ${ride.pickupAddress}` : ''}. Open the app to track it.`,
    data: { type: 'corporate_trip_booked', rideId: String(ride._id) },
  });

  return {
    ride: {
      id: String(ride._id),
      status: ride.status,
      fare: ride.fare,
      split: ride.corporate?.split || null,
      allowance: ride.corporate?.allowance || null,
      approvalStatus: ride.corporate?.approvalStatus || 'not_required',
    },
  };
};

export const listTravelDeskBookings = async ({ corporateId, status = '', employeeId = '', from, to, page = 1, limit = 25 }) => {
  const filter = { 'corporate.corporateId': new mongoose.Types.ObjectId(String(corporateId)), 'corporate.bookedByCorporateAdminId': { $ne: null } };
  if (status) filter.status = status;
  if (isId(employeeId)) filter['corporate.employeeId'] = new mongoose.Types.ObjectId(String(employeeId));
  const range = {};
  if (from && !Number.isNaN(new Date(from).getTime())) range.$gte = new Date(from);
  if (to && !Number.isNaN(new Date(to).getTime())) range.$lt = new Date(to);
  if (Object.keys(range).length) filter.createdAt = range;

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const [rides, total] = await Promise.all([
    Ride.find(filter)
      .select('_id status serviceType pickupAddress dropAddress scheduledAt createdAt fare vehicleTypeId corporate')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('corporate.employeeId', 'name employeeCode')
      .populate('corporate.bookedByCorporateAdminId', 'name email')
      .lean(),
    Ride.countDocuments(filter),
  ]);
  const vehicles = await Vehicle.find({ _id: { $in: [...new Set(rides.map((ride) => ride.vehicleTypeId).filter(Boolean).map(String))] } }).select('name').lean();
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.name]));

  return {
    items: rides.map((ride) => {
      const employee = ride.corporate?.employeeId;
      const bookedBy = ride.corporate?.bookedByCorporateAdminId;
      const split = ride.corporate?.split || {};
      return {
        rideId: String(ride._id),
        status: ride.status,
        serviceType: ride.serviceType,
        employee: employee ? { id: String(employee._id || employee), name: employee.name || '', employeeCode: employee.employeeCode || '' } : null,
        pickupAddress: ride.pickupAddress,
        dropAddress: ride.dropAddress,
        vehicleName: vehicleById.get(String(ride.vehicleTypeId)) || '',
        scheduledAt: ride.scheduledAt,
        createdAt: ride.createdAt,
        fare: round2(ride.fare),
        approvalStatus: ride.corporate?.approvalStatus || 'not_required',
        split: {
          companyAmount: round2(split.companyAmount ?? ride.fare),
          employeeAmount: round2(split.employeeAmount || 0),
          employeePaymentMethod: split.employeePaymentMethod || '',
          employeePaymentStatus: split.employeePaymentStatus || 'not_required',
        },
        allowance: ride.corporate?.allowance || null,
        bookedBy: bookedBy ? { id: String(bookedBy._id || bookedBy), name: bookedBy.name || '' } : null,
        note: ride.corporate?.bookingNote || '',
      };
    }),
    total,
    page: safePage,
    limit: safeLimit,
  };
};

/// Cancels a travel-desk booking that has not started (searching / accepted).
export const cancelTravelDeskBooking = async ({ corporate, admin, rideId, reason = '' }) => {
  if (!isId(rideId)) throw new ApiError(400, 'Invalid ride id');
  const ride = await Ride.findOne({
    _id: rideId,
    'corporate.corporateId': corporate._id,
    'corporate.bookedByCorporateAdminId': { $ne: null },
  }).select('_id status liveStatus userId').lean();
  if (!ride) throw new ApiError(404, 'Booking not found');
  if (![RIDE_STATUS.SEARCHING, RIDE_STATUS.ACCEPTED].includes(ride.status) || ['started', 'completed', 'cancelled'].includes(ride.liveStatus)) {
    throw new ApiError(409, `This trip is already ${ride.status} and cannot be cancelled from the travel desk`);
  }
  const { cancelRideByAdmin } = await import('../../services/dispatchService.js');
  const cancelled = await cancelRideByAdmin(ride._id);
  const note = String(reason || '').trim().slice(0, 300);
  notifyRider({
    userId: ride.userId,
    title: 'Trip cancelled by your company',
    body: note ? `${corporate.name} cancelled the trip booked for you: ${note}` : `${corporate.name} cancelled the trip booked for you.`,
    data: { type: 'corporate_trip_cancelled', rideId: String(ride._id) },
  });
  return { rideId: String(ride._id), status: cancelled?.status || 'cancelled', cancelledBy: String(admin._id), reason: note };
};
