import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { ServiceStore } from '../../admin/models/ServiceStore.js';
import { ServiceCenterStaff } from '../../admin/models/ServiceCenterStaff.js';
import { computeRentalBillingMetrics } from '../services/rentalBilling.js';
import { serializeRentalBookingExtras } from '../services/rentalBookingHooks.js';
import { buildRentalInvoicePdf, buildRentalInvoiceModel } from '../services/rentalInvoiceService.js';

export const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

/// Compact booking view returned by the rental-module endpoints. The full
/// legacy shape still comes from GET /users/rental-bookings and the admin
/// list, which now also carry every field below.
export const rentalBookingSnapshot = (item = {}) => {
  const settledAt = item.billingEndedAt || item.completedAt || item.completionRequestedAt || null;
  return {
    id: String(item._id || ''),
    bookingReference: item.bookingReference || '',
    status: item.status || 'pending',
    vehicleTypeId: String(item.vehicleTypeId?._id || item.vehicleTypeId || ''),
    vehicleName: item.vehicleName || '',
    pickupDateTime: item.pickupDateTime || null,
    returnDateTime: item.returnDateTime || null,
    totalCost: Number(item.totalCost || 0),
    payableNow: Number(item.payableNow || 0),
    paymentStatus: item.paymentStatus || 'pending',
    finalCharge: Number(item.finalCharge || 0),
    ...serializeRentalBookingExtras(item),
    rideMetrics: computeRentalBillingMetrics(item, settledAt),
  };
};

export const loadUserBooking = async (req, { lean = false } = {}) => {
  const bookingId = String(req.params?.id || '').trim();
  const userId = String(req.auth?.sub || '').trim();
  if (!isObjectId(bookingId)) throw new ApiError(400, 'Valid rental booking id is required');
  if (!isObjectId(userId)) throw new ApiError(401, 'Authenticated user id is invalid');
  const query = RentalBookingRequest.findOne({ _id: bookingId, userId });
  const booking = lean ? await query.lean() : await query;
  if (!booking) throw new ApiError(404, 'Rental booking not found');
  return booking;
};

/// Service-centre access, the same rules as driverController's
/// resolveAuthenticatedServiceCenterAccess (not exported from that hot file):
/// a centre owner sees every booking of the centre, staff only theirs.
export const resolveServiceCenterAccess = async (req) => {
  const role = String(req.auth?.role || '').toLowerCase();
  if (role === 'service_center') {
    const center = await ServiceStore.findById(req.auth?.sub).lean();
    if (!center || center.active === false || String(center.status || '').toLowerCase() === 'inactive') return null;
    return { role, center, staff: null, canAssignBookings: true };
  }
  if (role === 'service_center_staff') {
    const staff = await ServiceCenterStaff.findById(req.auth?.sub).lean();
    if (!staff || staff.active === false || String(staff.status || '').toLowerCase() === 'inactive') return null;
    const center = await ServiceStore.findById(staff.serviceCenterId).lean();
    if (!center || center.active === false || String(center.status || '').toLowerCase() === 'inactive') return null;
    return { role, center, staff, canAssignBookings: false };
  }
  return null;
};

export const loadServiceCenterBooking = async (req) => {
  const access = await resolveServiceCenterAccess(req);
  if (!access?.center?._id) throw new ApiError(403, 'Service center access is required');
  const bookingId = String(req.params?.bookingId || '').trim();
  if (!isObjectId(bookingId)) throw new ApiError(400, 'Valid booking id is required');
  const booking = await RentalBookingRequest.findById(bookingId);
  if (!booking) throw new ApiError(404, 'Rental booking request not found');
  const centerIds = (booking.serviceCenterIds || []).map(String);
  if (!centerIds.includes(String(access.center._id))) {
    throw new ApiError(403, 'This booking is not assigned to your service center');
  }
  if (access.staff?._id && String(booking.assignedStaffId || '') !== String(access.staff._id)) {
    throw new ApiError(403, 'Staff can only manage bookings assigned to them');
  }
  return { access, booking };
};

export const reporterFromReq = (req, access = null) => {
  const role = String(req.auth?.role || '').toLowerCase();
  return {
    role: ['user', 'service_center', 'service_center_staff', 'admin'].includes(role) ? role : 'user',
    id: String(req.auth?.sub || ''),
    name: access?.staff?.name || access?.center?.name || '',
  };
};

export const sendInvoicePdf = async (res, bookingId) => {
  const { buffer, filename } = await buildRentalInvoicePdf({ bookingId });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
};

export const sendInvoiceJson = async (res, bookingId) => {
  const model = await buildRentalInvoiceModel({ bookingId });
  res.json({ success: true, data: model });
};
