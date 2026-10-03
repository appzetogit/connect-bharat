import { ApiError } from '../../../../utils/ApiError.js';
import { RentalVehicleType } from '../../admin/models/RentalVehicleType.js';
import {
  normalizeDriveMode,
  normalizeSecurityDeposit,
  normalizeWithDriverSurcharge,
  quoteRentalBooking,
} from '../services/rentalBilling.js';
import { resolveAllowedDriveModes } from '../services/rentalBookingHooks.js';
import { getRentalAvailability } from '../services/rentalInventoryService.js';
import { getRentalSettings, isRentalFlagOn } from '../services/rentalSettings.js';
import { assertDepositPending, markDepositHeld } from '../services/rentalDepositService.js';
import { collectRentalCharge, createRentalChargeOrder } from '../services/rentalPayments.js';
import {
  markExtensionPaid,
  quoteExtensionForBooking,
  requestRentalExtension,
  serializeExtension,
  checkExtensionInventory,
} from '../services/rentalExtensionService.js';
import { createDamageReport, disputeDamageReport, listDamageReports, serializeDamageReport } from '../services/rentalDamageService.js';
import { emitRentalToUser, RENTAL_SOCKET_EVENTS } from '../services/rentalEvents.js';
import {
  isObjectId,
  loadUserBooking,
  rentalBookingSnapshot,
  reporterFromReq,
  sendInvoiceJson,
  sendInvoicePdf,
} from './rentalCommon.js';

/// GET /users/rental-config - the global switches an app needs to draw the
/// rental screens.
export const getRentalConfig = async (_req, res) => {
  const settings = await getRentalSettings();
  res.json({
    success: true,
    data: {
      selfDriveEnabled: isRentalFlagOn(settings, 'self_drive_enabled'),
      withDriverEnabled: isRentalFlagOn(settings, 'with_driver_enabled'),
      enforceInventory: isRentalFlagOn(settings, 'enforce_inventory'),
      autoApproveExtensions: isRentalFlagOn(settings, 'auto_approve_extensions'),
      billExtraKm: isRentalFlagOn(settings, 'bill_extra_km'),
      requireSelfDriveKyc: isRentalFlagOn(settings, 'require_self_drive_kyc'),
    },
  });
};

/// GET /users/rental-vehicles/:id/availability?from=&to=&serviceStoreId=
export const getRentalVehicleAvailability = async (req, res) => {
  const vehicleTypeId = String(req.params?.id || '').trim();
  if (!isObjectId(vehicleTypeId)) throw new ApiError(400, 'Valid rental vehicle is required');
  const vehicle = await RentalVehicleType.findById(vehicleTypeId).select('serviceStoreIds').lean();
  if (!vehicle) throw new ApiError(404, 'Rental vehicle not found');

  const serviceStoreId = String(req.query?.serviceStoreId || '').trim();
  const serviceStoreIds = isObjectId(serviceStoreId) ? [serviceStoreId] : vehicle.serviceStoreIds || [];
  const availability = await getRentalAvailability({
    vehicleTypeId,
    from: req.query?.from,
    to: req.query?.to,
    serviceStoreIds,
  });

  res.json({
    success: true,
    data: {
      vehicleTypeId,
      from: availability.from,
      to: availability.to,
      available: availability.available,
      totalUnits: availability.totalUnits,
      usableUnits: availability.usableUnits,
      overlappingBookings: availability.overlappingBookings,
      inventoryTracked: availability.inventoryTracked,
      enforced: availability.enforced,
      bookable: availability.bookable,
    },
  });
};

/// POST /users/rental-bookings/quote - the server's price for a booking the
/// rider is about to make. Apps should show this (and use `payableNow` for
/// the advance) instead of computing it, now that day packages and the
/// with-driver surcharge exist.
export const quoteRentalBookingRequest = async (req, res) => {
  const payload = req.body || {};
  const vehicleTypeId = String(payload.vehicleTypeId || payload.vehicleId || '').trim();
  if (!isObjectId(vehicleTypeId)) throw new ApiError(400, 'Valid rental vehicle is required');
  const vehicle = await RentalVehicleType.findById(vehicleTypeId).lean();
  if (!vehicle || vehicle.active === false || vehicle.status !== 'active') throw new ApiError(404, 'Rental vehicle not found');

  const packageId = String(payload.packageId || payload.selectedPackage?.id || payload.selectedPackage?.packageId || '').trim();
  const pkg = (vehicle.pricing || []).find((item) => String(item?.id || item?.packageId || '').trim() === packageId);
  if (!pkg) throw new ApiError(400, 'Selected rental package is invalid');

  const pickupDateTime = new Date(payload.pickupDateTime);
  const returnDateTime = new Date(payload.returnDateTime);
  if (Number.isNaN(pickupDateTime.getTime()) || Number.isNaN(returnDateTime.getTime()) || returnDateTime <= pickupDateTime) {
    throw new ApiError(400, 'Valid pickupDateTime and returnDateTime (after pickup) are required');
  }

  const settings = await getRentalSettings();
  const allowedDriveModes = resolveAllowedDriveModes(vehicle, settings);
  const requested = normalizeDriveMode(payload.driveMode);
  if (requested && !allowedDriveModes.includes(requested)) throw new ApiError(400, 'This drive mode is not available for this vehicle');
  const driveMode = requested || allowedDriveModes[0] || 'self_drive';

  const quote = quoteRentalBooking({
    pkg,
    pickupDateTime,
    returnDateTime,
    driveMode,
    withDriverSurcharge: normalizeWithDriverSurcharge(vehicle.withDriverSurcharge || {}),
  });
  const advance = vehicle.advancePayment || {};
  const mode = String(advance.paymentMode || '').toLowerCase();
  const rawAdvance = advance.enabled
    ? mode === 'full'
      ? quote.totalCost
      : mode === 'percentage'
        ? (quote.totalCost * Math.max(0, Number(advance.amount || 0))) / 100
        : Math.max(0, Number(advance.amount || 0))
    : 0;
  const payableNow = Math.min(quote.totalCost, Math.round((Math.max(0, rawAdvance) + Number.EPSILON) * 100) / 100);
  const deposit = normalizeSecurityDeposit(vehicle.securityDeposit || {});

  res.json({
    success: true,
    data: {
      ...quote,
      driveMode,
      allowedDriveModes,
      kycRequired: driveMode === 'self_drive',
      payableNow,
      securityDeposit: deposit.enabled ? deposit.amount : 0,
    },
  });
};

/// GET /users/rental-bookings/:id
export const getMyRentalBooking = async (req, res) => {
  const booking = await loadUserBooking(req, { lean: true });
  res.json({ success: true, data: rentalBookingSnapshot(booking) });
};

// --- deposit ----------------------------------------------------------------

/// POST /users/rental-bookings/:id/deposit/order {provider: razorpay|phonepe}
export const createDepositOrder = async (req, res) => {
  const booking = await loadUserBooking(req, { lean: true });
  assertDepositPending(booking);
  const order = await createRentalChargeOrder({
    req,
    provider: req.body?.provider,
    amount: booking.deposit.amount,
    booking,
    purpose: 'security deposit',
  });
  res.status(201).json({ success: true, data: order });
};

/// POST /users/rental-bookings/:id/deposit/pay
export const payDeposit = async (req, res) => {
  const booking = await loadUserBooking(req);
  assertDepositPending(booking);
  const payment = await collectRentalCharge({
    req,
    provider: req.body?.provider,
    amount: booking.deposit.amount,
    booking,
    referenceKey: `rental_deposit_${booking._id}`,
    title: `Rental Security Deposit ${booking.bookingReference}`,
    payload: req.body || {},
  });
  markDepositHeld(booking, { paidVia: payment.provider, paymentId: payment.paymentId, orderId: payment.orderId });
  await booking.save();
  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.depositUpdated, {
    bookingId: String(booking._id),
    status: booking.deposit.status,
    amount: booking.deposit.amount,
  });
  res.status(201).json({ success: true, data: rentalBookingSnapshot(booking.toObject()), message: 'Security deposit paid' });
};

// --- extensions -------------------------------------------------------------

/// POST /users/rental-bookings/:id/extend/quote {newReturnDateTime}
export const quoteExtension = async (req, res) => {
  const booking = await loadUserBooking(req, { lean: true });
  const quote = quoteExtensionForBooking(booking, req.body?.newReturnDateTime);
  const inventory = await checkExtensionInventory(booking, quote.from, quote.to);
  res.json({ success: true, data: { ...quote, available: inventory.allowed } });
};

/// POST /users/rental-bookings/:id/extend {newReturnDateTime, note?}
export const extendMyRentalBooking = async (req, res) => {
  const booking = await loadUserBooking(req);
  const { extension } = await requestRentalExtension(booking, {
    newReturnDateTime: req.body?.newReturnDateTime,
    note: req.body?.note,
  });
  res.status(201).json({
    success: true,
    data: { extension: serializeExtension(extension), booking: rentalBookingSnapshot(booking.toObject()) },
    message: extension.status === 'approved' ? 'Extension approved' : 'Extension requested; waiting for approval',
  });
};

const loadExtension = (booking, extId) => {
  if (!isObjectId(extId)) throw new ApiError(400, 'Valid extension id is required');
  const extension = booking.extensions.id(extId);
  if (!extension) throw new ApiError(404, 'Extension not found');
  if (['paid', 'rejected'].includes(extension.status)) throw new ApiError(409, `This extension is already ${extension.status}`);
  if (!(Number(extension.amount) > 0)) throw new ApiError(400, 'This extension has nothing to pay');
  return extension;
};

/// POST /users/rental-bookings/:id/extensions/:extId/order {provider}
export const createExtensionOrder = async (req, res) => {
  const booking = await loadUserBooking(req);
  const extension = loadExtension(booking, req.params.extId);
  const order = await createRentalChargeOrder({
    req,
    provider: req.body?.provider,
    amount: extension.amount,
    booking,
    purpose: 'extension',
  });
  res.status(201).json({ success: true, data: { ...order, extensionId: String(extension._id) } });
};

/// POST /users/rental-bookings/:id/extensions/:extId/pay
export const payExtension = async (req, res) => {
  const booking = await loadUserBooking(req);
  const extension = loadExtension(booking, req.params.extId);
  const payment = await collectRentalCharge({
    req,
    provider: req.body?.provider,
    amount: extension.amount,
    booking,
    referenceKey: `rental_extension_${extension._id}`,
    title: `Rental Extension ${booking.bookingReference}`,
    payload: req.body || {},
  });
  const result = await markExtensionPaid(booking, extension._id, { provider: payment.provider, paymentId: payment.paymentId });
  res.status(201).json({
    success: true,
    data: { extension: serializeExtension(result.extension), booking: rentalBookingSnapshot(result.booking.toObject()) },
    message: 'Extension paid',
  });
};

// --- damage -----------------------------------------------------------------

/// POST /users/rental-bookings/:id/damage-reports {items[], notes?}
export const reportDamage = async (req, res) => {
  const booking = await loadUserBooking(req);
  const report = await createDamageReport(booking, {
    stage: 'during',
    items: req.body?.items,
    notes: req.body?.notes,
    reporter: reporterFromReq(req),
  });
  res.status(201).json({ success: true, data: serializeDamageReport(report.toObject()) });
};

/// GET /users/rental-bookings/:id/damage-reports
export const listMyDamageReports = async (req, res) => {
  const booking = await loadUserBooking(req, { lean: true });
  res.json({ success: true, data: { results: await listDamageReports({ bookingId: booking._id }) } });
};

/// POST /users/rental-damage-reports/:reportId/dispute {reason}
export const disputeMyDamageReport = async (req, res) => {
  const report = await disputeDamageReport(req.params.reportId, req.auth?.sub, { reason: req.body?.reason });
  res.json({ success: true, data: serializeDamageReport(report.toObject()) });
};

// --- invoice ----------------------------------------------------------------

export const getMyRentalInvoicePdf = async (req, res) => {
  const booking = await loadUserBooking(req, { lean: true });
  await sendInvoicePdf(res, booking._id);
};

export const getMyRentalInvoiceJson = async (req, res) => {
  const booking = await loadUserBooking(req, { lean: true });
  await sendInvoiceJson(res, booking._id);
};
