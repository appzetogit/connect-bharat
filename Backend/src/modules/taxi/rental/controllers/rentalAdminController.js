import { ApiError } from '../../../../utils/ApiError.js';
import { invalidateCachedValue } from '../../../../utils/cache.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { RentalVehicleType } from '../../admin/models/RentalVehicleType.js';
import { createDefaultRentalSettings } from '../data/defaultRentalSettings.js';
import { applyRentalAssignmentUpdate } from '../services/rentalBookingHooks.js';
import {
  createRentalVehicleUnit,
  deleteRentalVehicleUnit,
  getRentalAvailability,
  listRentalVehicleUnits,
  updateRentalVehicleUnit,
} from '../services/rentalInventoryService.js';
import { markDepositHeld, releaseDeposit } from '../services/rentalDepositService.js';
import { decideRentalExtension, serializeExtension } from '../services/rentalExtensionService.js';
import {
  adminActOnDamageReport,
  createDamageReport,
  listDamageReports,
  serializeDamageReport,
} from '../services/rentalDamageService.js';
import { RentalDamageReport } from '../models/RentalDamageReport.js';
import { emitRentalToUser, RENTAL_SOCKET_EVENTS } from '../services/rentalEvents.js';
import { isObjectId, rentalBookingSnapshot, reporterFromReq, sendInvoiceJson, sendInvoicePdf } from './rentalCommon.js';

const loadBooking = async (req) => {
  const id = String(req.params?.id || '').trim();
  if (!isObjectId(id)) throw new ApiError(400, 'Valid rental booking id is required');
  const booking = await RentalBookingRequest.findById(id);
  if (!booking) throw new ApiError(404, 'Rental booking request not found');
  return booking;
};

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// --- settings ---------------------------------------------------------------

/// GET /admin/rental-settings - the `rental` section merged over defaults.
/// (PATCH /admin/general-settings/rental also works; this one returns the
/// defaults too, which that endpoint does not for a section never saved.)
export const getRentalSettingsAdmin = async (_req, res) => {
  const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('rental').lean();
  ok(res, { settings: { ...createDefaultRentalSettings(), ...(doc?.rental || {}) } });
};

export const updateRentalSettingsAdmin = async (req, res) => {
  const input = req.body?.settings || req.body || {};
  const allowed = Object.keys(createDefaultRentalSettings());
  const clean = {};
  for (const key of allowed) {
    if (input[key] !== undefined) clean[key] = ['1', 'true', true, 1].includes(input[key]) ? '1' : '0';
  }
  const doc = await AdminBusinessSetting.findOne({ scope: 'default' });
  if (!doc) throw new ApiError(404, 'Business settings are not initialised');
  doc.rental = { ...createDefaultRentalSettings(), ...(doc.rental || {}), ...clean };
  doc.markModified('rental');
  await doc.save();
  await invalidateCachedValue('cache:settings:rental');
  ok(res, { settings: doc.rental });
};

// --- units ------------------------------------------------------------------

export const listUnits = async (req, res) => ok(res, { results: await listRentalVehicleUnits(req.query || {}) });
export const createUnit = async (req, res) => ok(res, await createRentalVehicleUnit(req.body || {}), 201);
export const updateUnit = async (req, res) => ok(res, await updateRentalVehicleUnit(req.params.id, req.body || {}));
export const deleteUnit = async (req, res) => ok(res, await deleteRentalVehicleUnit(req.params.id));

/// GET /admin/rental-vehicles/:id/availability?from=&to=&serviceStoreId=
export const getAvailabilityAdmin = async (req, res) => {
  const vehicle = isObjectId(req.params.id)
    ? await RentalVehicleType.findById(req.params.id).select('serviceStoreIds').lean()
    : null;
  if (!vehicle) throw new ApiError(404, 'Rental vehicle not found');
  const serviceStoreIds = isObjectId(req.query?.serviceStoreId) ? [req.query.serviceStoreId] : vehicle.serviceStoreIds || [];
  ok(res, await getRentalAvailability({ vehicleTypeId: req.params.id, from: req.query?.from, to: req.query?.to, serviceStoreIds }));
};

/// PATCH /admin/rental-booking-requests/:id/assignment {assignedUnitId?, assignedDriverId?}
export const updateAssignment = async (req, res) => {
  const booking = await loadBooking(req);
  await applyRentalAssignmentUpdate(booking, req.body || {});
  booking.reviewedAt = new Date();
  await booking.save();
  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.bookingUpdated, { bookingId: String(booking._id), status: booking.status });
  ok(res, rentalBookingSnapshot(booking.toObject()));
};

// --- deposits ---------------------------------------------------------------

/// GET /admin/rental-deposits?status=
export const listDeposits = async (req, res) => {
  const filter = { 'deposit.required': true };
  if (req.query?.status) filter['deposit.status'] = String(req.query.status);
  const bookings = await RentalBookingRequest.find(filter)
    .populate('userId', 'name phone email')
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean();
  ok(res, {
    results: bookings.map((booking) => ({
      ...rentalBookingSnapshot(booking),
      customer: {
        name: booking.userId?.name || booking.contactName || '',
        phone: booking.userId?.phone || booking.contactPhone || '',
      },
    })),
  });
};

export const collectDepositAdmin = async (req, res) => {
  const booking = await loadBooking(req);
  const paidVia = String(req.body?.paidVia || 'cash').trim().toLowerCase();
  if (!['cash', 'upi', 'card', 'bank_transfer'].includes(paidVia)) throw new ApiError(400, 'paidVia must be cash, upi, card or bank_transfer');
  markDepositHeld(booking, { paidVia, paymentId: String(req.body?.reference || '').trim() });
  await booking.save();
  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.depositUpdated, { bookingId: String(booking._id), status: booking.deposit.status });
  ok(res, rentalBookingSnapshot(booking.toObject()));
};

/// POST /admin/rental-booking-requests/:id/deposit/release {deductions: [{reason, amount}]}
export const releaseDepositAdmin = async (req, res) => {
  const booking = await loadBooking(req);
  await releaseDeposit(booking, { deductions: req.body?.deductions, actor: 'admin' });
  ok(res, rentalBookingSnapshot(booking.toObject()));
};

// --- extensions -------------------------------------------------------------

/// GET /admin/rental-extensions?status=requested
export const listExtensions = async (req, res) => {
  const status = String(req.query?.status || '').trim();
  const filter = status ? { 'extensions.status': status } : { 'extensions.0': { $exists: true } };
  const bookings = await RentalBookingRequest.find(filter).populate('userId', 'name phone').sort({ updatedAt: -1 }).limit(500).lean();
  const results = [];
  for (const booking of bookings) {
    for (const extension of booking.extensions || []) {
      if (status && extension.status !== status) continue;
      results.push({
        ...serializeExtension(extension),
        bookingId: String(booking._id),
        bookingReference: booking.bookingReference,
        vehicleName: booking.vehicleName,
        bookingStatus: booking.status,
        currentReturnDateTime: booking.returnDateTime,
        customer: { name: booking.userId?.name || booking.contactName || '', phone: booking.userId?.phone || booking.contactPhone || '' },
      });
    }
  }
  ok(res, { results });
};

/// PATCH /admin/rental-booking-requests/:id/extensions/:extId {status: approved|rejected, note?}
export const decideExtension = async (req, res) => {
  const booking = await loadBooking(req);
  if (!isObjectId(req.params.extId)) throw new ApiError(400, 'Valid extension id is required');
  const { extension } = await decideRentalExtension(booking, req.params.extId, {
    status: req.body?.status,
    note: req.body?.note,
    adminId: req.auth?.sub,
  });
  ok(res, { extension: serializeExtension(extension), booking: rentalBookingSnapshot(booking.toObject()) });
};

// --- damage -----------------------------------------------------------------

export const listDamage = async (req, res) => ok(res, { results: await listDamageReports(req.query || {}) });

export const getDamage = async (req, res) => {
  if (!isObjectId(req.params.id)) throw new ApiError(400, 'Valid damage report id is required');
  const report = await RentalDamageReport.findById(req.params.id).lean();
  if (!report) throw new ApiError(404, 'Damage report not found');
  ok(res, serializeDamageReport(report));
};

/// PATCH /admin/rental-damage-reports/:id {action, ...}
export const actOnDamage = async (req, res) => {
  const { report, booking } = await adminActOnDamageReport(req.params.id, req.body || {}, req.auth?.sub);
  ok(res, { report: serializeDamageReport(report.toObject()), booking: rentalBookingSnapshot(booking.toObject()) });
};

/// POST /admin/rental-booking-requests/:id/damage-reports {stage, items[], notes?}
export const reportDamageAdmin = async (req, res) => {
  const booking = await loadBooking(req);
  const report = await createDamageReport(booking, {
    stage: req.body?.stage,
    items: req.body?.items,
    notes: req.body?.notes,
    reporter: reporterFromReq(req),
  });
  ok(res, serializeDamageReport(report.toObject()), 201);
};

// --- invoice ----------------------------------------------------------------

export const getInvoicePdfAdmin = async (req, res) => {
  const booking = await loadBooking(req);
  await sendInvoicePdf(res, booking._id);
};

export const getInvoiceJsonAdmin = async (req, res) => {
  const booking = await loadBooking(req);
  await sendInvoiceJson(res, booking._id);
};
