import { ApiError } from '../../../../utils/ApiError.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { RentalVehicleUnit } from '../models/RentalVehicleUnit.js';
import { serializeRentalVehicleUnit } from '../services/rentalInventoryService.js';
import { applyRentalAssignmentUpdate } from '../services/rentalBookingHooks.js';
import { markDepositHeld, releaseDeposit } from '../services/rentalDepositService.js';
import { createDamageReport, listDamageReports, serializeDamageReport } from '../services/rentalDamageService.js';
import { emitRentalToUser, RENTAL_SOCKET_EVENTS } from '../services/rentalEvents.js';
import {
  loadServiceCenterBooking,
  rentalBookingSnapshot,
  reporterFromReq,
  resolveServiceCenterAccess,
  sendInvoiceJson,
  sendInvoicePdf,
} from './rentalCommon.js';

/// Service-centre (and centre staff) side of the rental module, mounted under
/// /drivers next to the existing /service-center/* routes.

/// GET /drivers/service-center/rental-units
export const listServiceCenterUnits = async (req, res) => {
  const access = await resolveServiceCenterAccess(req);
  if (!access?.center?._id) throw new ApiError(403, 'Service center access is required');
  const units = await RentalVehicleUnit.find({ serviceStoreId: access.center._id })
    .populate('rentalVehicleTypeId', 'name')
    .sort({ registrationNumber: 1 })
    .lean();
  res.json({ success: true, data: { results: units.map(serializeRentalVehicleUnit) } });
};

/// PATCH /drivers/service-center/bookings/:bookingId/assignment {assignedUnitId}
/// A centre may only hand out its own units.
export const assignServiceCenterUnit = async (req, res) => {
  const { access, booking } = await loadServiceCenterBooking(req);
  const unitId = String(req.body?.assignedUnitId ?? '').trim();
  if (unitId) {
    const unit = await RentalVehicleUnit.findById(unitId).select('serviceStoreId').lean();
    if (!unit || String(unit.serviceStoreId || '') !== String(access.center._id)) {
      throw new ApiError(403, 'You can only assign vehicles of your service center');
    }
  }
  await applyRentalAssignmentUpdate(booking, { assignedUnitId: unitId });
  await booking.save();
  res.json({ success: true, data: rentalBookingSnapshot(booking.toObject()) });
};

/// POST /drivers/service-center/bookings/:bookingId/damage-reports
/// {stage: pre|post, items[], notes?}. A `post` report also ticks
/// `rentalInspection.afterReturn.damageReviewed`.
export const reportServiceCenterDamage = async (req, res) => {
  const { access, booking } = await loadServiceCenterBooking(req);
  const stage = ['pre', 'post'].includes(String(req.body?.stage || '')) ? req.body.stage : 'post';
  const report = await createDamageReport(booking, {
    stage,
    items: req.body?.items,
    notes: req.body?.notes,
    reporter: reporterFromReq(req, access),
  });
  res.status(201).json({ success: true, data: serializeDamageReport(report.toObject()) });
};

export const listServiceCenterDamageReports = async (req, res) => {
  const { booking } = await loadServiceCenterBooking(req);
  res.json({ success: true, data: { results: await listDamageReports({ bookingId: booking._id }) } });
};

/// POST /drivers/service-center/bookings/:bookingId/deposit/collect
/// {paidVia: cash|upi|card, reference?} - deposit taken at the counter.
export const collectServiceCenterDeposit = async (req, res) => {
  const { booking } = await loadServiceCenterBooking(req);
  const paidVia = String(req.body?.paidVia || 'cash').trim().toLowerCase();
  if (!['cash', 'upi', 'card'].includes(paidVia)) throw new ApiError(400, 'paidVia must be cash, upi or card');
  markDepositHeld(booking, { paidVia, paymentId: String(req.body?.reference || '').trim() });
  await booking.save();
  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.depositUpdated, {
    bookingId: String(booking._id),
    status: booking.deposit.status,
    amount: booking.deposit.amount,
  });
  res.json({ success: true, data: rentalBookingSnapshot(booking.toObject()) });
};

/// POST /drivers/service-center/bookings/:bookingId/deposit/release
/// {deductions: [{reason, amount}]}
export const releaseServiceCenterDeposit = async (req, res) => {
  const { booking } = await loadServiceCenterBooking(req);
  await releaseDeposit(booking, { deductions: req.body?.deductions, actor: String(req.auth?.role || 'service_center') });
  res.json({ success: true, data: rentalBookingSnapshot(booking.toObject()), message: 'Deposit released' });
};

export const getServiceCenterInvoicePdf = async (req, res) => {
  const { booking } = await loadServiceCenterBooking(req);
  await sendInvoicePdf(res, booking._id);
};

export const getServiceCenterInvoiceJson = async (req, res) => {
  const { booking } = await loadServiceCenterBooking(req);
  await sendInvoiceJson(res, booking._id);
};

/// GET /drivers/rental-assignments - with-driver rentals assigned to the
/// calling driver.
export const listMyRentalAssignments = async (req, res) => {
  const bookings = await RentalBookingRequest.find({
    assignedDriverId: req.auth?.sub,
    status: { $in: ['pending', 'confirmed', 'assigned', 'end_requested'] },
  })
    .sort({ pickupDateTime: 1 })
    .limit(100)
    .lean();
  res.json({
    success: true,
    data: {
      results: bookings.map((booking) => ({
        ...rentalBookingSnapshot(booking),
        contactName: booking.contactName || '',
        contactPhone: booking.contactPhone || '',
        serviceLocation: booking.serviceLocation || {},
      })),
    },
  });
};
