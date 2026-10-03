import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../../driver/models/Driver.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { RentalVehicleUnit } from '../models/RentalVehicleUnit.js';
import {
  normalizeDriveMode,
  normalizeDriveModes,
  normalizeSecurityDeposit,
  normalizeWithDriverSurcharge,
  quoteRentalBooking,
  resolvePackageTerms,
  roundMoney,
} from './rentalBilling.js';
import { RENTAL_UNUSABLE_UNIT_STATUSES } from './rentalAvailability.js';
import { assertRentalInventoryAvailable, assertUnitFreeForWindow } from './rentalInventoryService.js';
import { getRentalSettings, isRentalFlagOn } from './rentalSettings.js';
import { emitRentalToDriver, RENTAL_SOCKET_EVENTS } from './rentalEvents.js';

/// The few places the existing rental code calls into the rental module.
/// Each is a single line at the call site, so the shared controllers barely
/// change; all the logic is here.

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));
const idString = (value) => (value?._id ? String(value._id) : value ? String(value) : '');

/// Drive modes a rider may pick for this vehicle right now: the vehicle's own
/// list, filtered by the global switches.
export const resolveAllowedDriveModes = (vehicle = {}, settings = {}) =>
  normalizeDriveModes(vehicle.driveModes).filter((mode) =>
    mode === 'self_drive'
      ? isRentalFlagOn(settings, 'self_drive_enabled')
      : isRentalFlagOn(settings, 'with_driver_enabled'),
  );

const computeAdvance = (vehicle = {}, totalCost = 0) => {
  const config = vehicle.advancePayment || {};
  const mode = String(config.paymentMode || '').trim().toLowerCase();
  const raw = config.enabled
    ? mode === 'full'
      ? totalCost
      : mode === 'percentage'
        ? (totalCost * Math.max(0, Number(config.amount || 0))) / 100
        : Math.max(0, Number(config.amount || 0))
    : 0;
  return Math.min(totalCost, Math.round((Math.max(0, raw) + Number.EPSILON) * 100) / 100);
};

/// Fields to merge into a new rental booking (createRentalBookingRequest).
///
/// Returns only what changes: for an hour package, self-drive, with no
/// deposit configured, the price fields are not touched at all, so the
/// booking is priced exactly as before. Also enforces inventory (behind
/// `rental.enforce_inventory`), the drive-mode switches and, if turned on,
/// self-drive KYC.
export const prepareRentalBookingExtras = async ({
  payload = {},
  vehicle = {},
  matchedPackage = {},
  update = {},
}) => {
  const settings = await getRentalSettings();
  const allowedModes = resolveAllowedDriveModes(vehicle, settings);
  const requestedMode = normalizeDriveMode(payload.driveMode);

  if (requestedMode && !allowedModes.includes(requestedMode)) {
    throw new ApiError(400, `${requestedMode === 'with_driver' ? 'With-driver' : 'Self-drive'} rental is not available for this vehicle`);
  }
  const driveMode = requestedMode || allowedModes[0];
  if (!driveMode) {
    throw new ApiError(400, 'This vehicle is not available for rental right now');
  }

  const kycRequired = driveMode === 'self_drive';
  if (
    kycRequired &&
    isRentalFlagOn(settings, 'require_self_drive_kyc') &&
    !String(update.kycDocuments?.drivingLicense?.imageUrl || '').trim()
  ) {
    throw new ApiError(400, 'A driving licence is required for a self-drive rental');
  }

  const surcharge = normalizeWithDriverSurcharge(vehicle.withDriverSurcharge || {});
  const terms = resolvePackageTerms(matchedPackage);
  const quote = quoteRentalBooking({
    pkg: matchedPackage,
    pickupDateTime: update.pickupDateTime,
    returnDateTime: update.returnDateTime,
    driveMode,
    withDriverSurcharge: surcharge,
  });

  const extras = {
    selectedPackage: {
      ...(update.selectedPackage || {}),
      pricingUnit: terms.pricingUnit,
      billedDays: quote.billedDays,
      includedKm: terms.includedKm,
      extraKmPrice: terms.extraKmPrice,
      extraDayPrice: terms.extraDayPrice,
      ...(terms.pricingUnit === 'day'
        ? { durationHours: quote.includedHours, price: terms.price }
        : {}),
    },
    driveMode,
    kycRequired,
    withDriverSurcharge: driveMode === 'with_driver' ? surcharge : { amount: 0, unit: surcharge.unit },
    driverSurchargeAmount: quote.driverSurcharge,
    billingTerms: { kmBillingEnabled: isRentalFlagOn(settings, 'bill_extra_km') },
  };

  if (roundMoney(quote.totalCost) !== roundMoney(update.totalCost)) {
    const payableNow = computeAdvance(vehicle, quote.totalCost);
    const requestedStatus = String(payload.paymentStatus || '').trim().toLowerCase();
    const paymentStatus = payableNow > 0
      ? requestedStatus === 'paid'
        ? 'paid'
        : requestedStatus === 'failed'
          ? 'failed'
          : 'pending'
      : 'not_required';
    extras.totalCost = quote.totalCost;
    extras.payableNow = payableNow;
    extras.paymentStatus = paymentStatus;
    extras.payment = {
      ...(update.payment || {}),
      status: String(payload.payment?.status || '').trim() || paymentStatus,
      amount: paymentStatus === 'not_required' ? 0 : Math.max(0, Number(payload.payment?.amount || payableNow || 0)),
    };
  }

  // Corporate rental: stored only, the corporate module acts on it.
  if (isObjectId(payload.corporateId)) {
    extras.corporateId = payload.corporateId;
    extras.billingMode = String(payload.billingMode || 'corporate') === 'self' ? 'self' : 'corporate';
    if (isObjectId(payload.corporateEmployeeId)) {
      extras.corporateEmployeeId = payload.corporateEmployeeId;
    }
  }

  // The create endpoint is an upsert on bookingReference, so a resubmission
  // must not reset a deposit the rider has already paid.
  const existing = update.bookingReference
    ? await RentalBookingRequest.findOne({ bookingReference: update.bookingReference, userId: update.userId })
        .select('deposit')
        .lean()
    : null;
  const existingStatus = String(existing?.deposit?.status || '');
  if (!existing || ['', 'not_required', 'pending'].includes(existingStatus)) {
    const deposit = normalizeSecurityDeposit(vehicle.securityDeposit || {});
    extras.deposit = deposit.enabled && deposit.amount > 0
      ? { required: true, amount: deposit.amount, status: 'pending', deductions: [] }
      : { required: false, amount: 0, status: 'not_required', deductions: [] };
  }

  await assertRentalInventoryAvailable({
    vehicleTypeId: idString(update.vehicleTypeId || vehicle._id),
    from: update.pickupDateTime,
    to: update.returnDateTime,
    serviceStoreIds: update.serviceCenterIds || [],
    excludeBookingReference: update.bookingReference || '',
  });

  return extras;
};

/// Extra response fields for a rental booking. Spread into the existing
/// serializers, so every existing key keeps its shape.
export const serializeRentalBookingExtras = (item = {}) => ({
  driveMode: item.driveMode || 'self_drive',
  kycRequired: item.kycRequired !== false && (item.driveMode || 'self_drive') === 'self_drive',
  packageTerms: {
    pricingUnit: item.selectedPackage?.pricingUnit || 'hour',
    billedDays: Number(item.selectedPackage?.billedDays || 0),
    includedKm: Number(item.selectedPackage?.includedKm || 0),
    extraKmPrice: Number(item.selectedPackage?.extraKmPrice || 0),
    extraDayPrice: Number(item.selectedPackage?.extraDayPrice || 0),
  },
  withDriverSurcharge: {
    amount: Number(item.withDriverSurcharge?.amount || 0),
    unit: item.withDriverSurcharge?.unit || 'per_day',
  },
  driverSurchargeAmount: Number(item.driverSurchargeAmount || 0),
  billingTerms: {
    kmBillingEnabled: item.billingTerms?.kmBillingEnabled === true,
  },
  billingEndedAt: item.billingEndedAt || null,
  assignedUnit: {
    id: idString(item.assignedUnitId),
    registrationNumber: item.assignedUnitRegistration || '',
  },
  assignedDriver: {
    id: idString(item.assignedDriverId),
    name: item.assignedDriverName || '',
    phone: item.assignedDriverPhone || '',
  },
  deposit: {
    required: Boolean(item.deposit?.required),
    amount: Number(item.deposit?.amount || 0),
    status: item.deposit?.status || 'not_required',
    paidVia: item.deposit?.paidVia || '',
    paymentId: item.deposit?.paymentId || '',
    paidAt: item.deposit?.paidAt || null,
    releasedAmount: Number(item.deposit?.releasedAmount || 0),
    releasedAt: item.deposit?.releasedAt || null,
    releasedVia: item.deposit?.releasedVia || '',
    deductions: (Array.isArray(item.deposit?.deductions) ? item.deposit.deductions : []).map((entry) => ({
      id: idString(entry._id),
      reason: entry.reason || '',
      amount: Number(entry.amount || 0),
      damageReportId: idString(entry.damageReportId),
      createdAt: entry.createdAt || null,
    })),
  },
  extensions: (Array.isArray(item.extensions) ? item.extensions : []).map((entry) => ({
    id: idString(entry._id),
    from: entry.from || null,
    to: entry.to || null,
    hours: Number(entry.hours || 0),
    amount: Number(entry.amount || 0),
    includedKm: Number(entry.includedKm || 0),
    status: entry.status || 'requested',
    paymentId: entry.paymentId || '',
    paidVia: entry.paidVia || '',
    paidAt: entry.paidAt || null,
    autoApproved: Boolean(entry.autoApproved),
    note: entry.note || '',
    decidedAt: entry.decidedAt || null,
    createdAt: entry.createdAt || null,
  })),
  additionalCharges: (Array.isArray(item.additionalCharges) ? item.additionalCharges : []).map((entry) => ({
    id: idString(entry._id),
    type: entry.type || 'damage',
    reason: entry.reason || '',
    amount: Number(entry.amount || 0),
    damageReportId: idString(entry.damageReportId),
    createdAt: entry.createdAt || null,
  })),
  damageReportIds: (Array.isArray(item.damageReportIds) ? item.damageReportIds : []).map(idString),
  invoice: {
    invoiceNumber: item.invoice?.invoiceNumber || '',
    generatedAt: item.invoice?.generatedAt || null,
    emailedAt: item.invoice?.emailedAt || null,
  },
  corporateId: idString(item.corporateId),
  corporateEmployeeId: idString(item.corporateEmployeeId),
  billingMode: item.billingMode || 'self',
});

/// Mongo filter for the admin booking list. Every key is optional; with none
/// the list is unfiltered, as it always was.
export const buildRentalBookingListFilter = (query = {}) => {
  const filter = {};
  if (isObjectId(query.corporateId)) filter.corporateId = query.corporateId;
  if (['self', 'corporate'].includes(String(query.billingMode || ''))) filter.billingMode = query.billingMode;
  if (['self_drive', 'with_driver'].includes(String(query.driveMode || ''))) filter.driveMode = query.driveMode;
  if (query.status && typeof query.status === 'string') filter.status = query.status;
  if (query.depositStatus && typeof query.depositStatus === 'string') filter['deposit.status'] = query.depositStatus;
  if (isObjectId(query.vehicleTypeId)) filter.vehicleTypeId = query.vehicleTypeId;
  return filter;
};

/// Applies `assignedUnitId` / `assignedDriverId` from an admin update to a
/// booking document (not saved here; the caller saves).
export const applyRentalAssignmentUpdate = async (item, payload = {}) => {
  if (!item || !payload || typeof payload !== 'object') return item;

  if (payload.assignedUnitId !== undefined) {
    const unitId = String(payload.assignedUnitId || '').trim();
    const previousUnitId = idString(item.assignedUnitId);

    if (!unitId) {
      item.assignedUnitId = null;
      item.assignedUnitRegistration = '';
    } else if (unitId !== previousUnitId) {
      if (!isObjectId(unitId)) throw new ApiError(400, 'assignedUnitId is invalid');
      const unit = await RentalVehicleUnit.findById(unitId).lean();
      if (!unit) throw new ApiError(404, 'Rental vehicle unit not found');
      if (RENTAL_UNUSABLE_UNIT_STATUSES.includes(String(unit.status))) {
        throw new ApiError(409, `This unit is ${unit.status} and cannot be assigned`);
      }
      const allowedTypeIds = [idString(item.vehicleTypeId), idString(item.assignedVehicle?.vehicleId)].filter(Boolean);
      if (!allowedTypeIds.includes(idString(unit.rentalVehicleTypeId))) {
        throw new ApiError(400, 'This unit belongs to a different vehicle type');
      }
      await assertUnitFreeForWindow({
        unitId,
        from: item.pickupDateTime,
        to: item.returnDateTime,
        excludeBookingId: item._id,
      });
      item.assignedUnitId = unit._id;
      item.assignedUnitRegistration = unit.registrationNumber || '';
      await RentalVehicleUnit.updateOne({ _id: unit._id }, { $set: { status: 'booked', currentBookingId: item._id } });
    }

    if (previousUnitId && previousUnitId !== unitId) {
      await RentalVehicleUnit.updateOne(
        { _id: previousUnitId, currentBookingId: item._id },
        { $set: { status: 'available', currentBookingId: null } },
      );
    }
  }

  if (payload.assignedDriverId !== undefined) {
    const driverId = String(payload.assignedDriverId || '').trim();
    if (!driverId) {
      item.assignedDriverId = null;
      item.assignedDriverName = '';
      item.assignedDriverPhone = '';
    } else {
      if ((item.driveMode || 'self_drive') !== 'with_driver') {
        throw new ApiError(400, 'A driver can only be assigned to a with-driver rental');
      }
      if (!isObjectId(driverId)) throw new ApiError(400, 'assignedDriverId is invalid');
      const driver = await Driver.findById(driverId).select('name phone').lean();
      if (!driver) throw new ApiError(404, 'Driver not found');
      const changed = idString(item.assignedDriverId) !== driverId;
      item.assignedDriverId = driver._id;
      item.assignedDriverName = driver.name || '';
      item.assignedDriverPhone = driver.phone || '';
      if (changed) {
        emitRentalToDriver(driver._id, RENTAL_SOCKET_EVENTS.driverAssigned, {
          bookingId: String(item._id),
          bookingReference: item.bookingReference,
          pickupDateTime: item.pickupDateTime,
          returnDateTime: item.returnDateTime,
          vehicleName: item.vehicleName,
          serviceLocation: item.serviceLocation,
          contactName: item.contactName,
          contactPhone: item.contactPhone,
        });
      }
    }
  }

  return item;
};
