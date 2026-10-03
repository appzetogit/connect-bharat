import crypto from 'node:crypto';
import { env } from '../../../../config/env.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { comparePassword, hashPassword } from '../../services/passwordService.js';
import { sendOtpSms } from '../../services/smsService.js';
import { signAccessToken } from '../../services/tokenService.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateAdmin } from '../models/CorporateAdmin.js';
import { normalizeIndianPhone } from './corporatePolicyEngine.js';

/// Corporate panel sign-in: email + password, or phone OTP. Both issue the
/// same JWT as every other role (tokenService), with role `corporate_admin`.

export const CORPORATE_ADMIN_ROLE = 'corporate_admin';
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;

const hashOtp = (otp) => crypto.createHash('sha256').update(`${env.jwtSecret}:${otp}`).digest('hex');
const isTruthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

export const assertPasswordStrength = (password) => {
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
};

export const hashCorporatePassword = (password) => hashPassword(String(password));

export const serializeCorporateAdmin = (admin) => ({
  id: String(admin._id),
  corporateId: String(admin.corporateId),
  name: admin.name,
  email: admin.email,
  phone: admin.phone,
  role: admin.role,
  departmentIds: (admin.departmentIds || []).map(String),
  active: admin.active !== false,
  lastLoginAt: admin.lastLoginAt || null,
});

export const serializeCorporateSummary = (corporate) =>
  corporate
    ? {
        id: String(corporate._id),
        name: corporate.name,
        code: corporate.code,
        status: corporate.status,
        rejectionReason: corporate.rejectionReason,
        suspendedReason: corporate.suspendedReason,
        creditLimit: corporate.creditLimit,
        currentOutstanding: corporate.currentOutstanding,
        paymentTermsDays: corporate.paymentTermsDays,
        discount: corporate.discount,
      }
    : null;

const issueSession = async (admin) => {
  admin.lastLoginAt = new Date();
  await admin.save();
  const corporate = await Corporate.findById(admin.corporateId).lean();
  return {
    token: signAccessToken({ sub: String(admin._id), role: CORPORATE_ADMIN_ROLE }),
    role: CORPORATE_ADMIN_ROLE,
    admin: serializeCorporateAdmin(admin),
    corporate: serializeCorporateSummary(corporate),
  };
};

/// Login works for a company still awaiting approval, so the panel can show
/// its status; the corporate middleware limits what a pending company can do.
const assertCanLogin = async (admin) => {
  if (!admin || admin.active === false) throw new ApiError(401, 'Invalid credentials');
  const corporate = await Corporate.findById(admin.corporateId).select('status').lean();
  if (!corporate) throw new ApiError(401, 'Invalid credentials');
  if (corporate.status === 'rejected') throw new ApiError(403, 'This company registration was rejected');
};

export const loginWithPassword = async ({ email, password }) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) throw new ApiError(400, 'email and password are required');
  const admin = await CorporateAdmin.findOne({ email: normalizedEmail }).select('+passwordHash');
  if (!admin?.passwordHash || !(await comparePassword(String(password), admin.passwordHash))) {
    throw new ApiError(401, 'Invalid credentials');
  }
  await assertCanLogin(admin);
  return issueSession(admin);
};

const resolveOtpForPhone = () => {
  // Same convention as the rider and driver logins: with USE_DEFAULT_OTP on,
  // no SMS goes out and the static code (or 1234) is accepted.
  if (isTruthy(env.sms?.useDefaultOtp)) return { otp: String(env.sms?.staticOtpCode || '1234'), debug: true };
  return { otp: String(crypto.randomInt(1000, 10000)), debug: false };
};

export const sendLoginOtp = async ({ phone }) => {
  const digits = normalizeIndianPhone(phone);
  if (!/^\d{10}$/.test(digits)) throw new ApiError(400, 'A valid 10-digit phone number is required');
  const admin = await CorporateAdmin.findOne({ phone: digits, active: true });
  // Same answer whether or not the number is registered, so the endpoint
  // cannot be used to discover which numbers have panel access.
  if (!admin) return { sent: true };

  const { otp, debug } = resolveOtpForPhone();
  admin.loginOtp = { hash: hashOtp(otp), expiresAt: new Date(Date.now() + OTP_TTL_MS), attempts: 0 };
  await admin.save();
  if (!debug) await sendOtpSms({ phone: digits, otp, purpose: 'corporate login' });
  return { sent: true };
};

export const verifyLoginOtp = async ({ phone, otp }) => {
  const digits = normalizeIndianPhone(phone);
  const admin = await CorporateAdmin.findOne({ phone: digits, active: true }).select('+loginOtp.hash');
  if (!admin?.loginOtp?.hash || !admin.loginOtp.expiresAt || admin.loginOtp.expiresAt < new Date()) {
    throw new ApiError(401, 'OTP expired or not requested');
  }
  if ((admin.loginOtp.attempts || 0) >= MAX_OTP_ATTEMPTS) throw new ApiError(429, 'Too many attempts. Request a new OTP.');
  if (admin.loginOtp.hash !== hashOtp(String(otp || '').trim())) {
    admin.loginOtp.attempts = (admin.loginOtp.attempts || 0) + 1;
    await admin.save();
    throw new ApiError(401, 'Invalid OTP');
  }
  admin.loginOtp = { hash: '', expiresAt: null, attempts: 0 };
  await assertCanLogin(admin);
  return issueSession(admin);
};

export const changeCorporatePassword = async ({ adminId, currentPassword, newPassword }) => {
  assertPasswordStrength(newPassword);
  const admin = await CorporateAdmin.findById(adminId).select('+passwordHash');
  if (!admin) throw new ApiError(404, 'Account not found');
  // An account created without a password (admin-created, OTP-only) may set
  // one without knowing a current one.
  if (admin.passwordHash && !(await comparePassword(String(currentPassword || ''), admin.passwordHash))) {
    throw new ApiError(400, 'Current password is incorrect');
  }
  admin.passwordHash = await hashCorporatePassword(newPassword);
  await admin.save();
  return { updated: true };
};
