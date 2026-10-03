import crypto from 'node:crypto';
import { ApiError } from '../../../utils/ApiError.js';
import { RIDE_LIVE_STATUS } from '../constants/index.js';
import { getCustomizationSettings, isSettingValueOn } from './securitySettingsService.js';

/// Start and delivery OTP checks for a driver moving a trip forward.
///
/// Two codes exist:
/// - `Ride.otp`: the rider's 4-digit code, shown in the rider app. The driver
///   must enter it to move the trip to `started` (for a parcel this is the
///   pickup / "load" OTP, given by the sender).
/// - `Ride.parcelDropOtp`: a separate 4-digit code for the parcel receiver,
///   generated at booking, sent by SMS to `parcel.receiverMobile` at pickup,
///   and required to complete the delivery. It is `select: false` on the model
///   so no serializer that loads a ride can leak it to the driver.
///
/// Every check is behind a setting that defaults off, so turning this module on
/// is an admin decision rather than a deploy side effect.

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LOCK_MS = 5 * 60 * 1000;

const OTP_PATTERN = /^\d{4}$/;

export const generateTripOtp = () => String(crypto.randomInt(1000, 10000));

export const normalizeOtpInput = (value) => String(value ?? '').replace(/\s+/g, '').trim();

/// Constant-time compare. Both sides are hashed first so the buffers are always
/// the same length, which `timingSafeEqual` requires, and so the length of the
/// expected code doesn't leak through an early return either.
export const safeOtpEquals = (expected, provided) => {
  const expectedValue = normalizeOtpInput(expected);
  const providedValue = normalizeOtpInput(provided);

  if (!expectedValue || !providedValue) return false;

  const a = crypto.createHash('sha256').update(expectedValue).digest();
  const b = crypto.createHash('sha256').update(providedValue).digest();
  return crypto.timingSafeEqual(a, b);
};

const toMs = (value) => {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/// Pure decision for one OTP attempt against the stored guard state
/// `{ failedAttempts, lockedUntil }`.
///
/// Returns `{ ok, reason, retryAfterSeconds?, attemptsRemaining?, nextState }`.
/// `nextState` is what should be persisted. A missing code is not counted as an
/// attempt (it's a client bug, not a guess); a wrong code is. On the
/// `maxAttempts`-th wrong code the ride is locked for `lockMs` and the counter
/// starts again from zero once the lock expires.
export const evaluateOtpAttempt = ({
  expected,
  provided,
  state = {},
  now = Date.now(),
  maxAttempts = OTP_MAX_ATTEMPTS,
  lockMs = OTP_LOCK_MS,
} = {}) => {
  const lockedUntilMs = toMs(state?.lockedUntil);
  const currentState = {
    failedAttempts: Math.max(0, Number(state?.failedAttempts || 0)),
    lockedUntil: state?.lockedUntil || null,
  };

  if (lockedUntilMs > now) {
    return {
      ok: false,
      reason: 'locked',
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntilMs - now) / 1000)),
      nextState: currentState,
    };
  }

  // A lock that has run out wipes the slate.
  const failedSoFar = lockedUntilMs && lockedUntilMs <= now ? 0 : currentState.failedAttempts;

  if (!normalizeOtpInput(provided)) {
    return {
      ok: false,
      reason: 'missing',
      attemptsRemaining: Math.max(0, maxAttempts - failedSoFar),
      nextState: { failedAttempts: failedSoFar, lockedUntil: null },
    };
  }

  if (safeOtpEquals(expected, provided)) {
    return {
      ok: true,
      reason: 'verified',
      nextState: { failedAttempts: 0, lockedUntil: null, verifiedAt: new Date(now) },
    };
  }

  const failedAttempts = failedSoFar + 1;

  if (failedAttempts >= maxAttempts) {
    return {
      ok: false,
      reason: 'locked',
      retryAfterSeconds: Math.ceil(lockMs / 1000),
      attemptsRemaining: 0,
      nextState: { failedAttempts: 0, lockedUntil: new Date(now + lockMs) },
    };
  }

  return {
    ok: false,
    reason: 'mismatch',
    attemptsRemaining: maxAttempts - failedAttempts,
    nextState: { failedAttempts, lockedUntil: null },
  };
};

const isParcel = (ride) => String(ride?.serviceType || '') === 'parcel';

/// Which checks apply to this ride under the given customization settings.
/// Pure, so the gating rules can be tested without a database.
export const resolveTripOtpRequirements = (ride, settings = {}) => {
  if (isParcel(ride)) {
    const enforce = isSettingValueOn(settings.enforce_delivery_otp);
    return {
      start: enforce && isSettingValueOn(settings.enable_delivery_otp_load),
      drop: enforce && isSettingValueOn(settings.enable_delivery_otp_unload),
    };
  }

  return {
    start: isSettingValueOn(settings.enable_ride_start_otp_verification),
    drop: false,
  };
};

const OTP_ERROR_COPY = {
  start: {
    missing: 'Enter the OTP from the rider to start the trip',
    mismatch: 'Incorrect OTP. Ask the rider for the code shown in their app',
    locked: 'Too many wrong OTP attempts. Try again in a few minutes',
  },
  drop: {
    missing: 'Enter the delivery OTP from the receiver to complete the delivery',
    mismatch: 'Incorrect delivery OTP. Ask the receiver for the code sent to their phone',
    locked: 'Too many wrong delivery OTP attempts. Try again in a few minutes',
  },
};

export const buildOtpError = (stage, outcome) => {
  const copy = OTP_ERROR_COPY[stage] || OTP_ERROR_COPY.start;
  // Never 401: the web client treats any 401 on an authed call as a dead
  // session and logs the driver out.
  const statusCode = outcome.reason === 'locked' ? 429 : outcome.reason === 'missing' ? 400 : 422;
  return new ApiError(statusCode, copy[outcome.reason] || copy.mismatch, {
    code: `${stage}_otp_${outcome.reason}`,
    stage,
    attemptsRemaining: outcome.attemptsRemaining ?? null,
    retryAfterSeconds: outcome.retryAfterSeconds ?? null,
  });
};

/// Lazily resolved so this file stays importable (and unit-testable) without
/// pulling the Mongoose model graph in at load time.
const loadRideModel = async () => (await import('../user/models/Ride.js')).Ride;

const verifyStage = async ({ ride, stage, expected, provided }) => {
  const Ride = await loadRideModel();
  const guardPath = `otpGuard.${stage}`;
  const state = ride?.otpGuard?.[stage] || {};

  if (!normalizeOtpInput(expected)) {
    // Nothing to check against: a parcel booked before drop OTPs existed and
    // already past pickup. Blocking it would strand a live delivery.
    return { ok: true, reason: 'no_expected' };
  }

  const outcome = evaluateOtpAttempt({ expected, provided, state });

  if (outcome.reason === 'mismatch' || (outcome.reason === 'locked' && !toMs(state.lockedUntil))) {
    // Concurrent wrong guesses must each count, so increment atomically and
    // decide the lock from the counter Mongo returns, not the one we read.
    const updated = await Ride.findOneAndUpdate(
      { _id: ride._id },
      { $inc: { [`${guardPath}.failedAttempts`]: 1 } },
      { returnDocument: 'after', projection: { otpGuard: 1 } },
    ).lean();
    const count = Number(updated?.otpGuard?.[stage]?.failedAttempts || 0);

    if (count >= OTP_MAX_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + OTP_LOCK_MS);
      await Ride.updateOne(
        { _id: ride._id },
        { $set: { [`${guardPath}.failedAttempts`]: 0, [`${guardPath}.lockedUntil`]: lockedUntil } },
      );
      throw buildOtpError(stage, {
        reason: 'locked',
        attemptsRemaining: 0,
        retryAfterSeconds: Math.ceil(OTP_LOCK_MS / 1000),
      });
    }

    throw buildOtpError(stage, { reason: 'mismatch', attemptsRemaining: OTP_MAX_ATTEMPTS - count });
  }

  if (!outcome.ok) {
    if (toMs(state.lockedUntil) && toMs(state.lockedUntil) <= Date.now()) {
      // Expired lock with a missing code: clear it so the next try starts fresh.
      await Ride.updateOne({ _id: ride._id }, { $set: { [guardPath]: outcome.nextState } });
    }
    throw buildOtpError(stage, outcome);
  }

  // Set on the in-memory doc too, so the caller's `ride.save()` keeps it.
  if (typeof ride.set === 'function') {
    ride.set(guardPath, outcome.nextState);
  }
  await Ride.updateOne({ _id: ride._id }, { $set: { [guardPath]: outcome.nextState } });
  return outcome;
};

/// The hook `updateRideLifecycle` calls before applying a driver's status
/// change. Throws an ApiError when a required OTP is missing, wrong, or locked.
export const enforceTripOtp = async ({ ride, nextStatus, otp, dropOtp } = {}) => {
  if (!ride) return { checked: false };

  const settings = await getCustomizationSettings();
  const requirements = resolveTripOtpRequirements(ride, settings);

  if (!requirements.start && !requirements.drop) {
    return { checked: false };
  }

  const isFirstStart = nextStatus === RIDE_LIVE_STATUS.STARTED && !ride.startedAt;

  if (requirements.start && isFirstStart) {
    await verifyStage({ ride, stage: 'start', expected: ride.otp, provided: otp });
    return { checked: true, stage: 'start' };
  }

  if (requirements.start && nextStatus === RIDE_LIVE_STATUS.COMPLETED && !ride.startedAt) {
    // `completed` is reachable straight from `accepted`; without this a
    // driver could skip the start OTP by never starting.
    throw new ApiError(409, 'Start the trip with the rider OTP before completing it', {
      code: 'start_otp_required',
      stage: 'start',
    });
  }

  if (requirements.drop && nextStatus === RIDE_LIVE_STATUS.COMPLETED) {
    const Ride = await loadRideModel();
    const withSecret = await Ride.findById(ride._id).select('+parcelDropOtp').lean();
    await verifyStage({
      ride,
      stage: 'drop',
      expected: withSecret?.parcelDropOtp,
      // Accept `dropOtp`, or `otp` for clients that reuse one field per step.
      provided: normalizeOtpInput(dropOtp) ? dropOtp : otp,
    });
    return { checked: true, stage: 'drop' };
  }

  return { checked: false };
};

/// Sends the receiver their delivery OTP when the parcel is picked up.
///
/// Generates the code first if the parcel was booked before drop OTPs
/// existed. Fire-and-forget from the caller: an SMS failure must never fail
/// the pickup, and the sender can still read the code out of their app.
export const notifyParcelReceiverOtp = async (ride) => {
  if (!isParcel(ride)) return { sent: false, reason: 'not-parcel' };

  const settings = await getCustomizationSettings();
  if (!resolveTripOtpRequirements(ride, settings).drop) {
    return { sent: false, reason: 'disabled' };
  }

  const Ride = await loadRideModel();
  const stored = await Ride.findById(ride._id)
    .select('+parcelDropOtp parcel.receiverMobile parcelDropOtpSentAt')
    .lean();

  if (!stored) return { sent: false, reason: 'not-found' };
  if (stored.parcelDropOtpSentAt) return { sent: false, reason: 'already-sent' };

  let code = normalizeOtpInput(stored.parcelDropOtp);
  if (!OTP_PATTERN.test(code)) {
    code = generateTripOtp();
    await Ride.updateOne({ _id: ride._id }, { $set: { parcelDropOtp: code } });
  }

  const phone = String(stored.parcel?.receiverMobile || '').trim();
  if (!phone) return { sent: false, reason: 'no-receiver-mobile' };

  const { sendOtpSms } = await import('./smsService.js');
  await sendOtpSms({ phone, otp: code, purpose: 'parcel_delivery' });
  await Ride.updateOne({ _id: ride._id }, { $set: { parcelDropOtpSentAt: new Date() } });
  return { sent: true };
};

/// The receiver code for the user who booked the parcel. Owner-only; this is
/// the single place the drop OTP leaves the server apart from the SMS.
export const getParcelDropOtpForUser = async ({ rideId, userId }) => {
  const Ride = await loadRideModel();
  const ride = await Ride.findOne({ _id: rideId, userId })
    .select('+parcelDropOtp serviceType parcel.receiverMobile parcelDropOtpSentAt liveStatus status')
    .lean();

  if (!ride) {
    throw new ApiError(404, 'Ride not found');
  }

  if (!isParcel(ride)) {
    throw new ApiError(400, 'Delivery OTP is only available for parcel bookings');
  }

  const settings = await getCustomizationSettings();

  return {
    rideId: String(ride._id),
    dropOtp: ride.parcelDropOtp || '',
    required: resolveTripOtpRequirements(ride, settings).drop,
    sentToReceiverAt: ride.parcelDropOtpSentAt || null,
    receiverMobile: ride.parcel?.receiverMobile || '',
  };
};
