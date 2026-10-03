import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { RentalVehicleType } from '../../admin/models/RentalVehicleType.js';
import { RentalVehicleUnit } from '../models/RentalVehicleUnit.js';
import { RENTAL_HOLDING_STATUSES } from './rentalBilling.js';
import { computeAvailability, findUnitConflicts } from './rentalAvailability.js';
import { getRentalSettings, isRentalFlagOn } from './rentalSettings.js';

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const toDate = (value, label) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new ApiError(400, `Valid ${label} is required`);
  }
  return date;
};

const cleanStoreIds = (ids = []) =>
  [...new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id?._id || id || '').trim()).filter(isObjectId))];

/// Bookings of a vehicle type that may hold a car inside [from, to).
/// A car that is out past its return time still holds, so for those statuses
/// the return time is not used to exclude them.
const loadHoldingBookings = async ({ vehicleTypeId, from, to, serviceStoreIds = [], excludeBookingReference = '' }) => {
  const query = {
    vehicleTypeId,
    status: { $in: RENTAL_HOLDING_STATUSES },
    pickupDateTime: { $lt: to },
    $or: [{ returnDateTime: { $gt: from } }, { status: { $in: ['assigned', 'end_requested'] } }],
  };
  if (serviceStoreIds.length) {
    query.serviceCenterIds = { $in: serviceStoreIds };
  }
  if (excludeBookingReference) {
    query.bookingReference = { $ne: excludeBookingReference };
  }
  return RentalBookingRequest.find(query)
    .select('_id status pickupDateTime returnDateTime assignedUnitId serviceCenterIds bookingReference')
    .lean();
};

/// Free cars of a vehicle type for a window.
///
/// `bookable` is what an app should act on: with enforcement off and no
/// units entered, inventory is not being tracked, so the answer is "yes" the
/// way it always was.
export const getRentalAvailability = async ({
  vehicleTypeId,
  from,
  to,
  serviceStoreIds = [],
  excludeBookingId = null,
  excludeBookingReference = '',
}) => {
  if (!isObjectId(vehicleTypeId)) {
    throw new ApiError(400, 'Valid rental vehicle is required');
  }
  const fromDate = toDate(from, 'from date');
  const toDateValue = toDate(to, 'to date');
  if (toDateValue <= fromDate) {
    throw new ApiError(400, '`to` must be after `from`');
  }

  const storeIds = cleanStoreIds(serviceStoreIds);
  const [units, bookings, settings] = await Promise.all([
    RentalVehicleUnit.find({
      rentalVehicleTypeId: vehicleTypeId,
      ...(storeIds.length ? { serviceStoreId: { $in: storeIds } } : {}),
    })
      .select('_id status serviceStoreId registrationNumber')
      .lean(),
    loadHoldingBookings({ vehicleTypeId, from: fromDate, to: toDateValue, serviceStoreIds: storeIds, excludeBookingReference }),
    getRentalSettings(),
  ]);

  const availability = computeAvailability({
    units,
    bookings,
    from: fromDate,
    to: toDateValue,
    excludeBookingId,
  });
  const enforced = isRentalFlagOn(settings, 'enforce_inventory');
  const inventoryTracked = availability.totalUnits > 0;

  return {
    vehicleTypeId: String(vehicleTypeId),
    from: fromDate,
    to: toDateValue,
    serviceStoreIds: storeIds,
    ...availability,
    inventoryTracked,
    enforced,
    bookable: enforced || inventoryTracked ? availability.isAvailable : true,
  };
};

/// Throws 409 when inventory is enforced and nothing is free. A no-op while
/// `rental.enforce_inventory` is '0', so existing setups keep working.
export const assertRentalInventoryAvailable = async ({ vehicleTypeId, from, to, serviceStoreIds = [], excludeBookingReference = '' }) => {
  const settings = await getRentalSettings();
  if (!isRentalFlagOn(settings, 'enforce_inventory')) return null;

  const availability = await getRentalAvailability({ vehicleTypeId, from, to, serviceStoreIds, excludeBookingReference });
  if (!availability.isAvailable) {
    throw new ApiError(409, 'No vehicle of this type is available for the selected dates', {
      code: 'rental_unavailable',
      availability: { available: availability.available, totalUnits: availability.totalUnits },
    });
  }
  return availability;
};

/// Throws 409 if `unitId` is already promised to another booking that
/// overlaps [from, to).
export const assertUnitFreeForWindow = async ({ unitId, from, to, excludeBookingId }) => {
  const bookings = await RentalBookingRequest.find({
    assignedUnitId: unitId,
    status: { $in: RENTAL_HOLDING_STATUSES },
    _id: { $ne: excludeBookingId },
  })
    .select('_id status pickupDateTime returnDateTime assignedUnitId bookingReference')
    .lean();
  const conflicts = findUnitConflicts(unitId, bookings, from, to, { excludeBookingId });
  if (conflicts.length) {
    throw new ApiError(409, `This vehicle unit is already booked (${conflicts[0].bookingReference || conflicts[0]._id}) for an overlapping time`, {
      code: 'rental_unit_conflict',
      conflictingBookingIds: conflicts.map((entry) => String(entry._id)),
    });
  }
};

// --- unit CRUD --------------------------------------------------------------

export const serializeRentalVehicleUnit = (unit = {}) => ({
  id: String(unit._id || unit.id || ''),
  _id: unit._id,
  rentalVehicleTypeId: unit.rentalVehicleTypeId?._id
    ? String(unit.rentalVehicleTypeId._id)
    : unit.rentalVehicleTypeId
      ? String(unit.rentalVehicleTypeId)
      : '',
  rentalVehicleTypeName: unit.rentalVehicleTypeId?.name || '',
  registrationNumber: unit.registrationNumber || '',
  serviceStoreId: unit.serviceStoreId?._id
    ? String(unit.serviceStoreId._id)
    : unit.serviceStoreId
      ? String(unit.serviceStoreId)
      : '',
  serviceStoreName: unit.serviceStoreId?.name || '',
  status: unit.status || 'available',
  odometer: Number(unit.odometer || 0),
  fuel: unit.fuel || '',
  color: unit.color || '',
  modelYear: unit.modelYear ?? null,
  photos: Array.isArray(unit.photos) ? unit.photos : [],
  documents: Array.isArray(unit.documents) ? unit.documents : [],
  notes: unit.notes || '',
  currentBookingId: unit.currentBookingId ? String(unit.currentBookingId) : '',
  createdAt: unit.createdAt || null,
  updatedAt: unit.updatedAt || null,
});

const UNIT_STATUSES = ['available', 'booked', 'maintenance', 'inactive'];

const normalizeUnitPayload = (payload = {}, existing = {}) => {
  const pick = (key, fallback) => (payload[key] !== undefined ? payload[key] : existing[key] ?? fallback);
  const status = String(pick('status', 'available') || 'available').trim().toLowerCase();
  const odometer = Number(pick('odometer', 0));
  const modelYear = pick('modelYear', null);

  return {
    rentalVehicleTypeId: String(pick('rentalVehicleTypeId', '') || '').trim(),
    registrationNumber: String(pick('registrationNumber', '') || '').trim().toUpperCase(),
    serviceStoreId: pick('serviceStoreId', null) ? String(pick('serviceStoreId', '')).trim() : null,
    status: UNIT_STATUSES.includes(status) ? status : 'available',
    odometer: Number.isFinite(odometer) && odometer >= 0 ? odometer : 0,
    fuel: String(pick('fuel', '') || '').trim(),
    color: String(pick('color', '') || '').trim(),
    modelYear: modelYear === null || modelYear === '' ? null : Number(modelYear) || null,
    photos: Array.isArray(pick('photos', [])) ? pick('photos', []).map((item) => String(item || '').trim()).filter(Boolean) : [],
    documents: Array.isArray(pick('documents', []))
      ? pick('documents', []).map((doc) => ({
          name: String(doc?.name || '').trim(),
          imageUrl: String(doc?.imageUrl || doc?.url || '').trim(),
          number: String(doc?.number || '').trim(),
          expiryDate: doc?.expiryDate ? new Date(doc.expiryDate) : null,
        }))
      : [],
    notes: String(pick('notes', '') || '').trim(),
  };
};

const validateUnitPayload = async (data) => {
  if (!isObjectId(data.rentalVehicleTypeId)) {
    throw new ApiError(400, 'Valid rentalVehicleTypeId is required');
  }
  if (!data.registrationNumber) {
    throw new ApiError(400, 'registrationNumber is required');
  }
  if (data.serviceStoreId && !isObjectId(data.serviceStoreId)) {
    throw new ApiError(400, 'serviceStoreId is invalid');
  }
  const exists = await RentalVehicleType.exists({ _id: data.rentalVehicleTypeId });
  if (!exists) {
    throw new ApiError(404, 'Rental vehicle type not found');
  }
};

export const listRentalVehicleUnits = async (query = {}) => {
  const filter = {};
  if (isObjectId(query.rentalVehicleTypeId || query.vehicleTypeId)) {
    filter.rentalVehicleTypeId = query.rentalVehicleTypeId || query.vehicleTypeId;
  }
  if (isObjectId(query.serviceStoreId)) {
    filter.serviceStoreId = query.serviceStoreId;
  }
  if (UNIT_STATUSES.includes(String(query.status || ''))) {
    filter.status = query.status;
  }
  if (query.search) {
    filter.registrationNumber = { $regex: String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }
  const units = await RentalVehicleUnit.find(filter)
    .populate('rentalVehicleTypeId', 'name')
    .populate('serviceStoreId', 'name')
    .sort({ createdAt: -1 })
    .lean();
  return units.map(serializeRentalVehicleUnit);
};

export const createRentalVehicleUnit = async (payload = {}) => {
  const data = normalizeUnitPayload(payload);
  await validateUnitPayload(data);
  try {
    const unit = await RentalVehicleUnit.create(data);
    return serializeRentalVehicleUnit(unit.toObject());
  } catch (error) {
    if (error?.code === 11000) {
      throw new ApiError(409, 'A vehicle with this registration number already exists');
    }
    throw error;
  }
};

export const updateRentalVehicleUnit = async (id, payload = {}) => {
  if (!isObjectId(id)) throw new ApiError(400, 'Valid unit id is required');
  const unit = await RentalVehicleUnit.findById(id);
  if (!unit) throw new ApiError(404, 'Rental vehicle unit not found');
  const data = normalizeUnitPayload(payload, unit.toObject());
  await validateUnitPayload(data);
  Object.assign(unit, data);
  try {
    await unit.save();
  } catch (error) {
    if (error?.code === 11000) {
      throw new ApiError(409, 'A vehicle with this registration number already exists');
    }
    throw error;
  }
  return serializeRentalVehicleUnit(unit.toObject());
};

export const deleteRentalVehicleUnit = async (id) => {
  if (!isObjectId(id)) throw new ApiError(400, 'Valid unit id is required');
  const active = await RentalBookingRequest.exists({ assignedUnitId: id, status: { $in: RENTAL_HOLDING_STATUSES } });
  if (active) {
    throw new ApiError(409, 'This unit is assigned to an open booking; mark it inactive instead');
  }
  const unit = await RentalVehicleUnit.findByIdAndDelete(id);
  if (!unit) throw new ApiError(404, 'Rental vehicle unit not found');
  return true;
};

/// Called after a booking is completed or cancelled: the car is back.
/// Only touches a unit that still points at this booking, so a unit already
/// handed to the next booking is left alone.
export const releaseUnitForBooking = async (booking) => {
  if (!booking?.assignedUnitId) return;
  const returnReading = Number(booking.rentalInspection?.returnMeterReading);
  await RentalVehicleUnit.updateOne(
    { _id: booking.assignedUnitId, currentBookingId: booking._id },
    {
      $set: {
        status: 'available',
        currentBookingId: null,
        ...(Number.isFinite(returnReading) && returnReading > 0 ? { odometer: returnReading } : {}),
        ...(booking.rentalInspection?.returnFuelLevel ? { fuel: booking.rentalInspection.returnFuelLevel } : {}),
      },
    },
  );
};
