import { ApiError } from '../../../utils/ApiError.js';
import { authenticate } from './authMiddleware.js';
import { consumeScopedRateLimit } from './rateLimitMiddleware.js';
import { isCustomizationFlagOn } from '../services/securitySettingsService.js';

/// Auth for the two image upload endpoints that used to be fully open
/// (`POST /common/upload/image`, `POST /users/profile-image`).
///
/// Accepted, in order:
/// 1. A normal `Authorization: Bearer <jwt>` for any app role. Pending drivers
///    and owners are allowed, since they upload documents before approval.
/// 2. Proof of an in-progress signup, for callers that upload before any token
///    exists (the rider signup screen uploads the profile photo first):
///    - `X-Registration-Id` (or body `registrationId`): a live driver / pooling
///      onboarding session id from `/drivers/onboarding/send-otp`.
///    - `X-Signup-Phone` (or body `signupPhone`): a phone whose rider signup
///      OTP was verified within the last 10 minutes (`/users/auth/verify-otp`).
///    These pre-auth uploads are rate limited hard and can only land in the
///    signup folders.
///
/// `customization.require_upload_auth = '0'` turns the gate off again, as an
/// escape hatch for a mobile build in the field that sends neither.

const PREAUTH_FOLDERS = new Set(['user-profile', 'driver-onboarding', 'onboarding']);
const PREAUTH_DEFAULT_FOLDER = 'onboarding';
const PREAUTH_RATE_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 };
const AUTHED_UPLOAD_ROLES = [
  'user',
  'driver',
  'owner',
  'admin',
  'bus_driver',
  'pooling_driver',
  'service_center',
  'service_center_staff',
];

const authenticateAnyAppRole = authenticate(AUTHED_UPLOAD_ROLES, { allowPending: true });

const readHeader = (req, name) => String(req.headers?.[name] || '').trim();

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
};

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

/// Pure: which pre-auth credential the request carries, if any.
export const readPreAuthUploadCredential = (req = {}) => {
  const registrationId = readHeader(req, 'x-registration-id') || String(req.body?.registrationId || '').trim();
  if (registrationId) return { kind: 'registration', value: registrationId };

  const phone = normalizePhone(readHeader(req, 'x-signup-phone') || req.body?.signupPhone || '');
  if (phone) return { kind: 'signup_phone', value: phone };

  return null;
};

/// Pure: the folder a pre-auth upload is allowed to write to.
export const clampPreAuthFolder = (folder) => {
  const value = String(folder || '').trim().toLowerCase();
  return PREAUTH_FOLDERS.has(value) ? value : PREAUTH_DEFAULT_FOLDER;
};

const isLiveRegistrationSession = async (registrationId) => {
  const now = new Date();
  const [{ DriverRegistrationSession }, { PoolingDriverOnboardingSession }] = await Promise.all([
    import('../driver/models/DriverRegistrationSession.js'),
    import('../driver/models/PoolingDriverOnboardingSession.js'),
  ]);
  const query = {
    registrationId: String(registrationId),
    status: { $ne: 'completed' },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };

  const [driverSession, poolingSession] = await Promise.all([
    DriverRegistrationSession.exists(query),
    PoolingDriverOnboardingSession.exists(query),
  ]);
  return Boolean(driverSession || poolingSession);
};

const isVerifiedSignupPhone = async (phone) => {
  const { UserAuthSession } = await import('../user/models/UserAuthSession.js');
  return Boolean(
    await UserAuthSession.exists({
      phone,
      otpVerifiedAt: { $ne: null },
      expiresAt: { $gt: new Date() },
    }),
  );
};

export const requireUploadAuth = async (req, res, next) => {
  try {
    if (!(await isCustomizationFlagOn('require_upload_auth'))) {
      next();
      return;
    }

    if (String(req.headers.authorization || '').trim()) {
      authenticateAnyAppRole(req, res, next);
      return;
    }

    const credential = readPreAuthUploadCredential(req);
    if (!credential) {
      throw new ApiError(401, 'Authorization token is required');
    }

    // Per credential, and per IP so rotating made-up ids can't dodge it.
    const [perCredential, perIp] = await Promise.all([
      consumeScopedRateLimit({
        scope: 'preauth_upload',
        mode: 'credential',
        parts: [credential.kind, credential.value],
        ...PREAUTH_RATE_LIMIT,
      }),
      consumeScopedRateLimit({
        scope: 'preauth_upload',
        mode: 'ip',
        parts: [getClientIp(req)],
        max: PREAUTH_RATE_LIMIT.max * 3,
        windowMs: PREAUTH_RATE_LIMIT.windowMs,
      }),
    ]);
    const limit = !perCredential.allowed ? perCredential : perIp;
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new ApiError(429, 'Too many uploads. Please try again later.');
    }

    const valid = credential.kind === 'registration'
      ? await isLiveRegistrationSession(credential.value)
      : await isVerifiedSignupPhone(credential.value);

    if (!valid) {
      throw new ApiError(401, 'Signup session not found or expired. Verify your OTP again.');
    }

    req.uploadAuth = { kind: credential.kind };
    if (req.body && typeof req.body === 'object') {
      req.body.folder = clampPreAuthFolder(req.body.folder);
    }
    next();
  } catch (error) {
    next(error);
  }
};
