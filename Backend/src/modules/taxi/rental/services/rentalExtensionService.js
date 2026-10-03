import { ApiError } from '../../../../utils/ApiError.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { RentalVehicleUnit } from '../models/RentalVehicleUnit.js';
import { RENTAL_HOLDING_STATUSES, quoteRentalExtension, resolveBookingTerms } from './rentalBilling.js';
import { findUnitConflicts } from './rentalAvailability.js';
import { getRentalAvailability } from './rentalInventoryService.js';
import { getRentalSettings, isRentalFlagOn } from './rentalSettings.js';
import { emitRentalToAdmins, emitRentalToUser, RENTAL_SOCKET_EVENTS } from './rentalEvents.js';

/// Rental extension (7.7): the rider asks to keep the car longer.
///
/// The extra window [current return, new return) is checked against the
/// calendar, priced with the booking's own snapshotted rates, and recorded as
/// an `extensions[]` entry. Approval moves `returnDateTime`; until then the
/// booking keeps its original return time and late return is billed as
/// overtime, exactly as before.

const EXTENDABLE_STATUSES = ['pending', 'confirmed', 'assigned'];

/// Whether a car is free for the extra window. With a specific unit assigned,
/// that unit must be free; otherwise any unit of the type will do. When
/// inventory is not tracked (no units, not enforced) the answer is yes.
export const checkExtensionInventory = async (booking, from, to) => {
  if (booking.assignedUnitId) {
    const bookings = await RentalBookingRequest.find({
      assignedUnitId: booking.assignedUnitId,
      status: { $in: RENTAL_HOLDING_STATUSES },
      _id: { $ne: booking._id },
    })
      .select('_id status pickupDateTime returnDateTime assignedUnitId bookingReference')
      .lean();
    const conflicts = findUnitConflicts(booking.assignedUnitId, bookings, from, to, { excludeBookingId: booking._id });
    const unit = await RentalVehicleUnit.findById(booking.assignedUnitId).select('status').lean();
    const unitUsable = unit && !['maintenance', 'inactive'].includes(String(unit.status));
    return { allowed: conflicts.length === 0 && Boolean(unitUsable), tracked: true, conflicts: conflicts.length };
  }

  const availability = await getRentalAvailability({
    vehicleTypeId: booking.vehicleTypeId?._id || booking.vehicleTypeId,
    from,
    to,
    serviceStoreIds: booking.serviceCenterIds || [],
    excludeBookingId: booking._id,
  });
  return { allowed: availability.bookable, tracked: availability.inventoryTracked || availability.enforced, availability };
};

export const quoteExtensionForBooking = (booking, newReturnDateTime) => {
  const from = new Date(booking.returnDateTime);
  const to = new Date(newReturnDateTime);
  if (Number.isNaN(to.getTime())) {
    throw new ApiError(400, 'Valid newReturnDateTime is required');
  }
  if (to <= from) {
    throw new ApiError(400, 'newReturnDateTime must be after the current return time');
  }
  const terms = resolveBookingTerms(booking);
  return {
    from,
    to,
    ...quoteRentalExtension({
      terms,
      from,
      to,
      driveMode: booking.driveMode,
      withDriverSurcharge: booking.withDriverSurcharge,
    }),
  };
};

const applyApproval = (booking, extension, { auto = false, by = '' } = {}) => {
  extension.status = extension.status === 'paid' ? 'paid' : 'approved';
  extension.autoApproved = auto;
  extension.decidedAt = new Date();
  extension.decidedBy = by;
  if (new Date(extension.to) > new Date(booking.returnDateTime)) {
    booking.returnDateTime = extension.to;
  }
};

export const serializeExtension = (extension = {}) => ({
  id: String(extension._id || ''),
  from: extension.from,
  to: extension.to,
  hours: Number(extension.hours || 0),
  amount: Number(extension.amount || 0),
  includedKm: Number(extension.includedKm || 0),
  status: extension.status,
  autoApproved: Boolean(extension.autoApproved),
  paymentId: extension.paymentId || '',
  paidVia: extension.paidVia || '',
  paidAt: extension.paidAt || null,
  note: extension.note || '',
  decidedAt: extension.decidedAt || null,
});

/// Creates an extension request on a booking document and saves it.
export const requestRentalExtension = async (booking, { newReturnDateTime, note = '' }) => {
  if (!EXTENDABLE_STATUSES.includes(String(booking.status))) {
    throw new ApiError(409, 'This rental cannot be extended right now');
  }
  if ((booking.extensions || []).some((entry) => entry.status === 'requested')) {
    throw new ApiError(409, 'An extension request is already waiting for approval');
  }

  const quote = quoteExtensionForBooking(booking, newReturnDateTime);
  const inventory = await checkExtensionInventory(booking, quote.from, quote.to);
  if (!inventory.allowed) {
    throw new ApiError(409, 'No vehicle is available for the extended period', { code: 'rental_unavailable' });
  }

  booking.extensions.push({
    from: quote.from,
    to: quote.to,
    hours: quote.hours,
    amount: quote.amount,
    includedKm: quote.includedKm,
    status: 'requested',
    note: String(note || '').trim(),
  });
  const extension = booking.extensions[booking.extensions.length - 1];

  const settings = await getRentalSettings();
  if (isRentalFlagOn(settings, 'auto_approve_extensions')) {
    applyApproval(booking, extension, { auto: true, by: 'system' });
  }

  await booking.save();

  const payload = { bookingId: String(booking._id), bookingReference: booking.bookingReference, extension: serializeExtension(extension) };
  if (extension.status === 'requested') {
    emitRentalToAdmins(RENTAL_SOCKET_EVENTS.extensionRequested, payload);
  } else {
    emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.extensionUpdated, payload);
  }

  return { booking, extension, quote };
};

/// Admin decision on a requested extension.
export const decideRentalExtension = async (booking, extensionId, { status, note, adminId = '' }) => {
  const extension = booking.extensions.id(extensionId);
  if (!extension) throw new ApiError(404, 'Extension not found');
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!['approved', 'rejected'].includes(nextStatus)) {
    throw new ApiError(400, 'status must be approved or rejected');
  }
  if (extension.status !== 'requested') {
    throw new ApiError(409, `This extension is already ${extension.status}`);
  }
  if (note !== undefined) extension.note = String(note || '').trim();

  if (nextStatus === 'approved') {
    const inventory = await checkExtensionInventory(booking, extension.from, extension.to);
    if (!inventory.allowed) {
      throw new ApiError(409, 'No vehicle is available for the extended period', { code: 'rental_unavailable' });
    }
    applyApproval(booking, extension, { auto: false, by: String(adminId || 'admin') });
  } else {
    extension.status = 'rejected';
    extension.decidedAt = new Date();
    extension.decidedBy = String(adminId || 'admin');
  }

  await booking.save();
  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.extensionUpdated, {
    bookingId: String(booking._id),
    bookingReference: booking.bookingReference,
    extension: serializeExtension(extension),
  });
  return { booking, extension };
};

/// Marks an extension paid. Paying a still-requested extension also approves
/// it, provided a car is still free (the rider has committed money to it).
export const markExtensionPaid = async (booking, extensionId, { provider, paymentId }) => {
  const extension = booking.extensions.id(extensionId);
  if (!extension) throw new ApiError(404, 'Extension not found');
  if (extension.status === 'paid') throw new ApiError(409, 'This extension is already paid');
  if (extension.status === 'rejected') throw new ApiError(409, 'This extension was rejected');

  if (extension.status === 'requested') {
    const inventory = await checkExtensionInventory(booking, extension.from, extension.to);
    if (!inventory.allowed) {
      throw new ApiError(409, 'No vehicle is available for the extended period', { code: 'rental_unavailable' });
    }
    applyApproval(booking, extension, { auto: false, by: 'payment' });
  }

  extension.status = 'paid';
  extension.paidVia = provider;
  extension.paymentId = paymentId;
  extension.paidAt = new Date();
  if (new Date(extension.to) > new Date(booking.returnDateTime)) {
    booking.returnDateTime = extension.to;
  }
  await booking.save();

  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.extensionUpdated, {
    bookingId: String(booking._id),
    bookingReference: booking.bookingReference,
    extension: serializeExtension(extension),
  });
  return { booking, extension };
};
