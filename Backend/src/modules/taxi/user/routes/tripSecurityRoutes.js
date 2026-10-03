import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { getCustomizationSettings } from '../../services/securitySettingsService.js';
import { getParcelDropOtpForUser, resolveTripOtpRequirements } from '../../services/tripOtpService.js';

export const tripSecurityRouter = Router();

const MAX_REDACT_DEPTH = 5;

const looksLikeParcel = (node, assumeParcel) =>
  assumeParcel ||
  String(node?.serviceType || node?.type || '').toLowerCase() === 'parcel';

/// Removes the rider OTP from a response body for a driver, wherever a ride
/// sits in it (`data`, `data.results[]`, `data.ride`, ...). Only rides whose
/// start OTP is actually enforced lose it: with the setting off the driver app
/// still needs it for its local check.
export const redactRideOtpForDriver = (body, settings, { assumeParcel = false } = {}) => {
  // Mutates in place: it only ever runs on the private copy made below.
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_REDACT_DEPTH) return;

    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }

    Object.values(node).forEach((value) => visit(value, depth + 1));

    if (Object.prototype.hasOwnProperty.call(node, 'otp') && node.otp) {
      const parcel = looksLikeParcel(node, assumeParcel);
      const { start } = resolveTripOtpRequirements({ serviceType: parcel ? 'parcel' : 'ride' }, settings);
      if (start) {
        node.otp = '';
      }
    }
  };

  // Normalise Mongoose documents, ObjectIds and Dates to what res.json would
  // send anyway, so the walk only ever sees plain JSON.
  let plain;
  try {
    plain = body === undefined ? body : JSON.parse(JSON.stringify(body));
  } catch {
    return body;
  }

  visit(plain, 0);
  return plain;
};

/// Wraps `res.json` for driver callers so OTPs the server now verifies are
/// not handed to the driver in the first place. Settings are loaded up front
/// (cached) because the `res.json` wrapper has to stay synchronous.
const redactDriverOtps = ({ assumeParcel = false } = {}) => async (req, res, next) => {
  try {
    const settings = await getCustomizationSettings();
    const anyEnforced =
      resolveTripOtpRequirements({ serviceType: 'ride' }, settings).start ||
      resolveTripOtpRequirements({ serviceType: 'parcel' }, settings).start;

    if (anyEnforced) {
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // `req.auth` is set by the route's own authenticate(), which runs
        // after this middleware but before the handler responds.
        if (req.auth?.role === 'driver') {
          return originalJson(redactRideOtpForDriver(body, settings, { assumeParcel }));
        }
        return originalJson(body);
      };
    }
  } catch {
    // Settings unreadable: leave the response alone rather than fail it.
  }
  next();
};

tripSecurityRouter.use('/rides', redactDriverOtps());
tripSecurityRouter.use('/deliveries', redactDriverOtps({ assumeParcel: true }));
tripSecurityRouter.use('/drivers', redactDriverOtps());

/// The parcel receiver's delivery OTP, for the user who booked it, so the
/// sender can pass it on if the SMS doesn't arrive. Never available to drivers.
tripSecurityRouter.get(
  '/rides/:rideId/delivery-otp',
  authenticate(['user']),
  asyncHandler(async (req, res) => {
    const data = await getParcelDropOtpForUser({ rideId: req.params.rideId, userId: req.auth.sub });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data });
  }),
);
