import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RIDE_STATUS } from '../../constants/index.js';
import { Driver } from '../../driver/models/Driver.js';
import { User } from '../models/User.js';
import { Ride } from '../models/Ride.js';
import { RideCallLog } from '../models/RideCallLog.js';
import {
  MAX_SAVED_ADDRESSES,
  MAX_USER_EMERGENCY_CONTACTS,
  enforceSingleDefault,
  normalizeAddressInput,
  normalizeEmergencyContactInput,
  normalizeProfileInput,
  normalizeRatingInput,
  roundRating,
  serializeAddress,
  serializeEmergencyContact,
} from '../services/userExtrasValidation.js';
import { appendRideMessage, ensureRideParticipantAccess, getRideRoom } from '../../services/rideService.js';
import { getSocketServer } from '../../services/dispatchService.js';
import { buildInvoiceModel, buildRideInvoicePdf } from '../../services/invoiceService.js';
import { resolveCallMaskingProvider, toE164 } from '../../services/callMaskingService.js';
import { SOCKET_EVENTS } from '../../socket/events.js';

/**
 * Rider-app extras that had a schema but no API (saved addresses, profile
 * fields, SOS contacts) plus ride-level REST endpoints both apps share
 * (invoice, masked call, chat fallback, driver-rates-rider).
 *
 * Kept out of userController/rideController so it merges cleanly; mounted from
 * `user/routes/userExtrasRoutes.js`.
 */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const assertObjectId = (value, label) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new ApiError(400, `${label} is not a valid id`);
  }
};

const loadUser = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }
  return user;
};

const toDateOnly = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);

const serializeProfile = (user) => ({
  id: String(user._id),
  name: user.name || '',
  phone: user.phone || '',
  countryCode: user.countryCode || '+91',
  email: user.email || '',
  gender: user.gender || '',
  dateOfBirth: toDateOnly(user.dateOfBirth),
  anniversary: toDateOnly(user.anniversary),
  profileImage: user.profileImage || '',
  referralCode: user.referralCode || '',
  rating: Number(user.ratingCount || 0) > 0 ? roundRating(user.rating) : null,
  ratingCount: Number(user.ratingCount || 0),
  addresses: (user.addresses || []).map(serializeAddress),
  emergencyContacts: (user.emergencyContacts || []).map(serializeEmergencyContact),
  createdAt: user.createdAt || null,
});

// --- profile ----------------------------------------------------------------

export const getMyProfile = async (req, res) => {
  const user = await loadUser(req.auth.sub);
  ok(res, { user: serializeProfile(user) });
};

export const updateMyProfile = async (req, res) => {
  const updates = normalizeProfileInput(req.body || {});
  if (!Object.keys(updates).length) {
    throw new ApiError(400, 'Nothing to update. Send name, email, gender, dateOfBirth, anniversary or profileImage');
  }

  const user = await loadUser(req.auth.sub);
  Object.assign(user, updates);
  await user.save();

  ok(res, { user: serializeProfile(user) });
};

// --- saved addresses --------------------------------------------------------

export const listMyAddresses = async (req, res) => {
  const user = await User.findById(req.auth.sub).select('addresses').lean();
  if (!user) throw new ApiError(404, 'User not found');

  // Default first, then newest, which is the order the picker shows them in.
  const addresses = [...(user.addresses || [])].sort((a, b) =>
    Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault))
    || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  ok(res, { results: addresses.map(serializeAddress), limit: MAX_SAVED_ADDRESSES });
};

export const addMyAddress = async (req, res) => {
  const input = normalizeAddressInput(req.body || {});
  const user = await loadUser(req.auth.sub);

  if ((user.addresses || []).length >= MAX_SAVED_ADDRESSES) {
    throw new ApiError(400, `You can save up to ${MAX_SAVED_ADDRESSES} addresses`);
  }

  user.addresses.push({ ...input, isDefault: false });
  const added = user.addresses[user.addresses.length - 1];
  // The first address becomes the default; otherwise only on request.
  enforceSingleDefault(user.addresses, input.isDefault ? added._id : null);
  await user.save();

  ok(res, {
    address: serializeAddress(user.addresses.id(added._id)),
    results: user.addresses.map(serializeAddress),
  }, 201);
};

export const updateMyAddress = async (req, res) => {
  assertObjectId(req.params.addressId, 'addressId');
  const input = normalizeAddressInput(req.body || {}, { partial: true });
  const user = await loadUser(req.auth.sub);
  const address = user.addresses.id(req.params.addressId);

  if (!address) throw new ApiError(404, 'Address not found');

  const { isDefault, ...fields } = input;
  Object.assign(address, fields);
  if (isDefault === true) {
    enforceSingleDefault(user.addresses, address._id);
  }
  await user.save();

  ok(res, {
    address: serializeAddress(user.addresses.id(address._id)),
    results: user.addresses.map(serializeAddress),
  });
};

export const deleteMyAddress = async (req, res) => {
  assertObjectId(req.params.addressId, 'addressId');
  const user = await loadUser(req.auth.sub);
  const address = user.addresses.id(req.params.addressId);

  if (!address) throw new ApiError(404, 'Address not found');

  address.deleteOne();
  // Deleting the default promotes another one, so there is never "no default"
  // while addresses exist.
  enforceSingleDefault(user.addresses);
  await user.save();

  ok(res, { deleted: true, results: user.addresses.map(serializeAddress) });
};

export const setMyDefaultAddress = async (req, res) => {
  assertObjectId(req.params.addressId, 'addressId');
  const user = await loadUser(req.auth.sub);
  const address = user.addresses.id(req.params.addressId);

  if (!address) throw new ApiError(404, 'Address not found');

  enforceSingleDefault(user.addresses, address._id);
  await user.save();

  ok(res, { address: serializeAddress(address), results: user.addresses.map(serializeAddress) });
};

// --- emergency contacts -----------------------------------------------------

export const listMyEmergencyContacts = async (req, res) => {
  const user = await User.findById(req.auth.sub).select('emergencyContacts').lean();
  if (!user) throw new ApiError(404, 'User not found');
  ok(res, {
    results: (user.emergencyContacts || []).map(serializeEmergencyContact),
    limit: MAX_USER_EMERGENCY_CONTACTS,
  });
};

export const addMyEmergencyContact = async (req, res) => {
  const user = await loadUser(req.auth.sub);
  const input = normalizeEmergencyContactInput(req.body || {}, user.emergencyContacts || []);

  user.emergencyContacts.push(input);
  await user.save();

  const added = user.emergencyContacts[user.emergencyContacts.length - 1];
  ok(res, serializeEmergencyContact(added), 201);
};

export const deleteMyEmergencyContact = async (req, res) => {
  assertObjectId(req.params.contactId, 'contactId');
  const user = await loadUser(req.auth.sub);
  const contact = user.emergencyContacts.id(req.params.contactId);

  if (!contact) throw new ApiError(404, 'Emergency contact not found');

  contact.deleteOne();
  await user.save();

  ok(res, { deleted: true, results: user.emergencyContacts.map(serializeEmergencyContact) });
};

// --- driver rates rider -----------------------------------------------------

export const submitDriverFeedback = async (req, res) => {
  assertObjectId(req.params.rideId, 'rideId');
  const { rating, comment } = normalizeRatingInput(req.body || {});
  const driverId = req.auth.sub;

  // One conditional write is both the permission check and the "once only"
  // guard, so two taps can't both land and double-count the rider's average.
  const ride = await Ride.findOneAndUpdate(
    {
      _id: req.params.rideId,
      driverId,
      status: RIDE_STATUS.COMPLETED,
      'driverFeedback.rating': null,
    },
    { $set: { driverFeedback: { rating, comment, createdAt: new Date() } } },
    { returnDocument: 'after' },
  ).select('_id userId driverFeedback');

  if (!ride) {
    const existing = await Ride.findById(req.params.rideId).select('driverId status driverFeedback').lean();
    if (!existing || String(existing.driverId || '') !== String(driverId)) {
      throw new ApiError(404, 'Ride not found');
    }
    if (existing.status !== RIDE_STATUS.COMPLETED) {
      throw new ApiError(409, 'You can rate the rider only after the ride is completed');
    }
    throw new ApiError(409, 'You have already rated this rider');
  }

  // Running average in one atomic pipeline update (native driver, since
  // Mongoose 9 refuses update pipelines without an opt-in).
  await User.collection.updateOne({ _id: ride.userId }, [
    {
      $set: {
        rating: {
          $divide: [
            {
              $add: [
                { $multiply: [{ $ifNull: ['$rating', 0] }, { $ifNull: ['$ratingCount', 0] }] },
                rating,
              ],
            },
            { $add: [{ $ifNull: ['$ratingCount', 0] }, 1] },
          ],
        },
        ratingCount: { $add: [{ $ifNull: ['$ratingCount', 0] }, 1] },
      },
    },
  ]);

  const user = await User.findById(ride.userId).select('rating ratingCount').lean();

  ok(res, {
    rideId: String(ride._id),
    driverFeedback: ride.driverFeedback,
    user: {
      id: String(ride.userId),
      rating: roundRating(user?.rating),
      ratingCount: Number(user?.ratingCount || 0),
    },
  });
};

// --- invoice ----------------------------------------------------------------

/// The rider who booked or the driver who drove it, and only once completed:
/// an invoice for a trip still in progress would show the wrong total.
const assertInvoiceAccess = async (req) => {
  assertObjectId(req.params.rideId, 'rideId');
  const ride = await ensureRideParticipantAccess({
    rideId: req.params.rideId,
    role: req.auth.role,
    entityId: req.auth.sub,
  });
  if (ride.status !== RIDE_STATUS.COMPLETED) {
    throw new ApiError(409, 'The invoice is available once the ride is completed');
  }
  return ride;
};

export const downloadRideInvoice = async (req, res) => {
  await assertInvoiceAccess(req);
  const { buffer, filename } = await buildRideInvoicePdf({ rideId: req.params.rideId });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
};

export const getRideInvoiceJson = async (req, res) => {
  await assertInvoiceAccess(req);
  const model = await buildInvoiceModel({ rideId: req.params.rideId });

  // The driver sees the invoice, not the rider's email address.
  if (req.auth.role === 'driver') {
    model.trip = { ...model.trip, customerEmail: '' };
  }

  ok(res, { invoice: model });
};

// --- masked call ------------------------------------------------------------

const ACTIVE_CALL_STATUSES = new Set([RIDE_STATUS.ACCEPTED, RIDE_STATUS.ONGOING]);

export const startRideCall = async (req, res) => {
  assertObjectId(req.params.rideId, 'rideId');
  const role = req.auth.role;
  await ensureRideParticipantAccess({ rideId: req.params.rideId, role, entityId: req.auth.sub });

  const ride = await Ride.findById(req.params.rideId).select('userId driverId status').lean();
  if (!ride?.driverId || !ACTIVE_CALL_STATUSES.has(ride.status)) {
    throw new ApiError(409, 'Calls are available only while the ride is active');
  }

  const [user, driver] = await Promise.all([
    User.findById(ride.userId).select('phone countryCode').lean(),
    Driver.findById(ride.driverId).select('phone countryCode').lean(),
  ]);
  const caller = role === 'user' ? user : driver;
  const callee = role === 'user' ? driver : user;
  const calleeRole = role === 'user' ? 'driver' : 'user';

  if (!callee?.phone) {
    throw new ApiError(409, `The ${calleeRole === 'driver' ? 'driver' : 'rider'} has no phone number on file`);
  }

  const provider = await resolveCallMaskingProvider();
  const outcome = await provider.connect({
    from: toE164(caller?.phone, caller?.countryCode),
    to: toE164(callee.phone, callee.countryCode),
    customField: String(ride._id),
  });

  await RideCallLog.create({
    rideId: ride._id,
    initiatorRole: role,
    initiatorId: req.auth.sub,
    calleeRole,
    calleeId: calleeRole === 'driver' ? ride.driverId : ride.userId,
    provider: provider.name,
    status: outcome.status,
    providerCallSid: outcome.callSid || '',
    error: outcome.error || '',
  }).catch((error) => console.error('[ride:call] audit write failed:', error.message));

  getSocketServer()?.to(getRideRoom(ride._id)).emit('ride:call', {
    rideId: String(ride._id),
    initiatorRole: role,
    provider: provider.name,
    status: outcome.status,
  });

  const payload = {
    status: outcome.status,
    provider: provider.name,
    callSid: outcome.callSid || '',
  };

  // With no masking, or when the bridge failed, the app dials directly - the
  // number it already shows today - so a provider outage never blocks a call.
  if (provider.name === 'none' || !outcome.ok) {
    payload.phone = callee.phone;
    payload.countryCode = callee.countryCode || '+91';
    if (!outcome.ok) payload.error = outcome.error || 'Could not connect the call';
  }

  ok(res, payload);
};

// --- chat REST fallback -----------------------------------------------------

export const listRideMessages = async (req, res) => {
  assertObjectId(req.params.rideId, 'rideId');
  await ensureRideParticipantAccess({ rideId: req.params.rideId, role: req.auth.role, entityId: req.auth.sub });

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  if (since && Number.isNaN(since.getTime())) {
    throw new ApiError(400, 'since must be an ISO timestamp');
  }

  const ride = await Ride.findById(req.params.rideId).select('messages').lean();
  const messages = (ride?.messages || [])
    .filter((message) => !since || new Date(message.sentAt) > since)
    .slice(-limit)
    .map((message) => ({
      id: String(message._id),
      rideId: String(req.params.rideId),
      senderRole: message.senderRole,
      senderId: String(message.senderId),
      message: message.message,
      sentAt: message.sentAt,
    }));

  ok(res, { results: messages });
};

export const postRideMessage = async (req, res) => {
  assertObjectId(req.params.rideId, 'rideId');
  const message = String(req.body?.message || '').trim();
  if (message.length > 1000) {
    throw new ApiError(400, 'message must be at most 1000 characters');
  }

  const saved = await appendRideMessage({
    rideId: req.params.rideId,
    role: req.auth.role,
    senderId: req.auth.sub,
    message,
  });

  // Same broadcast the socket handler does, so the other party's open chat
  // updates whichever path the sender used.
  getSocketServer()?.to(getRideRoom(req.params.rideId)).emit(SOCKET_EVENTS.RIDE_MESSAGE_NEW, saved);

  ok(res, saved, 201);
};
