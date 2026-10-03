import crypto from 'node:crypto';
import { env } from '../../../../config/env.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { resolveDemoOtpForPhone } from '../../services/demoLoginService.js';
import { comparePassword } from '../../services/passwordService.js';
import { sendOtpSms } from '../../services/smsService.js';
import { signAccessToken } from '../../services/tokenService.js';
import { Hub } from '../models/Hub.js';
import { HubLoginSession } from '../models/HubLoginSession.js';
import { HubStaff } from '../models/HubStaff.js';

/// Hub panel sign-in: phone OTP, or email/phone + password.
///
/// Follows driver/services/loginOtpService.js (which serves the rental
/// service-centre staff) rather than extending it, so a change to hub login
/// can never break driver or service-centre login. Both paths issue the
/// same JWT the rest of the API uses, with role `hub_manager`.

export const HUB_JWT_ROLE = 'hub_manager';
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
};
const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');
const isTruthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

/// Same static-OTP rules as the driver portal: the env default-OTP switch,
/// the single static pair, and the app-store demo numbers.
const resolveOtp = (phone) => {
  const staticCode = String(env.sms?.staticOtpCode || '').trim();
  if (isTruthy(env.sms?.useDefaultOtp) && staticCode) return { otp: staticCode, isStatic: true };
  if (staticCode && normalizePhone(env.sms?.staticOtpPhone) === phone) return { otp: staticCode, isStatic: true };
  const demo = resolveDemoOtpForPhone(phone);
  if (demo) return { otp: demo, isStatic: true };
  return { otp: String(crypto.randomInt(1000, 10000)), isStatic: false };
};

export const serializeHubStaff = (staff, hub = null) => ({
  id: String(staff._id),
  name: staff.name,
  phone: staff.phone,
  email: staff.email || '',
  role: staff.role,
  active: staff.active !== false,
  hubId: String(staff.hubId),
  hub: hub ? { id: String(hub._id), code: hub.code, name: hub.name, address: hub.address || '' } : undefined,
  lastLoginAt: staff.lastLoginAt || null,
});

const issueSession = async (staff) => {
  const hub = await Hub.findById(staff.hubId).lean();
  if (!hub) throw new ApiError(403, 'Your hub no longer exists');
  if (hub.status !== 'active') throw new ApiError(403, 'Your hub is inactive');
  await HubStaff.updateOne({ _id: staff._id }, { $set: { lastLoginAt: new Date() } });
  return {
    token: signAccessToken({ sub: String(staff._id), role: HUB_JWT_ROLE }),
    role: HUB_JWT_ROLE,
    staff: serializeHubStaff(staff, hub),
  };
};

const findActiveStaffByPhone = async (phone) => {
  const staff = await HubStaff.findOne({ phone: { $in: [phone, `91${phone}`, `+91${phone}`] } });
  if (!staff) throw new ApiError(404, 'No hub staff account for this number');
  if (staff.active === false) throw new ApiError(403, 'Hub staff account is inactive');
  return staff;
};

export const startHubOtpLogin = async ({ phone }) => {
  const normalized = normalizePhone(phone);
  if (!/^\d{10}$/.test(normalized)) throw new ApiError(400, 'A valid 10-digit mobile number is required');
  const staff = await findActiveStaffByPhone(normalized);
  const { otp, isStatic } = resolveOtp(normalized);
  await HubLoginSession.findOneAndUpdate(
    { phone: normalized },
    { phone: normalized, staffId: staff._id, otpHash: hashOtp(otp), attempts: 0, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    { upsert: true, setDefaultsOnInsert: true },
  );
  const sms = isStatic ? { mode: 'static' } : await sendOtpSms({ phone: normalized, otp, purpose: 'hub login OTP' });
  return {
    phone: normalized,
    status: 'otp_sent',
    mode: sms.mode,
    debugOtp: process.env.NODE_ENV !== 'production' ? otp : null,
  };
};

export const verifyHubOtpLogin = async ({ phone, otp }) => {
  const normalized = normalizePhone(phone);
  const session = await HubLoginSession.findOne({ phone: normalized }).select('+otpHash');
  if (!session) throw new ApiError(404, 'Login session not found; request a new OTP');
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await HubLoginSession.deleteOne({ _id: session._id });
    throw new ApiError(410, 'OTP has expired');
  }
  if (session.attempts >= MAX_OTP_ATTEMPTS) throw new ApiError(429, 'Too many attempts; request a new OTP');
  if (!/^\d{4}$/.test(String(otp || '').trim())) throw new ApiError(400, 'A valid 4-digit OTP is required');
  if (session.otpHash !== hashOtp(String(otp).trim())) {
    await HubLoginSession.updateOne({ _id: session._id }, { $inc: { attempts: 1 } });
    throw new ApiError(401, 'Invalid OTP');
  }
  await HubLoginSession.deleteOne({ _id: session._id });
  const staff = await HubStaff.findById(session.staffId);
  if (!staff || staff.active === false) throw new ApiError(403, 'Hub staff account is inactive');
  return issueSession(staff);
};

export const passwordHubLogin = async ({ identifier, phone, email, password }) => {
  const id = String(identifier || email || phone || '').trim().toLowerCase();
  if (!id || !password) throw new ApiError(400, 'Phone or email and password are required');
  const normalizedPhone = normalizePhone(id);
  const staff = await HubStaff.findOne(
    /^\d{10}$/.test(normalizedPhone) ? { phone: { $in: [normalizedPhone, `91${normalizedPhone}`, `+91${normalizedPhone}`] } } : { email: id },
  ).select('+passwordHash');
  // One message for every failure, so the endpoint does not reveal which
  // phone numbers or emails have accounts.
  if (!staff?.passwordHash || !(await comparePassword(String(password), staff.passwordHash))) {
    throw new ApiError(401, 'Invalid credentials');
  }
  if (staff.active === false) throw new ApiError(403, 'Hub staff account is inactive');
  return issueSession(staff);
};
