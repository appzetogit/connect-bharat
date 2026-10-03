import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { createRateLimitMiddleware } from '../../middlewares/rateLimitMiddleware.js';
import {
  addMyAddress,
  addMyEmergencyContact,
  deleteMyAddress,
  deleteMyEmergencyContact,
  downloadRideInvoice,
  getMyProfile,
  getRideInvoiceJson,
  listMyAddresses,
  listMyEmergencyContacts,
  listRideMessages,
  postRideMessage,
  setMyDefaultAddress,
  startRideCall,
  submitDriverFeedback,
  updateMyAddress,
  updateMyProfile,
} from '../controllers/userExtrasController.js';
import {
  autocompletePlaces,
  geocodeAddress,
  getPlaceDetails,
  reverseGeocode,
} from '../../services/mapsProxyService.js';

/**
 * Rider/driver app endpoints added for the SOW (saved addresses, profile
 * extras, SOS contacts, maps proxy, invoice, masked call, chat fallback,
 * driver-rates-rider). Full paths live here and the router is mounted once at
 * the module root, so the existing route files stay untouched.
 *
 * Mounted ahead of the existing /users and /rides routers. None of these
 * paths collide with theirs, but mounting first keeps it that way if a
 * catch-all `/:id` route is ever added there.
 */

export const userExtrasRouter = Router();

const userOnly = authenticate(['user']);
const rideParticipant = authenticate(['user', 'driver']);

/// Every cache miss is a billed Google call. Generous for a person typing an
/// address (autocomplete fires per keystroke, debounced), tight enough that a
/// leaked token can't drain the quota.
const mapsRateLimit = createRateLimitMiddleware({
  scope: 'maps_proxy',
  max: 150,
  windowMs: 5 * 60 * 1000,
  mode: 'auth_or_ip',
  message: 'Too many map lookups. Please try again shortly.',
});

/// Masked calls cost money per minute and ring a real phone.
const callRateLimit = createRateLimitMiddleware({
  scope: 'ride_call',
  max: 10,
  windowMs: 10 * 60 * 1000,
  mode: 'auth_or_ip',
  message: 'Too many call attempts. Please wait a moment.',
});

const chatRateLimit = createRateLimitMiddleware({
  scope: 'ride_chat_rest',
  max: 60,
  windowMs: 60 * 1000,
  mode: 'auth_or_ip',
  message: 'Too many messages. Please slow down.',
});

// --- profile, addresses, SOS contacts (rider) ---
userExtrasRouter.get('/users/me/profile', userOnly, asyncHandler(getMyProfile));
userExtrasRouter.patch('/users/me/profile', userOnly, asyncHandler(updateMyProfile));
userExtrasRouter.get('/users/me/addresses', userOnly, asyncHandler(listMyAddresses));
userExtrasRouter.post('/users/me/addresses', userOnly, asyncHandler(addMyAddress));
userExtrasRouter.patch('/users/me/addresses/:addressId', userOnly, asyncHandler(updateMyAddress));
userExtrasRouter.delete('/users/me/addresses/:addressId', userOnly, asyncHandler(deleteMyAddress));
userExtrasRouter.post('/users/me/addresses/:addressId/default', userOnly, asyncHandler(setMyDefaultAddress));
userExtrasRouter.get('/users/me/emergency-contacts', userOnly, asyncHandler(listMyEmergencyContacts));
userExtrasRouter.post('/users/me/emergency-contacts', userOnly, asyncHandler(addMyEmergencyContact));
userExtrasRouter.delete('/users/me/emergency-contacts/:contactId', userOnly, asyncHandler(deleteMyEmergencyContact));

// --- maps proxy (rider and driver) ---
const mapsHandler = (lookup, readArgs) => asyncHandler(async (req, res) => {
  const data = await lookup(readArgs(req));
  res.json({ success: true, data });
});

userExtrasRouter.get('/maps/geocode', rideParticipant, mapsRateLimit, mapsHandler(geocodeAddress, (req) => ({
  address: req.query.address,
  country: req.query.country,
})));
userExtrasRouter.get('/maps/reverse-geocode', rideParticipant, mapsRateLimit, mapsHandler(reverseGeocode, (req) => ({
  lat: req.query.lat,
  lng: req.query.lng,
})));
userExtrasRouter.get('/maps/places/autocomplete', rideParticipant, mapsRateLimit, mapsHandler(autocompletePlaces, (req) => ({
  input: req.query.input,
  lat: req.query.lat,
  lng: req.query.lng,
  radius: req.query.radius,
  sessiontoken: req.query.sessiontoken,
  country: req.query.country,
})));
userExtrasRouter.get('/maps/places/:placeId', rideParticipant, mapsRateLimit, mapsHandler(getPlaceDetails, (req) => ({
  placeId: req.params.placeId,
  sessiontoken: req.query.sessiontoken,
})));

// --- ride-level (rider and assigned driver) ---
userExtrasRouter.patch('/rides/:rideId/driver-feedback', authenticate(['driver']), asyncHandler(submitDriverFeedback));
userExtrasRouter.get('/rides/:rideId/invoice', rideParticipant, asyncHandler(downloadRideInvoice));
userExtrasRouter.get('/rides/:rideId/invoice.json', rideParticipant, asyncHandler(getRideInvoiceJson));
userExtrasRouter.post('/rides/:rideId/call', rideParticipant, callRateLimit, asyncHandler(startRideCall));
userExtrasRouter.get('/rides/:rideId/messages', rideParticipant, asyncHandler(listRideMessages));
userExtrasRouter.post('/rides/:rideId/messages', rideParticipant, chatRateLimit, asyncHandler(postRideMessage));
