import { ApiError } from '../../../../utils/ApiError.js';
import { User } from '../../user/models/User.js';
import { emitToUserRoom } from './adminFeedService.js';
import { assertObjectId } from './operationsAccess.js';

/// Rider verification and blocking, with an audit trail.
///
/// `User.isVerified` existed but nothing could set it, and blocking flipped
/// `active` with no record of why. Both actions now say who did it and when.

/// Accepts true/false, 1/0 and their string forms, the shapes the panel and
/// the Flutter apps send. Anything else is a 400 rather than a guess.
export const parseBooleanFlag = (value, label) => {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new ApiError(400, `${label} must be true or false`);
};

export const serializeUserModeration = (user) => ({
  id: String(user._id),
  isVerified: Boolean(user.isVerified),
  verifiedBy: user.verifiedBy ? String(user.verifiedBy) : null,
  verifiedAt: user.verifiedAt || null,
  verificationNote: user.verificationNote || '',
  active: user.active !== false && user.isActive !== false,
  blockReason: user.blockReason || '',
  blockedAt: user.blockedAt || null,
  blockedBy: user.blockedBy ? String(user.blockedBy) : null,
});

const MODERATION_SELECT = 'isVerified verifiedBy verifiedAt verificationNote active isActive blockReason blockedAt blockedBy deletedAt';

export const setUserVerified = async ({ userId, verified, note = '', adminId = null }) => {
  assertObjectId(userId, 'userId');
  const isVerified = parseBooleanFlag(verified, 'verified');

  const user = await User.findOneAndUpdate(
    { _id: userId, deletedAt: null },
    {
      $set: {
        isVerified,
        verifiedBy: adminId || null,
        verifiedAt: new Date(),
        verificationNote: String(note || '').trim().slice(0, 500),
      },
    },
    { returnDocument: 'after' },
  ).select(MODERATION_SELECT);

  if (!user) throw new ApiError(404, 'User not found');
  return serializeUserModeration(user);
};

export const setUserBlocked = async ({ userId, blocked, reason = '', adminId = null }) => {
  assertObjectId(userId, 'userId');
  const isBlocked = parseBooleanFlag(blocked, 'blocked');
  const trimmedReason = String(reason || '').trim().slice(0, 500);
  if (isBlocked && !trimmedReason) {
    throw new ApiError(400, 'A reason is required to block a user');
  }

  // `active` is the flag the auth middleware and the existing admin toggle
  // use. isActive is left alone: it belongs to the account-deletion flow.
  const update = isBlocked
    ? { active: false, blockReason: trimmedReason, blockedAt: new Date(), blockedBy: adminId || null }
    : { active: true, blockReason: '', blockedAt: null, blockedBy: null };

  const user = await User.findOneAndUpdate(
    { _id: userId, deletedAt: null },
    { $set: update },
    { returnDocument: 'after' },
  ).select(MODERATION_SELECT);

  if (!user) throw new ApiError(404, 'User not found');

  if (isBlocked) {
    // An open app learns at once; the next API call would 401 anyway.
    emitToUserRoom(userId, 'account:blocked', { reason: trimmedReason });
  }

  return serializeUserModeration(user);
};
